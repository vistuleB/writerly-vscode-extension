import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";

// Define a type union for our tree items: either a File or a Folder
type WlyTreeItem = WlyFileItem | WlyFolderItem;

export class WlyFileProvider implements vscode.TreeDataProvider<WlyTreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<
    WlyTreeItem | undefined | null | void
  > = new vscode.EventEmitter<WlyTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<
    WlyTreeItem | undefined | null | void
  > = this._onDidChangeTreeData.event;

  // Store a cache of all WLY files found to build the structure
  private wlyFilesCache: vscode.Uri[] = [];

  getTreeItem(element: WlyTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: WlyTreeItem): Promise<WlyTreeItem[]> {
    if (!vscode.workspace.workspaceFolders) {
      vscode.window.showInformationMessage("No folder or workspace opened.");
      return [];
    }

    // If no element is provided, we are at the root(s) of the workspace
    if (!element) {
      // First, find all wly files across the entire workspace
      this.wlyFilesCache = await vscode.workspace.findFiles(
        "**/*.wly",
        "**/node_modules/**"
      );

      // Build the top level folders
      return this.buildWorkspaceRootItems();
    }

    // If an element is a folder, get its children
    if (element instanceof WlyFolderItem) {
      return this.buildFolderChildren(element);
    }

    return []; // Files have no children
  }

  private buildWorkspaceRootItems(): WlyTreeItem[] {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) return [];

    const items: WlyTreeItem[] = [];
    workspaceFolders.forEach((folder) => {
      // Check if this root folder actually contains any .wly files before adding it
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

    // 1. Find all subdirectories within the current folder
    const subdirectories = fs
      .readdirSync(parentDir, { withFileTypes: true })
      .filter((dirent) => dirent.isDirectory())
      .map((dirent) => path.join(parentDir, dirent.name));

    // 2. Filter subdirectories: only keep those that contain .wly files
    for (const dirPath of subdirectories) {
      const hasWlyFilesDeep = this.wlyFilesCache.some((uri) =>
        uri.fsPath.startsWith(dirPath)
      );
      if (hasWlyFilesDeep) {
        const uri = vscode.Uri.file(dirPath);
        items.push(new WlyFolderItem(uri, path.basename(dirPath)));
      }
    }

    // 3. Find all .wly files directly in the current folder
    const files = this.wlyFilesCache.filter(
      (uri) => path.dirname(uri.fsPath) === parentDir
    );

    files.forEach((uri) => {
      items.push(new WlyFileItem(uri));
    });

    return items;
  }
}

// Represents a folder in the tree
class WlyFolderItem extends vscode.TreeItem {
  constructor(public readonly resourceUri: vscode.Uri, label: string) {
    // Folders are collapsible by default
    super(label, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = "wlyFolder";
    this.iconPath = vscode.ThemeIcon.Folder; // Use standard folder icon
  }
}

// Represents a .wly file in the tree
class WlyFileItem extends vscode.TreeItem {
  constructor(public readonly resourceUri: vscode.Uri) {
    super(resourceUri, vscode.TreeItemCollapsibleState.None);

    this.label = path.basename(resourceUri.fsPath);
    this.tooltip = resourceUri.fsPath;
    this.contextValue = "wlyFile";
    // Command to open the file when clicked
    this.command = {
      command: "vscode.open",
      title: "Open File",
      arguments: [resourceUri],
    };
    this.iconPath = vscode.ThemeIcon.File; // Use standard file icon
  }
}
