import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";

type WlyTreeItem = WlyFileItem | WlyFolderItem;

export class WlyFileProvider implements vscode.TreeDataProvider<WlyTreeItem> {
  _onDidChangeTreeData: vscode.EventEmitter<
    WlyTreeItem | undefined | null | void
  > = new vscode.EventEmitter<WlyTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<
    WlyTreeItem | undefined | null | void
  > = this._onDidChangeTreeData.event;
  wlyFilesCache: vscode.Uri[] = [];
  fileSystemWatcher: vscode.FileSystemWatcher;
  public treeView?: vscode.TreeView<WlyTreeItem>;

  constructor(context: vscode.ExtensionContext) {
    this.fileSystemWatcher =
      vscode.workspace.createFileSystemWatcher("**/*.wly");

    this.treeView = vscode.window.createTreeView("wlyFiles", {
      treeDataProvider: this,
    });

    const disposables = [
      this.fileSystemWatcher,
      this.treeView,
      this.fileSystemWatcher.onDidChange((_uri) => this.refresh()),
      this.fileSystemWatcher.onDidCreate((_uri) => this.refresh()),
      this.fileSystemWatcher.onDidDelete((_uri) => this.refresh()),
      // apparently this one kind of optional (?):
      vscode.commands.registerCommand("wlyFiles.refreshEntry", () =>
        this.refresh(),
      ),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        this.revealEditorItem(editor);
      }),
    ];

    for (const disposable of disposables)
      context.subscriptions.push(disposable);

    this.revealEditorItem(vscode.window.activeTextEditor);
  }

  /**
   * Resets the TreeView state, clears the file cache, and re-scans the workspace.
   * Called by the WriterlyController.
   */
  public async reset(): Promise<void> {
    // 1. Clear the cached file URIs
    this.wlyFilesCache = [];

    // 2. Trigger a full UI refresh
    // This forces getChildren() to run again, which calls findFiles()
    this._onDidChangeTreeData.fire();

    // 3. Re-sync the highlight to the currently open file
    if (vscode.window.activeTextEditor) {
      this.revealEditorItem(vscode.window.activeTextEditor);
    }
  }

  private revealEditorItem(editor: vscode.TextEditor | undefined) {
    if (editor && editor.document.uri.fsPath.endsWith(".wly")) {
      const item = new WlyFileItem(editor.document.uri);
      // 'reveal' needs getParent to work!
      this.treeView?.reveal(item, {
        select: true,
        focus: false,
        expand: true,
      });
    }
  }

  public refresh(): void {
    this.wlyFilesCache = [];
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: WlyTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: WlyTreeItem): Promise<WlyTreeItem[]> {
    if (!vscode.workspace.workspaceFolders) {
      return [];
    }

    if (this.wlyFilesCache.length === 0 && !element) {
      this.wlyFilesCache = await vscode.workspace.findFiles(
        "**/*.wly",
        "**/node_modules/**",
      );
      // ... (optional context setting code omitted for brevity) ...
    }

    if (!element) {
      return this.buildWorkspaceRootItems();
    } else if (element instanceof WlyFolderItem) {
      return this.buildFolderChildren(element);
    }

    return [];
  }

  // --- New comparison helper function ---
  private compareItems(a: WlyTreeItem, b: WlyTreeItem): number {
    // Use localeCompare for correct alphabetical sorting that respects OS rules
    const nameA = a.label as string;
    const nameB = b.label as string;
    return nameA.localeCompare(nameB, undefined, {
      numeric: true,
      sensitivity: "base",
    });
  }

  private buildWorkspaceRootItems(): WlyTreeItem[] {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) return [];

    const items: WlyTreeItem[] = [];
    workspaceFolders.forEach((folder) => {
      const hasWlyFiles = this.wlyFilesCache.some((uri) =>
        uri.fsPath.startsWith(folder.uri.fsPath),
      );
      if (hasWlyFiles) {
        items.push(new WlyFolderItem(folder.uri, folder.name));
      }
    });

    // Sort the top-level items alphabetically
    return items.sort(this.compareItems);
  }

  private async buildFolderChildren(
    folderItem: WlyFolderItem,
  ): Promise<WlyTreeItem[]> {
    const parentDir = folderItem.resourceUri.fsPath;
    let items: WlyTreeItem[] = []; // Change to 'let' to allow sorting

    try {
      // ... (logic to find subdirectories remains the same) ...
      const subdirectories = fs
        .readdirSync(parentDir, { withFileTypes: true })
        .filter((dirent) => dirent.isDirectory())
        .map((dirent) => path.join(parentDir, dirent.name));

      for (const dirPath of subdirectories) {
        const hasWlyFilesDeep = this.wlyFilesCache.some((uri) =>
          uri.fsPath.startsWith(dirPath),
        );
        if (hasWlyFilesDeep) {
          const uri = vscode.Uri.file(dirPath);
          items.push(new WlyFolderItem(uri, path.basename(dirPath)));
        }
      }

      // ... (logic to find files remains the same) ...
      const files = this.wlyFilesCache.filter(
        (uri) => path.dirname(uri.fsPath) === parentDir,
      );

      files.forEach((uri) => {
        items.push(new WlyFileItem(uri));
      });

      // Sort all collected items (folders and files combined) alphabetically
      items = items.sort(this.compareItems);
    } catch (error) {
      console.error(`Error reading directory ${parentDir}:`, error);
    }

    return items;
  }

  public getParent(element: WlyTreeItem): WlyTreeItem | undefined {
    const parentPath = path.dirname(element.resourceUri.fsPath);

    // Find if this path belongs to a workspace
    const folder = vscode.workspace.getWorkspaceFolder(element.resourceUri);

    // If we've reached the top (the workspace folder itself), stop climbing
    if (!folder || folder.uri.fsPath === element.resourceUri.fsPath) {
      return undefined;
    }

    // Return a folder item that represents the directory containing the current item
    return new WlyFolderItem(
      vscode.Uri.file(parentPath),
      path.basename(parentPath),
    );
  }
}

class WlyFolderItem extends vscode.TreeItem {
  constructor(
    public readonly resourceUri: vscode.Uri,
    label: string,
  ) {
    super(label, vscode.TreeItemCollapsibleState.Expanded);
    this.id = resourceUri.fsPath;
    this.contextValue = "wlyFolder";
    this.iconPath = vscode.ThemeIcon.Folder;
  }
}

class WlyFileItem extends vscode.TreeItem {
  constructor(public readonly resourceUri: vscode.Uri) {
    super(resourceUri, vscode.TreeItemCollapsibleState.None);
    this.id = resourceUri.fsPath;
    this.label = path.basename(resourceUri.fsPath);
    this.tooltip = resourceUri.fsPath;
    this.contextValue = "wlyFile";
    this.command = {
      command: "vscode.open",
      title: "Open File",
      arguments: [resourceUri],
    };
    this.iconPath = vscode.ThemeIcon.File;
  }
}
