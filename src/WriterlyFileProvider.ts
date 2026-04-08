import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";

type WriterlyTreeItem = WriterlyFileItem | WriterlyFolderItem;

export class WriterlyFileProvider implements vscode.TreeDataProvider<WriterlyTreeItem> {
  _onDidChangeTreeData: vscode.EventEmitter<
    WriterlyTreeItem | undefined | null | void
  > = new vscode.EventEmitter<WriterlyTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<
    WriterlyTreeItem | undefined | null | void
  > = this._onDidChangeTreeData.event;
  writerlyFilesCache: vscode.Uri[] = [];
  fileSystemWatcher: vscode.FileSystemWatcher;
  public treeView?: vscode.TreeView<WriterlyTreeItem>;
  private isScanning = false;

  constructor(context: vscode.ExtensionContext) {
    this.fileSystemWatcher =
      vscode.workspace.createFileSystemWatcher("**/*.wly");

    this.treeView = vscode.window.createTreeView("writerlyFiles", {
      treeDataProvider: this,
    });

    const disposables = [
      this.fileSystemWatcher,
      this.treeView,
      this.fileSystemWatcher.onDidChange((_uri) => this.refresh()),
      this.fileSystemWatcher.onDidCreate((_uri) => this.refresh()),
      this.fileSystemWatcher.onDidDelete((_uri) => this.refresh()),
      // apparently this one kind of optional (?):
      vscode.commands.registerCommand("writerlyFiles.refreshEntry", () =>
        this.refresh(),
      ),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        this.revealEditorItem(editor);
      }),
      this.treeView?.onDidChangeVisibility((e) => {
        if (e.visible) {
          this.revealEditorItem(vscode.window.activeTextEditor);
        }
      }),
    ];

    for (const disposable of disposables)
      if (disposable) context.subscriptions.push(disposable);

    this.revealEditorItem(vscode.window.activeTextEditor);
  }

  /**
   * Resets the TreeView state, clears the file cache, and re-scans the workspace.
   * Called by the WriterlyController.
   */
  public async reset(): Promise<void> {
    // 1. Clear the cached file URIs
    this.writerlyFilesCache = [];

    // 2. Trigger a full UI refresh
    // This forces getChildren() to run again, which calls findFiles()
    this._onDidChangeTreeData.fire();

    // 3. Re-sync the highlight to the currently open file
    setTimeout(() => {
      if (vscode.window.activeTextEditor) {
        this.revealEditorItem(vscode.window.activeTextEditor);
      }
    }, 500);
  }

  private revealEditorItem(editor: vscode.TextEditor | undefined) {
    if (
      this.treeView?.visible &&
      editor &&
      editor.document.uri.fsPath.endsWith(".wly")
    ) {
      const item = new WriterlyFileItem(editor.document.uri);
      // 'reveal' needs getParent to work!
      this.treeView.reveal(item, {
        select: true,
        focus: false,
        expand: true,
      });
    }
  }

  public refresh(): void {
    this.writerlyFilesCache = [];
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: WriterlyTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: WriterlyTreeItem): Promise<WriterlyTreeItem[]> {
    if (!vscode.workspace.workspaceFolders) {
      return [];
    }

    if (this.writerlyFilesCache.length === 0 && !element && !this.isScanning) {
      this.isScanning = true;
      try {
        this.writerlyFilesCache = await vscode.workspace.findFiles(
          "**/*.wly",
          "**/node_modules/**",
        );
      } finally {
        this.isScanning = false;
      }
    }

    if (!element) {
      return this.buildWorkspaceRootItems();
    } else if (element instanceof WriterlyFolderItem) {
      return this.buildFolderChildren(element);
    }

    return [];
  }

  // --- New comparison helper function ---
  private compareItems(a: WriterlyTreeItem, b: WriterlyTreeItem): number {
    // Use localeCompare for correct alphabetical sorting that respects OS rules
    const nameA = a.label as string;
    const nameB = b.label as string;
    return nameA.localeCompare(nameB, undefined, {
      numeric: true,
      sensitivity: "base",
    });
  }

  private buildWorkspaceRootItems(): WriterlyTreeItem[] {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) return [];

    const items: WriterlyTreeItem[] = [];
    workspaceFolders.forEach((folder) => {
      const hasWriterlyFiles = this.writerlyFilesCache.some((uri) =>
        uri.fsPath.startsWith(folder.uri.fsPath),
      );
      if (hasWriterlyFiles) {
        items.push(new WriterlyFolderItem(folder.uri, folder.name));
      }
    });

    // Sort the top-level items alphabetically
    return items.sort(this.compareItems);
  }

  private async buildFolderChildren(
    folderItem: WriterlyFolderItem,
  ): Promise<WriterlyTreeItem[]> {
    const parentDir = folderItem.resourceUri.fsPath;
    const items: WriterlyTreeItem[] = [];
    const seenPaths = new Set<string>(); // Track unique paths to prevent ID collisions

    try {
      // 1. Process Subdirectories
      const subdirectories = fs
        .readdirSync(parentDir, { withFileTypes: true })
        .filter((dirent) => dirent.isDirectory())
        .map((dirent) => path.join(parentDir, dirent.name));

      for (const dirPath of subdirectories) {
        // Normalize path for consistent ID comparison
        const normalizedPath = vscode.Uri.file(dirPath).fsPath;

        const hasWriterlyFilesDeep = this.writerlyFilesCache.some((uri) =>
          uri.fsPath.startsWith(normalizedPath),
        );

        if (hasWriterlyFilesDeep && !seenPaths.has(normalizedPath)) {
          seenPaths.add(normalizedPath);
          const uri = vscode.Uri.file(dirPath);
          items.push(new WriterlyFolderItem(uri, path.basename(dirPath)));
        }
      }

      // 2. Process Files in this folder
      const files = this.writerlyFilesCache.filter(
        (uri) => path.dirname(uri.fsPath) === parentDir,
      );

      files.forEach((uri) => {
        const normalizedFilePath = uri.fsPath;
        if (!seenPaths.has(normalizedFilePath)) {
          seenPaths.add(normalizedFilePath);
          items.push(new WriterlyFileItem(uri));
        }
      });

      // 3. Sort
      return items.sort(this.compareItems);
    } catch (error) {
      console.error(`Error reading directory ${parentDir}:`, error);
      return [];
    }
  }

  public getParent(element: WriterlyTreeItem): WriterlyTreeItem | undefined {
    const parentPath = path.dirname(element.resourceUri.fsPath);

    // Find if this path belongs to a workspace
    const folder = vscode.workspace.getWorkspaceFolder(element.resourceUri);

    // If we've reached the top (the workspace folder itself), stop climbing
    if (!folder || folder.uri.fsPath === element.resourceUri.fsPath) {
      return undefined;
    }

    // Return a folder item that represents the directory containing the current item
    return new WriterlyFolderItem(
      vscode.Uri.file(parentPath),
      path.basename(parentPath),
    );
  }
}

class WriterlyFolderItem extends vscode.TreeItem {
  constructor(
    public readonly resourceUri: vscode.Uri,
    label: string,
  ) {
    super(label, vscode.TreeItemCollapsibleState.Expanded);
    this.id = `folder:${resourceUri.fsPath}`;
    this.contextValue = "writerlyFolder";
    this.iconPath = vscode.ThemeIcon.Folder;
  }
}

class WriterlyFileItem extends vscode.TreeItem {
  constructor(public readonly resourceUri: vscode.Uri) {
    super(resourceUri, vscode.TreeItemCollapsibleState.None);
    this.id = `file:${resourceUri.fsPath}`;
    this.label = path.basename(resourceUri.fsPath);
    this.tooltip = resourceUri.fsPath;
    this.contextValue = "writerlyFile";
    this.command = {
      command: "vscode.open",
      title: "Open File",
      arguments: [resourceUri],
    };
    this.iconPath = vscode.ThemeIcon.File;
  }
}
