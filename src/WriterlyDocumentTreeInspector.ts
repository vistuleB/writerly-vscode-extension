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
import type { WriterlyDiagnosticStatus } from "./WriterlyLinkProvider";

const DOCUMENT_TREE_SCHEME = "writerly-document-tree";
const TOGGLE_TREE_INSPECTOR_COMMAND = "writerly.toggleDocumentTreeInspector";
const SET_TREE_VIEW_MODE_COMMAND = "writerly.setDocumentTreeViewMode";
const NAVIGATE_TREE_UP_COMMAND = "writerly.navigateDocumentTreeUp";
const NAVIGATE_TREE_DOWN_COMMAND = "writerly.navigateDocumentTreeDown";
const NAVIGATE_TREE_FIRST_COMMAND = "writerly.navigateDocumentTreeFirst";
const NAVIGATE_TREE_LAST_COMMAND = "writerly.navigateDocumentTreeLast";
const NAVIGATE_TREE_PARENT_COMMAND = "writerly.navigateDocumentTreeParent";
const NAVIGATE_TREE_CHILD_COMMAND = "writerly.navigateDocumentTreeChild";
const NAVIGATE_TREE_PREVIOUS_SIBLING_COMMAND =
  "writerly.navigateDocumentTreePreviousSibling";
const NAVIGATE_TREE_NEXT_SIBLING_COMMAND =
  "writerly.navigateDocumentTreeNextSibling";
const FOCUS_TREE_FILE_COMMAND = "writerly.focusDocumentTreeFile";
const FOCUS_TREE_FILE_AND_CLOSE_COMMAND =
  "writerly.focusDocumentTreeFileAndClose";
const PARENT_FILE_SUFFIX = "__parent.wly";
const ASSEMBLY_INDENT_WIDTH = 4;
const SHOW_HASH_FILES_LABEL = "Show '#'-files";
const HIDE_HASH_FILES_LABEL = "Hide '#' files";
const DECORATION_REFRESH_MAX_ATTEMPTS = 20;
const DECORATION_REFRESH_RETRY_DELAY_MS = 25;
const DOCUMENT_TREE_ACTIVE_CONTEXT = "writerlyDocumentTreeActive";

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
};

type FileLineTarget = {
  line: number;
  uri: vscode.Uri;
  indentation: number;
  startCharacter: number;
  endCharacter: number;
};

type ViewModeControlTarget = {
  line: number;
  startCharacter: number;
  endCharacter: number;
  enabled: boolean;
};

type DiagnosticFilenameRange = {
  line: number;
  startCharacter: number;
  endCharacter: number;
};

type TreeDocument = {
  text: string;
  links: LinkTarget[];
  fileLines: FileLineTarget[];
  viewModeControl: ViewModeControlTarget | undefined;
  currentLine: number | undefined;
  currentLineKind: "file" | "viewModeControl" | undefined;
  mutedLines: number[];
  warningFilenameRanges: DiagnosticFilenameRange[];
  errorFilenameRanges: DiagnosticFilenameRange[];
};

type InspectorSession = {
  anchorFsPath: string;
  currentOpenFsPath: string;
  rootDir: string | undefined;
  viewMode: TreeViewMode;
  originViewColumn: vscode.ViewColumn | undefined;
  uri: vscode.Uri;
};

type PendingPreviewOpen = {
  uri: vscode.Uri;
  sourceUri: vscode.Uri;
  session: InspectorSession;
  previousOpenFsPath: string;
};

