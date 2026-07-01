import * as vscode from "vscode";
import * as path from "path";
import {
  getWriterlyFileGlob,
  isWriterlyFilePath,
} from "./WriterlyFileExtensions";
import {
  discoverWriterlyContainers,
  isInSameWriterlyDocumentTree,
  isPathUnderDirectory,
} from "./WriterlyDocumentTrees";

const DOCUMENT_TREE_SCHEME = "writerly-document-tree";
const OPEN_TREE_FILE_COMMAND = "writerly.openDocumentTreeFile";
const SET_TREE_VIEW_MODE_COMMAND = "writerly.setDocumentTreeViewMode";
const PARENT_FILE_SUFFIX = "__parent.wly";
const ASSEMBLY_INDENT_WIDTH = 4;

type TreeViewMode = "active" | "all";

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

type TreeDocument = {
  text: string;
  links: LinkTarget[];
  currentLine: number | undefined;
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
  private readonly onDidChangeEmitter =
    new vscode.EventEmitter<vscode.Uri>();
  public readonly onDidChange = this.onDidChangeEmitter.event;
  private readonly documents = new Map<string, TreeDocument>();
  private readonly sessions = new Map<string, InspectorSession>();
  private documentVersion = 0;
  private refreshTimeout: NodeJS.Timeout | undefined;

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

    const watcher = vscode.workspace.createFileSystemWatcher("**/*");
    const refresh = () => this.scheduleRefresh();

    context.subscriptions.push(
      this.statusBarItem,
      this.currentFileLineDecoration,
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
        (mode: TreeViewMode, sourceUriString: string) =>
          this.setDocumentTreeViewMode(mode, sourceUriString),
      ),
      vscode.window.onDidChangeActiveTextEditor((editor) =>
        this.handleActiveTextEditorChange(editor),
      ),
      vscode.window.onDidChangeVisibleTextEditors(() =>
        this.applyCurrentFileLineDecorations(),
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
      viewMode: "active",
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
    this.applyCurrentFileLineDecorations();
    await vscode.window.showTextDocument(editor.document, {
      viewColumn: session.originViewColumn,
      preview: false,
    });
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
    this.applyCurrentFileLineDecorations();
    await vscode.window.showTextDocument(editor.document, {
      viewColumn: session.originViewColumn,
      preview: false,
    });
  }

  private async openDocumentTreeFile(
    fsPath: string,
    sourceUriString: string,
  ): Promise<void> {
    const session = this.sessions.get(sourceUriString);
    const document = await vscode.workspace.openTextDocument(
      vscode.Uri.file(fsPath),
    );
    await vscode.window.showTextDocument(document, {
      viewColumn: session?.originViewColumn,
      preview: false,
    });
    if (session) {
      session.currentOpenFsPath = fsPath;
      await this.refreshSession(sourceUriString, session);
    }
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

  private async setDocumentTreeViewMode(
    mode: TreeViewMode,
    sourceUriString: string,
  ): Promise<void> {
    const session = this.sessions.get(sourceUriString);
    if (!session) return;
    session.viewMode = mode;
    await this.refreshSession(sourceUriString, session);
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
    this.applyCurrentFileLineDecorations();
  }

  private applyCurrentFileLineDecorations(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.scheme !== DOCUMENT_TREE_SCHEME) continue;

      const treeDocument = this.documents.get(
        this.getUriKey(editor.document.uri),
      );
      const currentLine = treeDocument?.currentLine;
      const ranges =
        currentLine === undefined
          ? []
          : [
              new vscode.Range(
                currentLine,
                0,
                currentLine,
                Number.MAX_SAFE_INTEGER,
              ),
            ];
      editor.setDecorations(this.currentFileLineDecoration, ranges);
    }
  }

  private async createTreeDocumentForAnchor(
    session: InspectorSession,
  ): Promise<TreeDocument> {
    const anchorFsPath = session.anchorFsPath;
    const exists = await this.fileExists(anchorFsPath);
    if (!exists) {
      return {
        text: `Inspector abandoned: anchor file no longer exists.\n\n${anchorFsPath}`,
        links: [],
        currentLine: undefined,
      };
    }

    const containers = await discoverWriterlyContainers();
    const files = await this.getDocumentTreeFiles(anchorFsPath, containers);
    const root = this.getDocumentTreeRoot(anchorFsPath, containers);
    session.rootDir = root;
    const rootDisplay = root ? { rootDir: root } : undefined;

    return this.createTreeDocument(
      session.currentOpenFsPath,
      files,
      rootDisplay,
      session.viewMode,
      session.uri,
    );
  }

  private async fileExists(fsPath: string): Promise<boolean> {
    try {
      const stat = await vscode.workspace.fs.stat(vscode.Uri.file(fsPath));
      return stat.type === vscode.FileType.File;
    } catch {
      return false;
    }
  }

  private async getDocumentTreeFiles(
    currentFsPath: string,
    containers: readonly string[],
  ): Promise<vscode.Uri[]> {
    const fileGlob = getWriterlyFileGlob();
    if (!fileGlob) return [];

    const uris = await vscode.workspace.findFiles(fileGlob);
    return uris
      .filter(
        (uri) =>
          isWriterlyFilePath(uri.fsPath) &&
          isInSameWriterlyDocumentTree(
            currentFsPath,
            uri.fsPath,
            containers,
          ),
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
    let currentLine: number | undefined;

    if (!root) {
      lines.push(
        `Containing directory: ${this.getRelativeWorkspacePath(
          path.dirname(currentFsPath),
        )}`,
      );
    } else {
      lines.push(
        `Containing directory: ${this.getRelativeWorkspacePath(root.rootDir)}`,
      );
    }

    if (files.some((uri) => this.isCommentedPath(uri.fsPath))) {
      lines.push("");
      this.appendViewModeControl(lines, links, viewMode, sourceUri);
    }
    lines.push("");
    currentLine = this.appendOrderedFileLines(
      lines,
      files,
      currentFsPath,
      root,
      viewMode,
      links,
      sourceUri,
    );

    return {
      text: lines.join("\n"),
      links,
      currentLine,
    };
  }

  private appendOrderedFileLines(
    lines: string[],
    files: readonly vscode.Uri[],
    currentFsPath: string,
    root: RootDisplay | undefined,
    viewMode: TreeViewMode,
    links: LinkTarget[],
    sourceUri: vscode.Uri,
  ): number | undefined {
    let currentLine: number | undefined;

    if (!root) {
      for (const uri of files) {
        const line = lines.length;
        const fileName = path.basename(uri.fsPath);
        if (uri.fsPath === currentFsPath) currentLine = line;
        lines.push(
          `${fileName}  ${this.getCommentStatusMarker(uri.fsPath)} .`,
        );
        links.push({
          line,
          startCharacter: 0,
          endCharacter: fileName.length,
          uri,
          sourceUri,
        });
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
        file.dirPath.length > 0 ? file.dirPath : ".";
      if (file.uri.fsPath === currentFsPath) currentLine = line;
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
    return this.isCommentedPath(fsPath) ? "#" : "✓";
  }

  private isCommentedPath(fsPath: string): boolean {
    return fsPath.split(path.sep).some((part) => part.startsWith("#"));
  }

  private appendViewModeControl(
    lines: string[],
    links: LinkTarget[],
    viewMode: TreeViewMode,
    sourceUri: vscode.Uri,
  ): void {
    const line = lines.length;
    const activeLabel = `${viewMode === "active" ? "✓ " : ""}active only`;
    const allLabel = `${viewMode === "all" ? "✓ " : ""}all`;
    const prefix = "View: ";
    lines.push(`${prefix}${activeLabel} | ${allLabel}`);

    const activeStart =
      prefix.length + (viewMode === "active" ? "✓ ".length : 0);
    const activeLinkText = "active only";
    const allStart = prefix.length + activeLabel.length + 3;
    const allLinkStart = allStart + (viewMode === "all" ? "✓ ".length : 0);
    const allLinkText = "all";
    links.push(
      {
        line,
        startCharacter: activeStart,
        endCharacter: activeStart + activeLinkText.length,
        uri: this.createSetViewModeCommandUri("active", sourceUri),
        isCommand: true,
      },
      {
        line,
        startCharacter: allLinkStart,
        endCharacter: allLinkStart + allLinkText.length,
        uri: this.createSetViewModeCommandUri("all", sourceUri),
        isCommand: true,
      },
    );
  }

  private createSetViewModeCommandUri(
    mode: TreeViewMode,
    sourceUri: vscode.Uri,
  ): vscode.Uri {
    const args = encodeURIComponent(
      JSON.stringify([mode, this.getUriKey(sourceUri)]),
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
