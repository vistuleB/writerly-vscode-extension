import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

type WlyTreeItem = WlyFileItem | WlyFolderItem;

export class WlyFileProvider implements vscode.TreeDataProvider<WlyTreeItem> {
    // ... existing properties and methods (constructor, refresh, getTreeItem, getChildren) ...
    private _onDidChangeTreeData: vscode.EventEmitter<WlyTreeItem | undefined | null | void> = new vscode.EventEmitter<WlyTreeItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<WlyTreeItem | undefined | null | void> = this._onDidChangeTreeData.event;
    private wlyFilesCache: vscode.Uri[] = [];
    private fileSystemWatcher: vscode.FileSystemWatcher;

    constructor() {
        this.fileSystemWatcher = vscode.workspace.createFileSystemWatcher('**/*.wly');
        this.fileSystemWatcher.onDidChange(uri => this.refresh());
        this.fileSystemWatcher.onDidCreate(uri => this.refresh());
        this.fileSystemWatcher.onDidDelete(uri => this.refresh());
    }

    public refresh(): void {
        this.wlyFilesCache = []; 
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: WlyTreeItem): vscode.TreeItem { return element; }

    async getChildren(element?: WlyTreeItem): Promise<WlyTreeItem[]> {
        if (!vscode.workspace.workspaceFolders) { return []; }

        if (this.wlyFilesCache.length === 0 && !element) {
            this.wlyFilesCache = await vscode.workspace.findFiles('**/*.wly', '**/node_modules/**');
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
        return nameA.localeCompare(nameB, undefined, { numeric: true, sensitivity: 'base' });
    }

    private buildWorkspaceRootItems(): WlyTreeItem[] {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) return [];

        const items: WlyTreeItem[] = [];
        workspaceFolders.forEach(folder => {
            const hasWlyFiles = this.wlyFilesCache.some(uri => uri.fsPath.startsWith(folder.uri.fsPath));
            if (hasWlyFiles) {
                items.push(new WlyFolderItem(folder.uri, folder.name));
            }
        });
        
        // Sort the top-level items alphabetically
        return items.sort(this.compareItems);
    }

    private async buildFolderChildren(folderItem: WlyFolderItem): Promise<WlyTreeItem[]> {
        const parentDir = folderItem.resourceUri.fsPath;
        let items: WlyTreeItem[] = []; // Change to 'let' to allow sorting

        try {
            // ... (logic to find subdirectories remains the same) ...
            const subdirectories = fs.readdirSync(parentDir, { withFileTypes: true })
                .filter(dirent => dirent.isDirectory())
                .map(dirent => path.join(parentDir, dirent.name));

            for (const dirPath of subdirectories) {
                const hasWlyFilesDeep = this.wlyFilesCache.some(uri => uri.fsPath.startsWith(dirPath));
                if (hasWlyFilesDeep) {
                    const uri = vscode.Uri.file(dirPath);
                    items.push(new WlyFolderItem(uri, path.basename(dirPath)));
                }
            }

            // ... (logic to find files remains the same) ...
            const files = this.wlyFilesCache.filter(uri => 
                path.dirname(uri.fsPath) === parentDir
            );
            
            files.forEach(uri => {
                 items.push(new WlyFileItem(uri));
            });

            // Sort all collected items (folders and files combined) alphabetically
            items = items.sort(this.compareItems);

        } catch (error) {
            console.error(`Error reading directory ${parentDir}:`, error);
        }
        
        return items;
    }
}

class WlyFolderItem extends vscode.TreeItem {
  constructor(public readonly resourceUri: vscode.Uri, label: string) {
    super(label, vscode.TreeItemCollapsibleState.Expanded);
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