export class WriterlyDocumentTreeInspector
  implements vscode.TextDocumentContentProvider, vscode.DocumentLinkProvider
{
  private readonly statusBarItem: vscode.StatusBarItem;
  private readonly currentFileLineDecoration: vscode.TextEditorDecorationType;
  private readonly mutedLineDecoration: vscode.TextEditorDecorationType;
  private readonly warningFilenameDecoration: vscode.TextEditorDecorationType;
  private readonly errorFilenameDecoration: vscode.TextEditorDecorationType;
  private readonly onDidChangeEmitter =
    new vscode.EventEmitter<vscode.Uri>();
  public readonly onDidChange = this.onDidChangeEmitter.event;
  private readonly documents = new Map<string, TreeDocument>();
  private readonly sessions = new Map<string, InspectorSession>();
  private documentVersion = 0;
  private refreshTimeout: NodeJS.Timeout | undefined;
  private decorationRefreshTimeout: NodeJS.Timeout | undefined;
  private documentTreeActiveContext = false;
  private readonly activePreviewOpens = new Set<string>();
  private readonly pendingPreviewOpens = new Map<string, PendingPreviewOpen>();

  constructor(
    context: vscode.ExtensionContext,
    private readonly getDiagnosticStatus: (
      fsPath: string,
    ) => WriterlyDiagnosticStatus = () => "none",
  ) {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      20,
    );
    this.statusBarItem.command = TOGGLE_TREE_INSPECTOR_COMMAND;
    this.statusBarItem.text = "$(list-tree) .wly";
    this.statusBarItem.tooltip = "Toggle Writerly document tree";
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
    this.warningFilenameDecoration =
      vscode.window.createTextEditorDecorationType({
        color: new vscode.ThemeColor("editorWarning.foreground"),
      });
    this.errorFilenameDecoration =
      vscode.window.createTextEditorDecorationType({
        color: new vscode.ThemeColor("editorError.foreground"),
      });

    const watcher = vscode.workspace.createFileSystemWatcher("**/*");
    const refresh = () => this.scheduleRefresh();

    context.subscriptions.push(
      this.statusBarItem,
      this.currentFileLineDecoration,
      this.mutedLineDecoration,
      this.warningFilenameDecoration,
      this.errorFilenameDecoration,
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
      vscode.commands.registerCommand(TOGGLE_TREE_INSPECTOR_COMMAND, () =>
        this.toggleActiveDocumentTreeInspector(),
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
      vscode.commands.registerCommand(NAVIGATE_TREE_FIRST_COMMAND, () =>
        this.navigateDocumentTreeEndpoint("first"),
      ),
      vscode.commands.registerCommand(NAVIGATE_TREE_LAST_COMMAND, () =>
        this.navigateDocumentTreeEndpoint("last"),
      ),
      vscode.commands.registerCommand(NAVIGATE_TREE_PARENT_COMMAND, () =>
        this.navigateDocumentTreeParent(),
      ),
      vscode.commands.registerCommand(NAVIGATE_TREE_CHILD_COMMAND, () =>
        this.navigateDocumentTreeChild(),
      ),
      vscode.commands.registerCommand(NAVIGATE_TREE_PREVIOUS_SIBLING_COMMAND, () =>
        this.navigateDocumentTreeSibling(-1),
      ),
      vscode.commands.registerCommand(NAVIGATE_TREE_NEXT_SIBLING_COMMAND, () =>
        this.navigateDocumentTreeSibling(1),
      ),
      vscode.commands.registerCommand(FOCUS_TREE_FILE_COMMAND, () =>
        this.focusDocumentTreeFile(),
      ),
      vscode.commands.registerCommand(FOCUS_TREE_FILE_AND_CLOSE_COMMAND, () =>
        this.focusDocumentTreeFileAndClose(),
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
      vscode.languages.onDidChangeDiagnostics((event) =>
        this.handleDiagnosticsChange(event),
      ),
    );
    watcher.onDidCreate(refresh, undefined, context.subscriptions);
    watcher.onDidChange(refresh, undefined, context.subscriptions);
    watcher.onDidDelete(refresh, undefined, context.subscriptions);

    this.updateStatusBarVisibility();
  }

  private handleDiagnosticsChange(
    event: vscode.DiagnosticChangeEvent,
  ): void {
    if (event.uris.some((uri) => isWriterlyFilePath(uri.fsPath))) {
      this.scheduleRefresh();
    }
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
      return new vscode.DocumentLink(range, link.uri);
    });
  }

  private updateStatusBarVisibility(): void {
    const editor = vscode.window.activeTextEditor;
    const isDocumentTreeEditor =
      editor?.document.uri.scheme === DOCUMENT_TREE_SCHEME;
    void this.setDocumentTreeActiveContext(
      isDocumentTreeEditor,
    );
    if (
      isDocumentTreeEditor ||
      (editor && isWriterlyFilePath(editor.document.uri.fsPath))
    ) {
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

  private async setDocumentTreeActiveContext(active: boolean): Promise<void> {
    if (this.documentTreeActiveContext === active) return;
    this.documentTreeActiveContext = active;
    await vscode.commands.executeCommand(
      "setContext",
      DOCUMENT_TREE_ACTIVE_CONTEXT,
      active,
    );
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

  private async toggleActiveDocumentTreeInspector(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (editor?.document.uri.scheme === DOCUMENT_TREE_SCHEME) {
      await this.closeDocumentTreeTab(editor.document.uri);
      return;
    }

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
    if (!existingSession) {
      await this.inspectActiveDocumentTree();
      return;
    }

    if (this.isCommentedPath(editor.document.uri.fsPath)) {
      existingSession.viewMode = "all";
    }
    await this.showExistingInspector(existingSession, editor);
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

  private handleTreeEditorSelectionChange(
    event: vscode.TextEditorSelectionChangeEvent,
  ): void {
    if (event.textEditor.document.uri.scheme !== DOCUMENT_TREE_SCHEME) return;

    const clickedLine = event.selections[0]?.active.line;
    const clickedCharacter = event.selections[0]?.active.character;
    const sourceUriString = this.getUriKey(event.textEditor.document.uri);
    const session = this.sessions.get(sourceUriString);
    const treeDocument = this.documents.get(sourceUriString);
    if (!session || !treeDocument || treeDocument.fileLines.length === 0) {
      return;
    }

    if (clickedLine === undefined) return;
    if (event.kind !== vscode.TextEditorSelectionChangeKind.Mouse) return;

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
    const lastFileLine =
      treeDocument.fileLines[treeDocument.fileLines.length - 1];
    if (
      treeDocument.viewModeControl?.enabled &&
      lastFileLine !== undefined &&
      clickedLine > lastFileLine.line
    ) {
      void this.selectDocumentTreeLine(
        event.textEditor.document.uri,
        treeDocument,
        treeDocument.viewModeControl.line,
        "viewModeControl",
      );
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
    if (
      direction < 0 &&
      treeDocument.currentLineKind === "viewModeControl"
    ) {
      const lastFileLine =
        treeDocument.fileLines[treeDocument.fileLines.length - 1];
      await this.selectDocumentTreeLine(
        treeEditor.document.uri,
        treeDocument,
        lastFileLine.line,
        "file",
      );
      return;
    }

    const currentFileLine = this.getCurrentFileLine(treeDocument);
    const nextFileLine =
      currentLine === undefined || currentFileLine === undefined
        ? direction > 0
          ? treeDocument.fileLines[0]
          : treeDocument.fileLines[treeDocument.fileLines.length - 1]
        : treeDocument.fileLines[currentFileLine.index + direction];
    if (!nextFileLine) {
      if (
        direction > 0 &&
        treeDocument.viewModeControl?.enabled &&
        currentLine ===
          treeDocument.fileLines[treeDocument.fileLines.length - 1]?.line
      ) {
        await this.selectDocumentTreeLine(
          treeEditor.document.uri,
          treeDocument,
          treeDocument.viewModeControl.line,
          "viewModeControl",
        );
      }
      return;
    }

    await this.openDocumentTreeFileInBrowserMode(
      nextFileLine.uri,
      treeEditor.document.uri,
      session,
    );
  }

  private async navigateDocumentTreeEndpoint(
    endpoint: "first" | "last",
  ): Promise<void> {
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

    const firstFileLine = treeDocument.fileLines[0];
    const lastFileLine =
      treeDocument.fileLines[treeDocument.fileLines.length - 1];
    if (!firstFileLine || !lastFileLine) return;

    if (endpoint === "first") {
      if (treeDocument.currentLineKind === "viewModeControl") {
        await this.openDocumentTreeFileInBrowserMode(
          lastFileLine.uri,
          treeEditor.document.uri,
          session,
        );
        return;
      }

      await this.openDocumentTreeFileInBrowserMode(
        firstFileLine.uri,
        treeEditor.document.uri,
        session,
      );
      return;
    }

    if (
      treeDocument.viewModeControl?.enabled &&
      treeDocument.currentLine === lastFileLine.line
    ) {
      await this.selectDocumentTreeLine(
        treeEditor.document.uri,
        treeDocument,
        treeDocument.viewModeControl.line,
        "viewModeControl",
      );
      return;
    }

    await this.openDocumentTreeFileInBrowserMode(
      lastFileLine.uri,
      treeEditor.document.uri,
      session,
    );
  }

  private async navigateDocumentTreeParent(): Promise<void> {
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

    const current = this.getCurrentFileLine(treeDocument);
    if (!current) return;

    const parentFileLine =
      this.findNearestActiveParentFileLine(current, treeDocument) ??
      this.findNearestLowerIndentFileLine(current, treeDocument);
    if (!parentFileLine) return;

    await this.openDocumentTreeFileInBrowserMode(
      parentFileLine.uri,
      treeEditor.document.uri,
      session,
    );
  }

  private async navigateDocumentTreeChild(): Promise<void> {
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

    const current = this.getCurrentFileLine(treeDocument);
    if (!current) return;

    const childFileLine = treeDocument.fileLines.find(
      (fileLine) =>
        fileLine.line > current.fileLine.line &&
        fileLine.indentation > current.fileLine.indentation,
    );
    if (!childFileLine) return;

    await this.openDocumentTreeFileInBrowserMode(
      childFileLine.uri,
      treeEditor.document.uri,
      session,
    );
  }

  private async navigateDocumentTreeSibling(direction: -1 | 1): Promise<void> {
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

    const current = this.getCurrentFileLine(treeDocument);
    if (!current) return;

    const siblingFileLine =
      direction > 0
        ? treeDocument.fileLines.find(
            (fileLine) =>
              fileLine.line > current.fileLine.line &&
              fileLine.indentation === current.fileLine.indentation,
          )
        : [...treeDocument.fileLines]
            .reverse()
            .find(
              (fileLine) =>
                fileLine.line < current.fileLine.line &&
                fileLine.indentation === current.fileLine.indentation,
            );
    if (!siblingFileLine) {
      if (
        direction > 0 &&
        this.isFirstLineWithImmediateDeeperNextLine(current, treeDocument)
      ) {
        const nextFileLine = treeDocument.fileLines.find(
          (fileLine) => fileLine.line > current.fileLine.line,
        )!;
        await this.openDocumentTreeFileInBrowserMode(
          nextFileLine.uri,
          treeEditor.document.uri,
          session,
        );
      } else if (
        direction < 0 &&
        this.isImmediateShallowerFirstLine(current.fileLine, treeDocument)
      ) {
        const previousFileLine = [...treeDocument.fileLines]
          .reverse()
          .find((fileLine) => fileLine.line < current.fileLine.line)!;
        await this.openDocumentTreeFileInBrowserMode(
          previousFileLine.uri,
          treeEditor.document.uri,
          session,
        );
      }
      return;
    }

    await this.openDocumentTreeFileInBrowserMode(
      siblingFileLine.uri,
      treeEditor.document.uri,
      session,
    );
  }

  private getCurrentFileLine(
    treeDocument: TreeDocument,
  ): { fileLine: FileLineTarget; index: number } | undefined {
    if (
      treeDocument.currentLine === undefined ||
      treeDocument.currentLineKind !== "file"
    ) {
      return undefined;
    }

    const index = treeDocument.fileLines.findIndex(
      (fileLine) => fileLine.line === treeDocument.currentLine,
    );
    if (index < 0) return undefined;

    return { fileLine: treeDocument.fileLines[index], index };
  }

  private isFirstLineWithImmediateDeeperNextLine(
    current: { fileLine: FileLineTarget; index: number },
    treeDocument: TreeDocument,
  ): boolean {
    if (current.index !== 0) return false;

    const nextFileLine = treeDocument.fileLines.find(
      (fileLine) => fileLine.line > current.fileLine.line,
    );
    return (
      nextFileLine !== undefined &&
      nextFileLine.line === current.fileLine.line + 1 &&
      nextFileLine.indentation > current.fileLine.indentation
    );
  }

  private isImmediateShallowerFirstLine(
    currentFileLine: FileLineTarget,
    treeDocument: TreeDocument,
  ): boolean {
    const previousFileLine = [...treeDocument.fileLines]
      .reverse()
      .find((fileLine) => fileLine.line < currentFileLine.line);
    return (
      previousFileLine !== undefined &&
      previousFileLine === treeDocument.fileLines[0] &&
      previousFileLine.line === currentFileLine.line - 1 &&
      previousFileLine.indentation < currentFileLine.indentation
    );
  }

  private findNearestActiveParentFileLine(
    current: { fileLine: FileLineTarget; index: number },
    treeDocument: TreeDocument,
  ): FileLineTarget | undefined {
    if (this.isActiveParentFileLine(current.fileLine)) return undefined;

    for (let index = current.index - 1; index >= 0; index--) {
      const candidate = treeDocument.fileLines[index];
      if (
        this.isActiveParentFileLine(candidate) &&
        candidate.indentation <= current.fileLine.indentation
      ) {
        return candidate;
      }
    }

    return undefined;
  }

  private findNearestLowerIndentFileLine(
    current: { fileLine: FileLineTarget; index: number },
    treeDocument: TreeDocument,
  ): FileLineTarget | undefined {
    for (let index = current.index - 1; index >= 0; index--) {
      const candidate = treeDocument.fileLines[index];
      if (candidate.indentation < current.fileLine.indentation) {
        return candidate;
      }
    }

    return undefined;
  }

  private isActiveParentFileLine(fileLine: FileLineTarget): boolean {
    const name = path.basename(fileLine.uri.fsPath);
    return name.endsWith(PARENT_FILE_SUFFIX) && !name.startsWith("#");
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
    this.applyCurrentLineDecorations();
    await this.moveTreeCursorToCurrentLine(sourceUri);

    if (this.activePreviewOpens.has(sourceUriString)) {
      this.pendingPreviewOpens.set(sourceUriString, {
        uri,
        sourceUri,
        session,
        previousOpenFsPath,
      });
      return;
    }

    this.activePreviewOpens.add(sourceUriString);
    try {
      let next: PendingPreviewOpen | undefined = {
        uri,
        sourceUri,
        session,
        previousOpenFsPath,
      };
      while (next) {
        await this.openDocumentTreeFilePreview(
          next.uri,
          next.sourceUri,
          next.session,
          next.previousOpenFsPath,
        );
        next = this.pendingPreviewOpens.get(sourceUriString);
        if (next) {
          this.pendingPreviewOpens.delete(sourceUriString);
        }
      }
    } finally {
      this.activePreviewOpens.delete(sourceUriString);
    }
  }

  private async openDocumentTreeFilePreview(
    uri: vscode.Uri,
    sourceUri: vscode.Uri,
    session: InspectorSession,
    previousOpenFsPath: string,
  ): Promise<void> {
    const sourceUriString = this.getUriKey(sourceUri);
    const treeEditor = vscode.window.visibleTextEditors.find(
      (editor) => editor.document.uri.toString() === sourceUri.toString(),
    );
    const treeViewColumn = treeEditor?.viewColumn;
    try {
      const document = await vscode.workspace.openTextDocument(uri);
      const openedEditor = await vscode.window.showTextDocument(document, {
        viewColumn: session.originViewColumn,
        preview: true,
        preserveFocus: true,
      });
      session.originViewColumn = openedEditor.viewColumn;
      const activeEditor = vscode.window.activeTextEditor;
      if (activeEditor?.document.uri.toString() !== sourceUri.toString()) {
        const treeDocument = await vscode.workspace.openTextDocument(sourceUri);
        await vscode.window.showTextDocument(treeDocument, {
          viewColumn: treeViewColumn,
          preview: false,
          preserveFocus: false,
        });
      }
      await this.setDocumentTreeActiveContext(true);
      await this.moveTreeCursorToCurrentLine(sourceUri);
    } catch (error) {
      const shouldRollBack = session.currentOpenFsPath === uri.fsPath;
      if (shouldRollBack) {
        session.currentOpenFsPath = previousOpenFsPath;
        this.updateTreeDocumentCurrentLine(sourceUriString, previousOpenFsPath);
        this.applyCurrentLineDecorations();
        await this.moveTreeCursorToCurrentLine(sourceUri);
      }
      void vscode.window.showErrorMessage(
        `Could not open Writerly tree file: ${uri.fsPath}`,
      );
    }
  }

  private async selectDocumentTreeLine(
    sourceUri: vscode.Uri,
    treeDocument: TreeDocument,
    line: number,
    kind: "file" | "viewModeControl",
  ): Promise<void> {
    treeDocument.currentLine = line;
    treeDocument.currentLineKind = kind;
    this.applyCurrentLineDecorations();
    await this.moveTreeCursorToCurrentLine(sourceUri);
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
    treeDocument.currentLineKind =
      currentFileLine === undefined ? undefined : "file";
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

  private async focusDocumentTreeFile(): Promise<void> {
    const treeEditor = vscode.window.activeTextEditor;
    if (!treeEditor || treeEditor.document.uri.scheme !== DOCUMENT_TREE_SCHEME) {
      return;
    }

    const sourceUriString = this.getUriKey(treeEditor.document.uri);
    const treeDocument = this.documents.get(sourceUriString);
    if (
      treeDocument?.currentLineKind === "viewModeControl" &&
      treeDocument.viewModeControl?.enabled
    ) {
      await this.toggleDocumentTreeViewModeInPlace(sourceUriString);
      return;
    }

    const session = this.sessions.get(sourceUriString);
    if (!session) return;

    const document = await vscode.workspace.openTextDocument(
      vscode.Uri.file(session.currentOpenFsPath),
    );
    await vscode.window.showTextDocument(document, {
      viewColumn: session.originViewColumn,
      preview: true,
    });
  }

  private async toggleDocumentTreeViewModeInPlace(
    sourceUriString: string,
  ): Promise<void> {
    const session = this.sessions.get(sourceUriString);
    if (!session) return;

    session.viewMode = session.viewMode === "all" ? "active" : "all";
    await this.refreshSession(sourceUriString, session);

    const treeDocument = this.documents.get(sourceUriString);
    if (!treeDocument?.viewModeControl?.enabled) return;
    treeDocument.currentLine = treeDocument.viewModeControl.line;
    treeDocument.currentLineKind = "viewModeControl";
    this.scheduleTreeDocumentDecorations();
    await this.moveTreeCursorToCurrentLine(session.uri);
  }

  private async focusDocumentTreeFileAndClose(): Promise<void> {
    const treeEditor = vscode.window.activeTextEditor;
    if (!treeEditor || treeEditor.document.uri.scheme !== DOCUMENT_TREE_SCHEME) {
      return;
    }

    const treeUri = treeEditor.document.uri;
    await this.focusDocumentTreeFile();
    await this.closeDocumentTreeTab(treeUri);
  }

  private async closeDocumentTreeTab(uri: vscode.Uri): Promise<void> {
    const match = this.findTabForUri(uri);
    if (!match) return;
    await vscode.window.tabGroups.close(match.tab, true);
  }

  private findTabForUri(
    uri: vscode.Uri,
  ): { tab: vscode.Tab; tabGroup: vscode.TabGroup } | undefined {
    for (const tabGroup of vscode.window.tabGroups.all) {
      const tab = tabGroup.tabs.find((candidate) =>
        this.isTabForUri(candidate, uri),
      );
      if (tab) return { tab, tabGroup };
    }
    return undefined;
  }

  private isTabForUri(tab: vscode.Tab, uri: vscode.Uri): boolean {
    const input = tab.input;
    return (
      input instanceof vscode.TabInputText &&
      input.uri.toString() === uri.toString()
    );
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
    const previousTreeDocument = this.documents.get(uriString);
    const nextTreeDocument = await this.createTreeDocumentForAnchor(session);
    if (
      previousTreeDocument?.currentLineKind === "viewModeControl" &&
      nextTreeDocument.viewModeControl?.enabled
    ) {
      nextTreeDocument.currentLine = nextTreeDocument.viewModeControl.line;
      nextTreeDocument.currentLineKind = "viewModeControl";
    }
    this.documents.set(uriString, nextTreeDocument);
    this.onDidChangeEmitter.fire(session.uri);
    this.scheduleTreeDocumentDecorations();
  }

  private scheduleTreeDocumentDecorations(attempt = 0): void {
    if (this.decorationRefreshTimeout) {
      clearTimeout(this.decorationRefreshTimeout);
    }
    const delay = attempt === 0 ? 0 : DECORATION_REFRESH_RETRY_DELAY_MS;
    this.decorationRefreshTimeout = setTimeout(() => {
      this.decorationRefreshTimeout = undefined;
      const applied = this.applyTreeDocumentDecorations();
      if (!applied && attempt < DECORATION_REFRESH_MAX_ATTEMPTS) {
        this.scheduleTreeDocumentDecorations(attempt + 1);
      }
    }, delay);
  }

  private applyCurrentLineDecorations(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.scheme !== DOCUMENT_TREE_SCHEME) continue;

      const treeDocument = this.documents.get(
        this.getUriKey(editor.document.uri),
      );
      if (!treeDocument) continue;
      editor.setDecorations(
        this.currentFileLineDecoration,
        this.getCurrentLineDecorationRanges(treeDocument),
      );
    }
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

      editor.setDecorations(
        this.currentFileLineDecoration,
        this.getCurrentLineDecorationRanges(treeDocument),
      );
      editor.setDecorations(
        this.mutedLineDecoration,
        (treeDocument?.mutedLines ?? []).map(
          (line) =>
            new vscode.Range(line, 0, line, 0),
        ),
      );
      editor.setDecorations(
        this.warningFilenameDecoration,
        treeDocument.warningFilenameRanges.map(
          (range) =>
            new vscode.Range(
              range.line,
              range.startCharacter,
              range.line,
              range.endCharacter,
            ),
        ),
      );
      editor.setDecorations(
        this.errorFilenameDecoration,
        treeDocument.errorFilenameRanges.map(
          (range) =>
            new vscode.Range(
              range.line,
              range.startCharacter,
              range.line,
              range.endCharacter,
            ),
        ),
      );
    }

    return allVisibleDocumentsAreCurrent;
  }

  private getCurrentLineDecorationRanges(
    treeDocument: TreeDocument,
  ): vscode.Range[] {
    const currentLine = treeDocument.currentLine;
    if (currentLine === undefined) return [];
    return [
      new vscode.Range(
        currentLine,
        0,
        currentLine,
        0,
      ),
    ];
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
        currentLineKind: undefined,
        mutedLines: [],
        warningFilenameRanges: [],
        errorFilenameRanges: [],
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
        currentLineKind: undefined,
        mutedLines: [],
        warningFilenameRanges: [],
        errorFilenameRanges: [],
      };
    }
    if (rootStatus === "notRoot") {
      return {
        text: `Inspector abandoned: directory is no longer a topmost Writerly root.\n\n${rootDir}`,
        links: [],
        fileLines: [],
        viewModeControl: undefined,
        currentLine: undefined,
        currentLineKind: undefined,
        mutedLines: [],
        warningFilenameRanges: [],
        errorFilenameRanges: [],
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
    const warningFilenameRanges: DiagnosticFilenameRange[] = [];
    const errorFilenameRanges: DiagnosticFilenameRange[] = [];
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
      fileLines,
      mutedLines,
      warningFilenameRanges,
      errorFilenameRanges,
    );
    if (fileLines.length > 0) {
      lines.push("");
    }
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
      currentLineKind: currentLine === undefined ? undefined : "file",
      mutedLines,
      warningFilenameRanges,
      errorFilenameRanges,
    };
  }

  private appendOrderedFileLines(
    lines: string[],
    files: readonly vscode.Uri[],
    currentFsPath: string,
    root: RootDisplay | undefined,
    viewMode: TreeViewMode,
    fileLines: FileLineTarget[],
    mutedLines: number[],
    warningFilenameRanges: DiagnosticFilenameRange[],
    errorFilenameRanges: DiagnosticFilenameRange[],
  ): number | undefined {
    let currentLine: number | undefined;

    if (!root) {
      for (const uri of files) {
        const line = lines.length;
        const fileName = path.basename(uri.fsPath);
        if (uri.fsPath === currentFsPath) currentLine = line;
        if (this.isCommentedPath(uri.fsPath)) mutedLines.push(line);
        this.addDiagnosticFilenameRange(
          uri.fsPath,
          line,
          0,
          fileName.length,
          warningFilenameRanges,
          errorFilenameRanges,
        );
        lines.push(
          `${fileName}  ${this.getCommentStatusMarker(uri.fsPath)} `,
        );
        fileLines.push({
          line,
          uri,
          indentation: 0,
          startCharacter: 0,
          endCharacter: fileName.length,
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
        file.dirPath.length > 0 ? file.dirPath : "";
      if (file.uri.fsPath === currentFsPath) currentLine = line;
      if (this.isCommentedPath(file.uri.fsPath)) mutedLines.push(line);
      this.addDiagnosticFilenameRange(
        file.uri.fsPath,
        line,
        file.indentation,
        file.indentation + file.fileName.length,
        warningFilenameRanges,
        errorFilenameRanges,
      );
      lines.push(
        `${indentedFileName.padEnd(fileColumnWidth)}  ${this.getCommentStatusMarker(file.uri.fsPath)} ${dirColumn}`,
      );
      fileLines.push({
        line,
        uri: file.uri,
        indentation: file.indentation,
        startCharacter: file.indentation,
        endCharacter: file.indentation + file.fileName.length,
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
    return this.isCommentedPath(fsPath) ? "#" : " ";
  }

  private addDiagnosticFilenameRange(
    fsPath: string,
    line: number,
    startCharacter: number,
    endCharacter: number,
    warningFilenameRanges: DiagnosticFilenameRange[],
    errorFilenameRanges: DiagnosticFilenameRange[],
  ): void {
    const status = this.getDiagnosticStatus(fsPath);
    if (status === "error") {
      errorFilenameRanges.push({ line, startCharacter, endCharacter });
    } else if (status === "warning") {
      warningFilenameRanges.push({ line, startCharacter, endCharacter });
    }
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
