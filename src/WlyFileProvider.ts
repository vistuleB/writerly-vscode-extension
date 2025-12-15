import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";

type WlyTreeItem = WlyFileItem | WlyFolderItem;

export class WlyFileProvider implements vscode.TreeDataProvider<WlyTreeItem> {
  // This EventEmitter is key: when we fire this event, VS Code re-renders the tree view.
  private _onDidChangeTreeData: vscode.EventEmitter<
    WlyTreeItem | undefined | null | void
  > = new vscode.EventEmitter<WlyTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<
    WlyTreeItem | undefined | null | void
  > = this._onDidChangeTreeData.event;

  private wlyFilesCache: vscode.Uri[] = [];
  private fileSystemWatcher: vscode.FileSystemWatcher;

  constructor() {
    // Create a FileSystemWatcher that specifically watches for changes to any .wly file
    // The pattern '**/*.wly' ensures we capture changes anywhere in the workspace
    this.fileSystemWatcher =
      vscode.workspace.createFileSystemWatcher("**/*.wly");

    // Register listeners for create, change, and delete events
    this.fileSystemWatcher.onDidChange((uri) => this.refresh());
    this.fileSystemWatcher.onDidCreate((uri) => this.refresh());
    this.fileSystemWatcher.onDidDelete((uri) => this.refresh());

    // Ensure the watcher is disposed of when the provider is disposed (good practice)
    // If you need to manage the lifecycle, you might pass a context to the constructor
  }

  // Public refresh method that invalidates the current view and triggers a re-render
  public refresh(): void {
    // Clear the cache first so the next call to getChildren re-scans the disk
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
      // Only perform the full workspace search if the cache is empty and we are at the root
      this.wlyFilesCache = await vscode.workspace.findFiles(
        "**/*.wly",
        "**/node_modules/**"
      );
      if (this.wlyFilesCache.length === 0) {
        // You might want to display a message inside the view if no files are found
        vscode.commands.executeCommand(
          "setContext",
          "wlyFilesExplorerHasFiles",
          false
        );
      } else {
        vscode.commands.executeCommand(
          "setContext",
          "wlyFilesExplorerHasFiles",
          true
        );
      }
    }

    if (!element) {
      return this.buildWorkspaceRootItems();
    }

    if (element instanceof WlyFolderItem) {
      return this.buildFolderChildren(element);
    }

    return [];
  }

  private buildWorkspaceRootItems(): WlyTreeItem[] {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) return [];

    const items: WlyTreeItem[] = [];
    workspaceFolders.forEach((folder) => {
      const hasWlyFiles = this.wlyFilesCache.some((uri) =>
        uri.fsPath.startsWith(folder.uri.fsPath)
      );
      if (hasWlyFiles) {
        items.push(new WlyFolderItem(folder.uri, folder.name));
      }
    });
    return items;
  }

  private async buildFolderChildren(
    folderItem: WlyFolderItem
  ): Promise<WlyTreeItem[]> {
    const parentDir = folderItem.resourceUri.fsPath;
    const items: WlyTreeItem[] = [];

    // Note: In a real-time system, using sync FS methods can be risky in an async context,
    // but for a view provider refresh, it's often acceptable for simplicity.
    try {
      const subdirectories = fs
        .readdirSync(parentDir, { withFileTypes: true })
        .filter((dirent) => dirent.isDirectory())
        .map((dirent) => path.join(parentDir, dirent.name));

      for (const dirPath of subdirectories) {
        const hasWlyFilesDeep = this.wlyFilesCache.some((uri) =>
          uri.fsPath.startsWith(dirPath)
        );
        if (hasWlyFilesDeep) {
          const uri = vscode.Uri.file(dirPath);
          items.push(new WlyFolderItem(uri, path.basename(dirPath)));
        }
      }

      const files = this.wlyFilesCache.filter(
        (uri) => path.dirname(uri.fsPath) === parentDir
      );

      files.forEach((uri) => {
        items.push(new WlyFileItem(uri));
      });
    } catch (error) {
      console.error(`Error reading directory ${parentDir}:`, error);
    }

    return items;
  }
}

// ... WlyFileItem and WlyFolderItem classes remain the same as before ...

class WlyFolderItem extends vscode.TreeItem {
  constructor(public readonly resourceUri: vscode.Uri, label: string) {
    super(label, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = "wlyFolder";
    this.iconPath = vscode.ThemeIcon.Folder;
  }
}

class WlyFileItem extends vscode.TreeItem {
  constructor(public readonly resourceUri: vscode.Uri) {
    super(resourceUri, vscode.TreeItemCollapsibleState.None);
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
