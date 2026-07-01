import * as vscode from "vscode";
import * as path from "path";
import {
  getWriterlyFileGlob,
  isWriterlyFilePath,
} from "./WriterlyFileExtensions";
import {
  discoverWriterlyContainers,
  isPathUnderDirectory,
} from "./WriterlyDocumentTrees";

const DOCUMENT_TREE_SCHEME = "writerly-document-tree";
const OPEN_TREE_FILE_COMMAND = "writerly.openDocumentTreeFile";
const SET_TREE_VIEW_MODE_COMMAND = "writerly.setDocumentTreeViewMode";
const NAVIGATE_TREE_UP_COMMAND = "writerly.navigateDocumentTreeUp";
const NAVIGATE_TREE_DOWN_COMMAND = "writerly.navigateDocumentTreeDown";
const PARENT_FILE_SUFFIX = "__parent.wly";
const ASSEMBLY_INDENT_WIDTH = 4;
const SHOW_HASH_FILES_LABEL = "Show '#'-files";
const HIDE_HASH_FILES_LABEL = "Hide '#' files";
const DECORATION_REFRESH_MAX_ATTEMPTS = 5;

type TreeViewMode = "active" | "all";
type RootDirectoryStatus = "ok" | "missing" | "notRoot";

type RootDisplay = {
  rootDir: string;
};

type RelativeWriterlyPath = {
  uri: vscode.Uri;
  relativePath: string;
};

type DirectoryFile = {
  name: string;
  uri: vscode.Uri;
};

type DirectoryNode = {
  name: string;
  files: DirectoryFile[];
  directories: Map<string, DirectoryNode>;
};

type DisplayEntry = {
  name: string;
  file?: DirectoryFile;
  directory?: DirectoryNode;
};

type DisplayFile = {
  uri: vscode.Uri;
  fileName: string;
  dirPath: string;
  indentation: number;
};

type LinkTarget = {
  line: number;
  startCharacter: number;
  endCharacter: number;
  uri: vscode.Uri;
  sourceUri?: vscode.Uri;
  isCommand?: boolean;
};

type FileLineTarget = {
  line: number;
  uri: vscode.Uri;
};

type ViewModeControlTarget = {
  line: number;
  startCharacter: number;
  endCharacter: number;
  enabled: boolean;
};

type TreeDocument = {
  text: string;
  links: LinkTarget[];
  fileLines: FileLineTarget[];
  viewModeControl: ViewModeControlTarget | undefined;
  currentLine: number | undefined;
  mutedLines: number[];
};

type InspectorSession = {
  anchorFsPath: string;
  currentOpenFsPath: string;
  rootDir: string | undefined;
  viewMode: TreeViewMode;
  originViewColumn: vscode.ViewColumn | undefined;
  uri: vscode.Uri;
};

