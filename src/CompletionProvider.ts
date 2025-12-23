import * as vscode from "vscode";

interface FileNode {
  name: string;
  type: "file" | "directory";
  fullPath: string;
  children: FileNode[];
}

/**
 * Custom CompletionItem that preserves the full path for the resolution phase
 */
class WlyFileCompletionItem extends vscode.CompletionItem {
  constructor(
    public label: string,
    public kind: vscode.CompletionItemKind,
    public fullPath: string,
    public nodeType: "file" | "directory",
  ) {
    super(label, kind);
  }
}

export class WlyCompletionProvider implements vscode.CompletionItemProvider {
  private fileTree: FileNode[] = [];
  private imgExtensions: string[] = (() => {
    const base = ["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "ipe"];
    return [...base, ...base.map((ext) => ext.toUpperCase())];
  })();

  constructor(context: vscode.ExtensionContext) {
    this.loadFiles();
    const completionItemProvider =
      vscode.languages.registerCompletionItemProvider(
        { scheme: "file", language: "writerly" },
        this,
        "=",
      );

    context.subscriptions.push(completionItemProvider);

    const watcher = vscode.workspace.createFileSystemWatcher(
      `**/*.{${this.imgExtensions.join(",")}}`,
    );
    watcher.onDidCreate(() => this.loadFiles());
    watcher.onDidDelete(() => this.loadFiles());
    watcher.onDidChange(() => this.loadFiles());
    context.subscriptions.push(watcher);
  }

  private async loadFiles(): Promise<void> {
    const flatPaths = await this.getAllImageRelativePaths();
    this.fileTree = this.buildFileTree(flatPaths);
  }

  private buildFileTree(paths: string[]): FileNode[] {
    const root: FileNode[] = [];
    paths.forEach((path) => {
      const parts = path.split("/");
      let currentLevel = root;
      let accumulatedPath = "";

      parts.forEach((part, index) => {
        const isFile = index === parts.length - 1;
        accumulatedPath = accumulatedPath ? `${accumulatedPath}/${part}` : part;
        let existingNode = currentLevel.find((node) => node.name === part);

        if (!existingNode) {
          existingNode = {
            name: part,
            type: isFile ? "file" : "directory",
            fullPath: accumulatedPath,
            children: [],
          };
          currentLevel.push(existingNode);
        }
        currentLevel = existingNode.children;
      });
    });
    return root;
  }

  private async getAllImageRelativePaths(): Promise<string[]> {
    const excludePattern = "{**/node_modules/**,**/build/**,**/.*/**,**/.*}";
    const files = await vscode.workspace.findFiles(
      `**/*.{${this.imgExtensions.join(",")}}`,
      excludePattern,
    );
    return files.map((file) => vscode.workspace.asRelativePath(file, false));
  }

  public provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.ProviderResult<vscode.CompletionItem[]> {
    const linePrefix = document
      .lineAt(position)
      .text.substring(0, position.character);
    const match = linePrefix.match(/\b(src|original)=(\S*)$/);
    if (!match) return undefined;

    const fullTypedPath = match[2];
    const parts = fullTypedPath.split("/");
    const currentSearch = parts[parts.length - 1].toLowerCase();
    const lockedSegments = parts.slice(0, -1);

    let candidateNodes: FileNode[] = [];

    if (lockedSegments.length === 0) {
      candidateNodes = this.searchNodesByName(this.fileTree, currentSearch);
    } else {
      const matchingContexts = this.findNodesBySequence(
        this.fileTree,
        lockedSegments,
      );
      matchingContexts.forEach((node) => {
        node.children.forEach((child) => {
          if (child.name.toLowerCase().startsWith(currentSearch)) {
            candidateNodes.push(child);
          }
        });
      });
    }

    const uniqueResults = new Map<string, FileNode>();
    candidateNodes.forEach((n) => uniqueResults.set(`${n.name}-${n.type}`, n));

    return Array.from(uniqueResults.values()).map((node) =>
      this.createCompletionItem(node, position, currentSearch),
    );
  }

  private findNodesBySequence(
    tree: FileNode[],
    sequence: string[],
  ): FileNode[] {
    const startNodes = this.findAllNodesWithName(tree, sequence[0]);
    let currentMatches: FileNode[] = [];

    startNodes.forEach((startNode) => {
      let walker: FileNode | undefined = startNode;
      for (let i = 1; i < sequence.length; i++) {
        if (!walker) break;
        walker = walker.children.find((child) => child.name === sequence[i]);
      }
      if (walker) currentMatches.push(walker);
    });
    return currentMatches;
  }

  private findAllNodesWithName(nodes: FileNode[], name: string): FileNode[] {
    let found: FileNode[] = [];
    for (const node of nodes) {
      if (node.name === name) found.push(node);
      if (node.children.length > 0) {
        found = [...found, ...this.findAllNodesWithName(node.children, name)];
      }
    }
    return found;
  }

  private searchNodesByName(nodes: FileNode[], search: string): FileNode[] {
    let found: FileNode[] = [];
    for (const node of nodes) {
      if (node.name.toLowerCase().includes(search)) found.push(node);
      if (node.children.length > 0) {
        found = [...found, ...this.searchNodesByName(node.children, search)];
      }
    }
    const seen = new Set();
    return found.filter((node) => {
      const duplicate = seen.has(node.name);
      seen.add(node.name);
      return !duplicate;
    });
  }

  private createCompletionItem(
    node: FileNode,
    position: vscode.Position,
    currentSearch: string,
  ): vscode.CompletionItem {
    const isDir = node.type === "directory";
    // Using our custom class to store the fullPath
    const item = new WlyFileCompletionItem(
      node.name,
      isDir ? vscode.CompletionItemKind.Folder : vscode.CompletionItemKind.File,
      node.fullPath,
      node.type,
    );

    item.insertText = isDir ? node.name + "/" : node.name;

    const pathParts = node.fullPath.split("/");
    if (pathParts.length > 1) {
      item.detail = `in ${pathParts.slice(0, -1).join(" › ")}`;
    }

    const startPos = position.translate(0, -currentSearch.length);
    item.range = new vscode.Range(startPos, position);
    item.sortText = `${isDir ? "0" : "1"}_${node.name}`;

    if (isDir) {
      item.command = {
        command: "editor.action.triggerSuggest",
        title: "Re-trigger",
      };
    }

    return item;
  }

  public resolveCompletionItem(
    item: vscode.CompletionItem,
    token: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.CompletionItem> {
    // Cast to access the stored fullPath
    if (!(item instanceof WlyFileCompletionItem) || item.nodeType !== "file") {
      return item;
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (workspaceFolder) {
      // Correctly join with the full hidden prefix path
      const absolutePath = vscode.Uri.joinPath(
        workspaceFolder.uri,
        item.fullPath,
      );

      const docs = new vscode.MarkdownString();
      docs.supportHtml = true;
      // Properly format the URI for Markdown image syntax
      docs.appendMarkdown(`![Preview](${absolutePath.toString()})`);
      item.documentation = docs;
    }

    return item;
  }
}
