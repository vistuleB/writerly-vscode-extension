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
const PARENT_FILE_SUFFIX = "__parent.wly";
const ASSEMBLY_INDENT_WIDTH = 4;

type RootDisplay = {
  rootDir: string;
};

type DirectoryNode = {
  name: string;
  files: vscode.Uri[];
  directories: Map<string, DirectoryNode>;
};

type DisplayEntry = {
  name: string;
  uri?: vscode.Uri;
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

type TreeDocument = {
  text: string;
  links: LinkTarget[];
};

type InspectorSession = {
  anchorFsPath: string;
  currentOpenFsPath: string;
  uri: vscode.Uri;
};

export class WriterlyDocumentTreeInspector
  implements vscode.TextDocumentContentProvider, vscode.DocumentLinkProvider
{
  private readonly statusBarItem: vscode.StatusBarItem;
  private readonly onDidChangeEmitter =
    new vscode.EventEmitter<vscode.Uri>();
  public readonly onDidChange = this.onDidChangeEmitter.event;
  private currentDocument: TreeDocument | undefined;
  private currentSession: InspectorSession | undefined;
  private documentVersion = 0;
  private originViewColumn: vscode.ViewColumn | undefined;
  private refreshTimeout: NodeJS.Timeout | undefined;

  constructor(context: vscode.ExtensionContext) {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      20,
    );
    this.statusBarItem.command = "writerly.inspectDocumentTree";
    this.statusBarItem.text = "$(list-tree) Writerly Tree";
    this.statusBarItem.tooltip = "Inspect Writerly document tree";

    const watcher = vscode.workspace.createFileSystemWatcher("**/*");
    const refresh = () => this.scheduleRefresh();

    context.subscriptions.push(
      this.statusBarItem,
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
        (fsPath: string) => this.openDocumentTreeFile(fsPath),
      ),
      vscode.window.onDidChangeActiveTextEditor((editor) =>
        this.handleActiveTextEditorChange(editor),
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

  public provideTextDocumentContent(_uri: vscode.Uri): string {
    return this.currentDocument?.text ?? "";
  }

  public provideDocumentLinks(
    document: vscode.TextDocument,
    _token: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.DocumentLink[]> {
    if (!this.currentDocument) return [];

    return this.currentDocument.links.map((link) => {
      const range = new vscode.Range(
        link.line,
        link.startCharacter,
        link.line,
        link.endCharacter,
      );
      return new vscode.DocumentLink(range, this.createOpenFileCommandUri(link.uri));
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
      this.currentSession &&
      isWriterlyFilePath(editor.document.uri.fsPath)
    ) {
      this.currentSession.currentOpenFsPath = editor.document.uri.fsPath;
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

    this.originViewColumn = editor.viewColumn;
    this.documentVersion++;
    const uri = vscode.Uri.from({
      scheme: DOCUMENT_TREE_SCHEME,
      path: `/tree-${this.documentVersion}.txt`,
    });
    this.currentSession = {
      anchorFsPath: editor.document.uri.fsPath,
      currentOpenFsPath: editor.document.uri.fsPath,
      uri,
    };
    this.currentDocument = await this.createTreeDocumentForAnchor(
      this.currentSession,
    );

    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, {
      preview: false,
      viewColumn: vscode.ViewColumn.Beside,
    });
    await vscode.window.showTextDocument(editor.document, {
      viewColumn: this.originViewColumn,
      preview: false,
    });
  }

  private async openDocumentTreeFile(fsPath: string): Promise<void> {
    const document = await vscode.workspace.openTextDocument(
      vscode.Uri.file(fsPath),
    );
    await vscode.window.showTextDocument(document, {
      viewColumn: this.originViewColumn,
      preview: false,
    });
    if (this.currentSession) {
      this.currentSession.currentOpenFsPath = fsPath;
      await this.refreshCurrentDocument();
    }
  }

  private createOpenFileCommandUri(uri: vscode.Uri): vscode.Uri {
    const args = encodeURIComponent(JSON.stringify([uri.fsPath]));
    return vscode.Uri.parse(`command:${OPEN_TREE_FILE_COMMAND}?${args}`);
  }

  private scheduleRefresh(): void {
    if (!this.currentSession) return;
    if (this.refreshTimeout) {
      clearTimeout(this.refreshTimeout);
    }
    this.refreshTimeout = setTimeout(() => {
      void this.refreshCurrentDocument();
    }, 150);
  }

  private async refreshCurrentDocument(): Promise<void> {
    if (!this.currentSession) return;

    this.currentDocument = await this.createTreeDocumentForAnchor(
      this.currentSession,
    );
    this.onDidChangeEmitter.fire(this.currentSession.uri);
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
      };
    }

    const containers = await discoverWriterlyContainers();
    const files = await this.getDocumentTreeFiles(anchorFsPath, containers);
    const root = this.getDocumentTreeRoot(anchorFsPath, containers);
    const rootDisplay = root ? { rootDir: root } : undefined;

    return this.createTreeDocument(
      session.currentOpenFsPath,
      files,
      rootDisplay,
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
  ): TreeDocument {
    const lines: string[] = [];
    const links: LinkTarget[] = [];

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

    lines.push("");
    this.appendOrderedFileLines(lines, files, currentFsPath, root, links);

    return {
      text: lines.join("\n"),
      links,
    };
  }

  private appendOrderedFileLines(
    lines: string[],
    files: readonly vscode.Uri[],
    currentFsPath: string,
    root: RootDisplay | undefined,
    links: LinkTarget[],
  ): void {
    if (!root) {
      for (const uri of files) {
        const line = lines.length;
        const fileName = path.basename(uri.fsPath);
        const currentMarker = uri.fsPath === currentFsPath ? "■" : " ";
        lines.push(
          `${fileName}  ${currentMarker} ${this.getCommentStatusMarker(uri.fsPath)} .`,
        );
        links.push({
          line,
          startCharacter: 0,
          endCharacter: fileName.length,
          uri,
        });
      }
      return;
    }

    const tree = this.buildDirectoryTree(files, root.rootDir);
    const dirNameEndingInWriterly = this.findDirNameEndingInWriterly(tree);
    if (dirNameEndingInWriterly) {
      lines.push(
        `Error: directory name ends in .wly: ${dirNameEndingInWriterly}`,
      );
      return;
    }

    const displayFiles = this.getDisplayFilesInAssemblyOrder(
      tree,
      root.rootDir,
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
      const currentMarker = file.uri.fsPath === currentFsPath ? "■" : " ";
      lines.push(
        `${indentedFileName.padEnd(fileColumnWidth)}  ${currentMarker} ${this.getCommentStatusMarker(file.uri.fsPath)} ${dirColumn}`,
      );
      links.push({
        line,
        startCharacter: file.indentation,
        endCharacter: file.indentation + file.fileName.length,
        uri: file.uri,
      });
    }
  }

  private buildDirectoryTree(
    files: readonly vscode.Uri[],
    rootDir: string,
  ): DirectoryNode {
    const root: DirectoryNode = {
      name: "",
      files: [],
      directories: new Map(),
    };

    for (const uri of files) {
      const relativePath = path.relative(rootDir, uri.fsPath);
      const parts = relativePath
        .split(path.sep)
        .filter((part) => part.length > 0);
      let current = root;

      for (let index = 0; index < parts.length; index++) {
        const name = parts[index];
        const isFile = index === parts.length - 1;
        if (isFile) {
          current.files.push(uri);
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
    return fsPath
      .split(path.sep)
      .some((part) => part.startsWith("#"))
      ? "#"
      : "✓";
  }

  /*
   * The inspector display follows the assembly-order rules in
   * writerly.gleam's input_lines_for_dirtree_at_depth:
   * - emit files, not directories
   * - sort directory entries by name after dropping the __parent.wly suffix
   * - active, non-# <prefix>__parent.wly files add one indentation level to
   *   matching sibling files/directories, except the parent file itself
   *
   * The inspector also displays # paths as inert entries. They sort near their
   * uncommented counterpart and can receive indentation, but # parent files do
   * not add indentation to other entries.
   */
  private getDisplayFilesInAssemblyOrder(
    directory: DirectoryNode,
    rootDir: string,
    depth = 0,
  ): DisplayFile[] {
    const entries = this.sortEntriesForDisplay(
      this.getDisplayEntries(directory),
    );
    const parentPrefixes = directory.files
      .map((uri) => this.getActiveParentFilePrefix(path.basename(uri.fsPath)))
      .filter((prefix): prefix is string => prefix !== undefined);
    const files: DisplayFile[] = [];

    for (const entry of entries) {
      const entryDepth =
        depth +
        parentPrefixes.filter(
          (prefix) => this.activeParentPrefixApplies(prefix, entry.name),
        ).length;

      if (entry.directory) {
        files.push(
          ...this.getDisplayFilesInAssemblyOrder(
            entry.directory,
            rootDir,
            entryDepth,
          ),
        );
      } else if (entry.uri) {
        files.push({
          uri: entry.uri,
          fileName: entry.name,
          dirPath: path
            .relative(rootDir, path.dirname(entry.uri.fsPath))
            .split(path.sep)
            .join("/"),
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

  private getDisplayEntries(directory: DirectoryNode): DisplayEntry[] {
    return [
      ...directory.files.map((uri) => ({
        name: path.basename(uri.fsPath),
        uri,
      })),
      ...[...directory.directories.values()].map((childDirectory) => ({
        name: childDirectory.name,
        directory: childDirectory,
      })),
    ];
  }

  private sortEntriesForDisplay(
    entries: readonly DisplayEntry[],
  ): DisplayEntry[] {
    return [...entries].sort((a, b) => {
      const aOrder = this.getDisplaySortKey(a.name);
      const bOrder = this.getDisplaySortKey(b.name);
      return (
        aOrder.anchor.localeCompare(bOrder.anchor) ||
        aOrder.rank - bOrder.rank ||
        aOrder.name.localeCompare(bOrder.name)
      );
    });
  }

  private getDisplaySortKey(fileNameOrDirName: string): {
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

  private getActiveParentFilePrefix(fileName: string): string | undefined {
    if (fileName.startsWith("#")) return undefined;
    if (!fileName.endsWith(PARENT_FILE_SUFFIX)) return undefined;
    return fileName.slice(0, -PARENT_FILE_SUFFIX.length);
  }

  private activeParentPrefixApplies(
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