export class WriterlyDocumentTreeInspector
  implements vscode.TextDocumentContentProvider, vscode.DocumentLinkProvider
{
  private readonly statusBarItem: vscode.StatusBarItem;
  private readonly currentFileLineDecoration: vscode.TextEditorDecorationType;
  private readonly mutedLineDecoration: vscode.TextEditorDecorationType;
  private readonly onDidChangeEmitter =
    new vscode.EventEmitter<vscode.Uri>();
  public readonly onDidChange = this.onDidChangeEmitter.event;
  private readonly documents = new Map<string, TreeDocument>();
  private readonly sessions = new Map<string, InspectorSession>();
  private documentVersion = 0;
  private refreshTimeout: NodeJS.Timeout | undefined;
  private decorationRefreshTimeout: NodeJS.Timeout | undefined;
  private suppressTreeSelectionUntil = 0;

  constructor(context: vscode.ExtensionContext) {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      20,
    );
    this.statusBarItem.command = "writerly.inspectDocumentTree";
    this.statusBarItem.text = "$(list-tree) Writerly Tree";
    this.statusBarItem.tooltip = "Inspect Writerly document tree";
    this.currentFileLineDecoration =
      vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        backgroundColor: new vscode.ThemeColor(
          "editor.findMatchHighlightBackground",
        ),
      });
    this.mutedLineDecoration =
      vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        color: new vscode.ThemeColor("disabledForeground"),
      });

    const watcher = vscode.workspace.createFileSystemWatcher("**/*");
    const refresh = () => this.scheduleRefresh();

    context.subscriptions.push(
      this.statusBarItem,
      this.currentFileLineDecoration,
      this.mutedLineDecoration,
      this.onDidChangeEmitter,
      watcher,
      vscode.workspace.registerTextDocumentContentProvider(
        DOCUMENT_TREE_SCHEME,
        this,
      ),
      vscode.languages.registerDocumentLinkProvider(
        { scheme: DOCUMENT_TREE_SCHEME },
        this,
      ),
      vscode.commands.registerCommand("writerly.inspectDocumentTree", () =>
        this.inspectActiveDocumentTree(),
      ),
      vscode.commands.registerCommand(
        OPEN_TREE_FILE_COMMAND,
        (fsPath: string, sourceUriString: string) =>
          this.openDocumentTreeFile(fsPath, sourceUriString),
      ),
      vscode.commands.registerCommand(
        SET_TREE_VIEW_MODE_COMMAND,
        (sourceUriString: string) =>
          this.toggleDocumentTreeViewMode(sourceUriString),
      ),
      vscode.commands.registerCommand(NAVIGATE_TREE_UP_COMMAND, () =>
        this.navigateDocumentTree(-1),
      ),
      vscode.commands.registerCommand(NAVIGATE_TREE_DOWN_COMMAND, () =>
        this.navigateDocumentTree(1),
      ),
      vscode.window.onDidChangeActiveTextEditor((editor) =>
        this.handleActiveTextEditorChange(editor),
      ),
      vscode.window.onDidChangeVisibleTextEditors(() =>
        this.scheduleTreeDocumentDecorations(),
      ),
      vscode.window.onDidChangeTextEditorSelection((event) =>
        this.handleTreeEditorSelectionChange(event),
      ),
      vscode.workspace.onDidOpenTextDocument(() =>
        this.updateStatusBarVisibility(),
      ),
    );
    watcher.onDidCreate(refresh, undefined, context.subscriptions);
    watcher.onDidChange(refresh, undefined, context.subscriptions);
    watcher.onDidDelete(refresh, undefined, context.subscriptions);

    this.updateStatusBarVisibility();
  }

  public reset(): void {
    this.updateStatusBarVisibility();
    this.scheduleRefresh();
  }

  public provideTextDocumentContent(uri: vscode.Uri): string {
    return this.documents.get(this.getUriKey(uri))?.text ?? "";
  }

  public provideDocumentLinks(
    document: vscode.TextDocument,
    _token: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.DocumentLink[]> {
    const treeDocument = this.documents.get(this.getUriKey(document.uri));
    if (!treeDocument) return [];

    return treeDocument.links.map((link) => {
      const range = new vscode.Range(
        link.line,
        link.startCharacter,
        link.line,
        link.endCharacter,
      );
      const target = link.isCommand
        ? link.uri
        : this.createOpenFileCommandUri(link.uri, link.sourceUri ?? document.uri);
      return new vscode.DocumentLink(range, target);
    });
  }

  private updateStatusBarVisibility(): void {
    const editor = vscode.window.activeTextEditor;
    if (editor && isWriterlyFilePath(editor.document.uri.fsPath)) {
      this.statusBarItem.show();
    } else {
      this.statusBarItem.hide();
    }
  }

  private handleActiveTextEditorChange(
    editor: vscode.TextEditor | undefined,
  ): void {
    this.updateStatusBarVisibility();
    if (
      editor &&
      isWriterlyFilePath(editor.document.uri.fsPath)
    ) {
      for (const session of this.sessions.values()) {
        session.currentOpenFsPath = editor.document.uri.fsPath;
      }
      this.scheduleRefresh();
    }
  }

  private async inspectActiveDocumentTree(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !isWriterlyFilePath(editor.document.uri.fsPath)) {
      void vscode.window.showInformationMessage(
        "Open a Writerly file to inspect its document tree.",
      );
      return;
    }

    const containers = await discoverWriterlyContainers();
    const rootDir = this.getDocumentTreeRoot(
      editor.document.uri.fsPath,
      containers,
    );
    const existingSession = this.findSessionForRoot(rootDir);
    if (existingSession) {
      if (this.isCommentedPath(editor.document.uri.fsPath)) {
        existingSession.viewMode = "all";
      }
      await this.showExistingInspector(existingSession, editor);
      return;
    }

    this.documentVersion++;
    const uri = vscode.Uri.from({
      scheme: DOCUMENT_TREE_SCHEME,
      path: `/tree-${this.documentVersion}.txt`,
    });
    const session: InspectorSession = {
      anchorFsPath: editor.document.uri.fsPath,
      currentOpenFsPath: editor.document.uri.fsPath,
      rootDir,
      viewMode: this.isCommentedPath(editor.document.uri.fsPath)
        ? "all"
        : "active",
      originViewColumn: editor.viewColumn,
      uri,
    };
    this.sessions.set(this.getUriKey(uri), session);
    this.documents.set(
      this.getUriKey(uri),
      await this.createTreeDocumentForAnchor(session),
    );

    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, {
      preview: false,
      viewColumn: vscode.ViewColumn.Beside,
    });
    this.scheduleTreeDocumentDecorations();
    await this.moveTreeCursorToCurrentLine(session.uri);
  }

  private findSessionForRoot(
    rootDir: string | undefined,
  ): InspectorSession | undefined {
    if (!rootDir) return undefined;
    for (const session of this.sessions.values()) {
      if (session.rootDir === rootDir) {
        return session;
      }
    }
    return undefined;
  }

  private async showExistingInspector(
    session: InspectorSession,
    editor: vscode.TextEditor,
  ): Promise<void> {
    const uriString = this.getUriKey(session.uri);
    session.currentOpenFsPath = editor.document.uri.fsPath;
    session.originViewColumn = editor.viewColumn;
    await this.refreshSession(uriString, session);

    const document = await vscode.workspace.openTextDocument(session.uri);
    await vscode.window.showTextDocument(document, {
      preview: false,
      viewColumn: vscode.ViewColumn.Beside,
    });
    this.scheduleTreeDocumentDecorations();
    await this.moveTreeCursorToCurrentLine(session.uri);
  }

  private async openDocumentTreeFile(
    fsPath: string,
    sourceUriString: string,
  ): Promise<void> {
    const session = this.sessions.get(sourceUriString);
    this.suppressTreeSelectionUntil = Date.now() + 500;
    const document = await vscode.workspace.openTextDocument(
      vscode.Uri.file(fsPath),
    );
    const editor = await vscode.window.showTextDocument(document, {
      viewColumn: session?.originViewColumn,
      preview: false,
    });
    if (session) {
      session.currentOpenFsPath = fsPath;
      session.originViewColumn = editor.viewColumn;
      await this.refreshSession(sourceUriString, session);
    }
  }

  private handleTreeEditorSelectionChange(
    event: vscode.TextEditorSelectionChangeEvent,
  ): void {
    if (Date.now() < this.suppressTreeSelectionUntil) return;
    if (event.kind !== vscode.TextEditorSelectionChangeKind.Mouse) return;
    if (event.textEditor.document.uri.scheme !== DOCUMENT_TREE_SCHEME) return;

    const sourceUriString = this.getUriKey(event.textEditor.document.uri);
    const session = this.sessions.get(sourceUriString);
    const treeDocument = this.documents.get(sourceUriString);
    if (!session || !treeDocument || treeDocument.fileLines.length === 0) {
      return;
    }

    const clickedLine = event.selections[0]?.active.line;
    const clickedCharacter = event.selections[0]?.active.character;
    if (clickedLine === undefined) return;
    if (
      clickedCharacter !== undefined &&
      this.isInsideEnabledViewModeControl(
        treeDocument,
        clickedLine,
        clickedCharacter,
      )
    ) {
      void this.toggleDocumentTreeViewMode(sourceUriString);
      return;
    }

    const fileLine = this.getFileLineForClickedLine(
      treeDocument,
      clickedLine,
    );
    if (!fileLine) return;

    void this.openDocumentTreeFileInBrowserMode(
      fileLine.uri,
      event.textEditor.document.uri,
      session,
    );
  }

  private isInsideEnabledViewModeControl(
    treeDocument: TreeDocument,
    clickedLine: number,
    clickedCharacter: number,
  ): boolean {
    const control = treeDocument.viewModeControl;
    return (
      control !== undefined &&
      control.enabled &&
      clickedLine === control.line &&
      clickedCharacter >= control.startCharacter &&
      clickedCharacter < control.endCharacter
    );
  }

  private async navigateDocumentTree(direction: -1 | 1): Promise<void> {
    const treeEditor = vscode.window.activeTextEditor;
    if (!treeEditor || treeEditor.document.uri.scheme !== DOCUMENT_TREE_SCHEME) {
      return;
    }

    const sourceUriString = this.getUriKey(treeEditor.document.uri);
    const session = this.sessions.get(sourceUriString);
    const treeDocument = this.documents.get(sourceUriString);
    if (!session || !treeDocument || treeDocument.fileLines.length === 0) {
      return;
    }

    const currentLine = treeDocument.currentLine;
    const nextFileLine =
      currentLine === undefined
        ? direction > 0
          ? treeDocument.fileLines[0]
          : treeDocument.fileLines[treeDocument.fileLines.length - 1]
        : direction > 0
          ? treeDocument.fileLines.find((fileLine) => fileLine.line > currentLine)
          : [...treeDocument.fileLines]
              .reverse()
              .find((fileLine) => fileLine.line < currentLine);
    if (!nextFileLine) return;

    await this.openDocumentTreeFileInBrowserMode(
      nextFileLine.uri,
      treeEditor.document.uri,
      session,
    );
  }

  private async openDocumentTreeFileInBrowserMode(
    uri: vscode.Uri,
    sourceUri: vscode.Uri,
    session: InspectorSession,
  ): Promise<void> {
    const sourceUriString = this.getUriKey(sourceUri);
    const previousOpenFsPath = session.currentOpenFsPath;
    session.currentOpenFsPath = uri.fsPath;
    this.updateTreeDocumentCurrentLine(sourceUriString, uri.fsPath);
    this.scheduleTreeDocumentDecorations();
    await this.moveTreeCursorToCurrentLine(sourceUri);

    try {
      const document = await vscode.workspace.openTextDocument(uri);
      const openedEditor = await vscode.window.showTextDocument(document, {
        viewColumn: session.originViewColumn,
        preview: true,
        preserveFocus: true,
      });
      session.originViewColumn = openedEditor.viewColumn;
    } catch (error) {
      session.currentOpenFsPath = previousOpenFsPath;
      this.updateTreeDocumentCurrentLine(sourceUriString, previousOpenFsPath);
      this.scheduleTreeDocumentDecorations();
      await this.moveTreeCursorToCurrentLine(sourceUri);
      void vscode.window.showErrorMessage(
        `Could not open Writerly tree file: ${uri.fsPath}`,
      );
    }
  }

  private updateTreeDocumentCurrentLine(
    sourceUriString: string,
    fsPath: string,
  ): void {
    const treeDocument = this.documents.get(sourceUriString);
    if (!treeDocument) return;

    const currentFileLine = treeDocument.fileLines.find(
      (fileLine) => fileLine.uri.fsPath === fsPath,
    );
    treeDocument.currentLine = currentFileLine?.line;
  }

  private getFileLineForClickedLine(
    treeDocument: TreeDocument,
    clickedLine: number,
  ): FileLineTarget | undefined {
    const firstFileLine = treeDocument.fileLines[0];
    const lastFileLine =
      treeDocument.fileLines[treeDocument.fileLines.length - 1];
    if (!firstFileLine || !lastFileLine) return undefined;
    if (clickedLine <= firstFileLine.line) return firstFileLine;
    if (clickedLine >= lastFileLine.line) return lastFileLine;

    return treeDocument.fileLines.find(
      (fileLine) => fileLine.line === clickedLine,
    );
  }

  private async moveTreeCursorToCurrentLine(uri: vscode.Uri): Promise<void> {
    const treeEditor = vscode.window.visibleTextEditors.find(
      (editor) => editor.document.uri.toString() === uri.toString(),
    );
    const treeDocument = this.documents.get(this.getUriKey(uri));
    const currentLine = treeDocument?.currentLine;
    if (!treeEditor || currentLine === undefined) return;

    const position = new vscode.Position(currentLine, 0);
    treeEditor.selection = new vscode.Selection(position, position);
    treeEditor.revealRange(
      new vscode.Range(position, position),
      vscode.TextEditorRevealType.InCenterIfOutsideViewport,
    );
  }

  private createOpenFileCommandUri(
    uri: vscode.Uri,
    sourceUri: vscode.Uri,
  ): vscode.Uri {
    const args = encodeURIComponent(
      JSON.stringify([uri.fsPath, this.getUriKey(sourceUri)]),
    );
    return vscode.Uri.parse(`command:${OPEN_TREE_FILE_COMMAND}?${args}`);
  }

  private getUriKey(uri: vscode.Uri): string {
    return uri.toString();
  }

  private async toggleDocumentTreeViewMode(
    sourceUriString: string,
  ): Promise<void> {
    const session = this.sessions.get(sourceUriString);
    if (!session) return;
    const treeDocument = this.documents.get(sourceUriString);
    if (treeDocument?.viewModeControl?.enabled === false) {
      const lastFileLine = treeDocument.fileLines[treeDocument.fileLines.length - 1];
      if (lastFileLine) {
        await this.openDocumentTreeFileInBrowserMode(
          lastFileLine.uri,
          session.uri,
          session,
        );
      }
      return;
    }
    session.viewMode = session.viewMode === "all" ? "active" : "all";
    await this.refreshSession(sourceUriString, session);
    await this.focusSessionOriginEditor(session);
  }

  private async focusSessionOriginEditor(
    session: InspectorSession,
  ): Promise<void> {
    const visibleEditor = vscode.window.visibleTextEditors.find(
      (editor) => editor.document.uri.fsPath === session.currentOpenFsPath,
    );
    if (!visibleEditor) return;

    await vscode.window.showTextDocument(visibleEditor.document, {
      viewColumn: session.originViewColumn ?? visibleEditor.viewColumn,
      preview: false,
    });
  }

  private scheduleRefresh(): void {
    if (this.sessions.size === 0) return;
    if (this.refreshTimeout) {
      clearTimeout(this.refreshTimeout);
    }
    this.refreshTimeout = setTimeout(() => {
      void this.refreshAllDocuments();
    }, 150);
  }

  private async refreshAllDocuments(): Promise<void> {
    for (const [uriString, session] of this.sessions) {
      await this.refreshSession(uriString, session);
    }
  }

  private async refreshSession(
    uriString: string,
    session: InspectorSession,
  ): Promise<void> {
    this.documents.set(
      uriString,
      await this.createTreeDocumentForAnchor(session),
    );
    this.onDidChangeEmitter.fire(session.uri);
    this.scheduleTreeDocumentDecorations();
  }

  private scheduleTreeDocumentDecorations(attempt = 0): void {
    if (this.decorationRefreshTimeout) {
      clearTimeout(this.decorationRefreshTimeout);
    }
    this.decorationRefreshTimeout = setTimeout(() => {
      const applied = this.applyTreeDocumentDecorations();
      if (!applied && attempt < DECORATION_REFRESH_MAX_ATTEMPTS) {
        this.scheduleTreeDocumentDecorations(attempt + 1);
      }
    }, 0);
  }

  private applyTreeDocumentDecorations(): boolean {
    let allVisibleDocumentsAreCurrent = true;

    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.scheme !== DOCUMENT_TREE_SCHEME) continue;

      const treeDocument = this.documents.get(
        this.getUriKey(editor.document.uri),
      );
      if (!treeDocument) continue;
      if (editor.document.getText() !== treeDocument.text) {
        allVisibleDocumentsAreCurrent = false;
        continue;
      }

      const currentLine = treeDocument?.currentLine;
      const ranges =
        currentLine === undefined
          ? []
          : [
              new vscode.Range(
                currentLine,
                0,
                currentLine,
                0,
              ),
            ];
      editor.setDecorations(this.currentFileLineDecoration, ranges);
      editor.setDecorations(
        this.mutedLineDecoration,
        (treeDocument?.mutedLines ?? []).map(
          (line) =>
            new vscode.Range(line, 0, line, 0),
        ),
      );
    }

    return allVisibleDocumentsAreCurrent;
  }

  private async createTreeDocumentForAnchor(
    session: InspectorSession,
  ): Promise<TreeDocument> {
    const rootDir = session.rootDir;
    if (!rootDir) {
      return {
        text: `Inspector abandoned: no Writerly root directory was found for:\n\n${session.anchorFsPath}`,
        links: [],
        fileLines: [],
        viewModeControl: undefined,
        currentLine: undefined,
        mutedLines: [],
      };
    }

    const containers = await discoverWriterlyContainers();
    const rootStatus = await this.getRootDirectoryStatus(rootDir, containers);
    if (rootStatus === "missing") {
      return {
        text: `Inspector abandoned: root directory no longer exists.\n\n${rootDir}`,
        links: [],
        fileLines: [],
        viewModeControl: undefined,
        currentLine: undefined,
        mutedLines: [],
      };
    }
    if (rootStatus === "notRoot") {
      return {
        text: `Inspector abandoned: directory is no longer a topmost Writerly root.\n\n${rootDir}`,
        links: [],
        fileLines: [],
        viewModeControl: undefined,
        currentLine: undefined,
        mutedLines: [],
      };
    }

    const files = await this.getDocumentTreeFilesForRoot(rootDir);

    return this.createTreeDocument(
      session.currentOpenFsPath,
      files,
      { rootDir },
      session.viewMode,
      session.uri,
    );
  }

  private async getRootDirectoryStatus(
    rootDir: string,
    containers: readonly string[],
  ): Promise<RootDirectoryStatus> {
    if (!(await this.directoryExists(rootDir))) {
      return "missing";
    }

    const isTopmostRoot =
      containers.includes(rootDir) &&
      !containers.some(
        (candidateParent) =>
          candidateParent !== rootDir &&
          isPathUnderDirectory(rootDir, candidateParent),
      );
    return isTopmostRoot ? "ok" : "notRoot";
  }

  private async directoryExists(fsPath: string): Promise<boolean> {
    try {
      const stat = await vscode.workspace.fs.stat(vscode.Uri.file(fsPath));
      return stat.type === vscode.FileType.Directory;
    } catch {
      return false;
    }
  }

  private async getDocumentTreeFilesForRoot(
    rootDir: string,
  ): Promise<vscode.Uri[]> {
    const fileGlob = getWriterlyFileGlob();
    if (!fileGlob) return [];

    const uris = await vscode.workspace.findFiles(fileGlob);
    return uris
      .filter(
        (uri) =>
          isWriterlyFilePath(uri.fsPath) &&
          isPathUnderDirectory(uri.fsPath, rootDir),
      )
      .sort((a, b) =>
        this.getRelativeWorkspacePath(a.fsPath).localeCompare(
          this.getRelativeWorkspacePath(b.fsPath),
        ),
      );
  }

  private createTreeDocument(
    currentFsPath: string,
    files: readonly vscode.Uri[],
    root: RootDisplay | undefined,
    viewMode: TreeViewMode,
    sourceUri: vscode.Uri,
  ): TreeDocument {
    const lines: string[] = [];
    const links: LinkTarget[] = [];
    const fileLines: FileLineTarget[] = [];
    const mutedLines: number[] = [];
    let currentLine: number | undefined;
    const hashFileCount = files.filter((uri) =>
      this.isCommentedPath(uri.fsPath),
    ).length;

    const assemblyDirectory = root?.rootDir ?? path.dirname(currentFsPath);
    lines.push(`Assembly directory: ${assemblyDirectory}`);

    lines.push("");
    currentLine = this.appendOrderedFileLines(
      lines,
      files,
      currentFsPath,
      root,
      viewMode,
      links,
      fileLines,
      mutedLines,
      sourceUri,
    );
    lines.push("");
    const viewModeControl = this.appendViewModeControl(
      lines,
      links,
      viewMode,
      hashFileCount,
      mutedLines,
      sourceUri,
    );

    return {
      text: lines.join("\n"),
      links,
      fileLines,
      viewModeControl,
      currentLine,
      mutedLines,
    };
  }

  private appendOrderedFileLines(
    lines: string[],
    files: readonly vscode.Uri[],
    currentFsPath: string,
    root: RootDisplay | undefined,
    viewMode: TreeViewMode,
    links: LinkTarget[],
    fileLines: FileLineTarget[],
    mutedLines: number[],
    sourceUri: vscode.Uri,
  ): number | undefined {
    let currentLine: number | undefined;

    if (!root) {
      for (const uri of files) {
        const line = lines.length;
        const fileName = path.basename(uri.fsPath);
        if (uri.fsPath === currentFsPath) currentLine = line;
        if (this.isCommentedPath(uri.fsPath)) mutedLines.push(line);
        lines.push(
          `${fileName}  ${this.getCommentStatusMarker(uri.fsPath)} `,
        );
        links.push({
          line,
          startCharacter: 0,
          endCharacter: fileName.length,
          uri,
          sourceUri,
        });
        fileLines.push({ line, uri });
      }
      return currentLine;
    }

    const tree = this.fromTerminals(
      this.getDirnameAndRelativePathsForInspector(
        files,
        root.rootDir,
        viewMode,
      ),
    );
    const dirNameEndingInWriterly = this.findDirNameEndingInWriterly(tree);
    if (dirNameEndingInWriterly) {
      lines.push(
        `Error: directory name ends in .wly: ${dirNameEndingInWriterly}`,
      );
      return undefined;
    }

    const displayFiles = this.inputLinesForDirtreeDisplayAtDepth(
      root.rootDir,
      "",
      tree,
      0,
    );
    const fileColumnWidth = Math.max(
      ...displayFiles.map(
        (file) => file.indentation + file.fileName.length,
      ),
      0,
    );

    for (const file of displayFiles) {
      const line = lines.length;
      const indentedFileName = `${" ".repeat(file.indentation)}${file.fileName}`;
      const dirColumn =
        file.dirPath.length > 0 ? file.dirPath : "";
      if (file.uri.fsPath === currentFsPath) currentLine = line;
      if (this.isCommentedPath(file.uri.fsPath)) mutedLines.push(line);
      lines.push(
        `${indentedFileName.padEnd(fileColumnWidth)}  ${this.getCommentStatusMarker(file.uri.fsPath)} ${dirColumn}`,
      );
      links.push({
        line,
        startCharacter: file.indentation,
        endCharacter: file.indentation + file.fileName.length,
        uri: file.uri,
        sourceUri,
      });
      fileLines.push({ line, uri: file.uri });
    }

    return currentLine;
  }

  /*
   * Inspector analogue of writerly.gleam PART 1:
   *
   * get_dirname_and_relative_paths_of_uncommented_wly_in_dir
   *   -> represented here by getDirnameAndRelativePathsForInspector. The
   *      inspector can use a broader policy that retains # paths for display.
   *
   * dt.from_terminals(dirname, paths)
   *   -> represented here by fromTerminals.
   *
   * dt.sort(fn(t1, t2) { compare(drop_suffix(t1.name), drop_suffix(t2.name)) })
   *   -> represented here by sortDirTreeEntriesLikeGleam. The inspector adds a
   *      total ordering for # entries so inactive paths are shown near the
   *      active entry they would shadow or complement.
   *
   * input_lines_for_dirtree_at_depth(dirname, "", tree, 0)
   *   -> represented here by inputLinesForDirtreeDisplayAtDepth. The inspector
   *      emits display rows instead of reading file contents into InputLine.
   */
  private getDirnameAndRelativePathsForInspector(
    files: readonly vscode.Uri[],
    rootDir: string,
    viewMode: TreeViewMode,
  ): RelativeWriterlyPath[] {
    return files
      .filter((uri) => viewMode === "all" || !this.isCommentedPath(uri.fsPath))
      .map((uri) => ({
        uri,
        relativePath: path.relative(rootDir, uri.fsPath),
      }));
  }

  private fromTerminals(
    terminals: readonly RelativeWriterlyPath[],
  ): DirectoryNode {
    const root: DirectoryNode = {
      name: "",
      files: [],
      directories: new Map(),
    };

    for (const terminal of terminals) {
      const parts = terminal.relativePath
        .split(path.sep)
        .filter((part) => part.length > 0);
      let current = root;

      for (let index = 0; index < parts.length; index++) {
        const name = parts[index];
        const isFile = index === parts.length - 1;
        if (isFile) {
          current.files.push({ name, uri: terminal.uri });
          break;
        }

        let child = current.directories.get(name);

        if (!child) {
          child = {
            name,
            files: [],
            directories: new Map(),
          };
          current.directories.set(name, child);
        }

        current = child;
      }
    }

    return root;
  }

  private getCommentStatusMarker(fsPath: string): string {
    return this.isCommentedPath(fsPath) ? "#" : ".";
  }

  private isCommentedPath(fsPath: string): boolean {
    return fsPath.split(path.sep).some((part) => part.startsWith("#"));
  }

  private appendViewModeControl(
    lines: string[],
    links: LinkTarget[],
    viewMode: TreeViewMode,
    hashFileCount: number,
    mutedLines: number[],
    sourceUri: vscode.Uri,
  ): ViewModeControlTarget {
    const line = lines.length;
    const label = viewMode === "all"
      ? HIDE_HASH_FILES_LABEL
      : SHOW_HASH_FILES_LABEL;
    const enabled = hashFileCount > 0;
    lines.push(`${label} (${hashFileCount})`);

    if (!enabled) {
      mutedLines.push(line);
    }

    links.push({
      line,
      startCharacter: 0,
      endCharacter: label.length,
      uri: this.createToggleViewModeCommandUri(sourceUri),
      isCommand: true,
    });

    return {
      line,
      startCharacter: 0,
      endCharacter: label.length,
      enabled,
    };
  }

  private createToggleViewModeCommandUri(
    sourceUri: vscode.Uri,
  ): vscode.Uri {
    const args = encodeURIComponent(
      JSON.stringify([this.getUriKey(sourceUri)]),
    );
    return vscode.Uri.parse(`command:${SET_TREE_VIEW_MODE_COMMAND}?${args}`);
  }

  /*
   * Mirrors writerly.gleam's input_lines_for_dirtree_at_depth. The Gleam
   * function reads each emitted file into InputLine values; this version emits
   * the file metadata needed by the read-only inspector document.
   */
  private inputLinesForDirtreeDisplayAtDepth(
    originalDirname: string,
    acc: string,
    directory: DirectoryNode,
    depth: number,
  ): DisplayFile[] {
    const entries = this.sortDirTreeEntriesLikeGleam(
      this.getDirTreeEntries(directory),
    );
    const parentPrefixes = directory.files
      .map((file) => this.getParentPrefix(file.name))
      .filter((prefix): prefix is string => prefix !== undefined);
    const files: DisplayFile[] = [];

    for (const entry of entries) {
      const entryDepth =
        depth +
        parentPrefixes.filter((prefix) =>
          this.addedDepthApplies(prefix, entry.name),
        ).length;

      if (entry.directory) {
        files.push(
          ...this.inputLinesForDirtreeDisplayAtDepth(
            originalDirname,
            this.dirAndFilenameToPath(acc, entry.name),
            entry.directory,
            entryDepth,
          ),
        );
      } else if (entry.file) {
        files.push({
          uri: entry.file.uri,
          fileName: entry.name,
          dirPath: acc,
          indentation: ASSEMBLY_INDENT_WIDTH * entryDepth,
        });
      }
    }

    return files;
  }

  private findDirNameEndingInWriterly(
    directory: DirectoryNode,
    prefix = "",
  ): string | undefined {
    for (const child of directory.directories.values()) {
      const childPath = prefix ? `${prefix}/${child.name}` : child.name;
      if (child.name.endsWith(".wly")) {
        return childPath;
      }
      const nested = this.findDirNameEndingInWriterly(child, childPath);
      if (nested) return nested;
    }
    return undefined;
  }

  private getDirTreeEntries(directory: DirectoryNode): DisplayEntry[] {
    return [
      ...directory.files.map((file) => ({
        name: file.name,
        file,
      })),
      ...[...directory.directories.values()].map((childDirectory) => ({
        name: childDirectory.name,
        directory: childDirectory,
      })),
    ];
  }

  private sortDirTreeEntriesLikeGleam(
    entries: readonly DisplayEntry[],
  ): DisplayEntry[] {
    return [...entries].sort((a, b) => {
      const aOrder = this.getDirTreeSortKey(a.name);
      const bOrder = this.getDirTreeSortKey(b.name);
      return (
        aOrder.anchor.localeCompare(bOrder.anchor) ||
        aOrder.rank - bOrder.rank ||
        aOrder.name.localeCompare(bOrder.name)
      );
    });
  }

  private getDirTreeSortKey(fileNameOrDirName: string): {
    anchor: string;
    rank: number;
    name: string;
  } {
    if (fileNameOrDirName.startsWith("#")) {
      const uncommentedName = fileNameOrDirName.slice(1);
      return {
        anchor: this.dropParentSuffix(uncommentedName),
        rank: fileNameOrDirName.endsWith(PARENT_FILE_SUFFIX) ? -1 : 0,
        name: fileNameOrDirName,
      };
    }

    return {
      anchor: this.dropParentSuffix(fileNameOrDirName),
      rank: 1,
      name: fileNameOrDirName,
    };
  }

  private dropParentSuffix(name: string): string {
    return name.endsWith(PARENT_FILE_SUFFIX)
      ? name.slice(0, -PARENT_FILE_SUFFIX.length)
      : name;
  }

  private getParentPrefix(fileName: string): string | undefined {
    if (fileName.startsWith("#")) return undefined;
    if (!fileName.endsWith(PARENT_FILE_SUFFIX)) return undefined;
    return fileName.slice(0, -PARENT_FILE_SUFFIX.length);
  }

  private addedDepthApplies(
    activePrefix: string,
    entryName: string,
  ): boolean {
    const inertParentPrefix = this.getInertParentFilePrefix(entryName);
    if (inertParentPrefix !== undefined) {
      return (
        activePrefix.length < inertParentPrefix.length &&
        inertParentPrefix.startsWith(activePrefix)
      );
    }

    const effectiveName = entryName.startsWith("#")
      ? entryName.slice(1)
      : entryName;

    return (
      effectiveName.startsWith(activePrefix) &&
      entryName !== `${activePrefix}${PARENT_FILE_SUFFIX}`
    );
  }

  private dirAndFilenameToPath(dir: string, fileName: string): string {
    return dir ? `${dir}/${fileName}` : fileName;
  }

  private getInertParentFilePrefix(fileName: string): string | undefined {
    if (!fileName.startsWith("#") || !fileName.endsWith(PARENT_FILE_SUFFIX)) {
      return undefined;
    }
    return fileName.slice(1, -PARENT_FILE_SUFFIX.length);
  }

  private getDocumentTreeRoot(
    currentFsPath: string,
    containers: readonly string[],
  ): string | undefined {
    return containers
      .filter((containerPath) => isPathUnderDirectory(currentFsPath, containerPath))
      .sort((a, b) => a.length - b.length)[0];
  }

  private getRelativeWorkspacePath(fullPath: string): string {
    for (const folder of vscode.workspace.workspaceFolders || []) {
      const workspaceRoot = folder.uri.fsPath;
      if (!isPathUnderDirectory(fullPath, workspaceRoot)) continue;

      const relativePath = path.relative(workspaceRoot, fullPath);
      return relativePath
        ? relativePath.split(path.sep).join("/")
        : folder.name;
    }

    return fullPath;
  }
}
