import * as vscode from "vscode";

interface FileNode {
  name: string;
  type: "file" | "directory";
  fullPath: string;
  children: FileNode[];
}

/**
 * Custom CompletionItem that preserves the full path for the resolution phase.
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

  private nameToNodesMap: Map<string, FileNode[]> = new Map();

  private loadFilesTimeout: NodeJS.Timeout | undefined;

  private readonly imgExtensions: string[] = (() => {
    const base = ["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "ipe", "psd", "tiff"];
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

    const watcher = vscode.workspace.createFileSystemWatcher(
      `**/*.{${this.imgExtensions.join(",")}}`,
    );

    // Debounce watcher events to avoid jitter during bulk operations
    const debouncedLoad = () => this.loadFiles();
    watcher.onDidCreate(debouncedLoad);
    watcher.onDidDelete(debouncedLoad);
    // watcher.onDidChange(debouncedLoad);

    context.subscriptions.push(completionItemProvider, watcher);
  }

  /**
   * Rebuilds the tree and the fast-lookup index.
   */
  private async loadFiles(): Promise<void> {
    if (this.loadFilesTimeout) clearTimeout(this.loadFilesTimeout);

    this.loadFilesTimeout = setTimeout(async () => {
      const flatPaths = await this.getAllImageRelativePaths();
      this.fileTree = this.buildFileTree(flatPaths);
      this.rebuildLookupMap();
    }, 300);
  }

  private buildFileTree(paths: string[]): FileNode[] {
    const root: FileNode[] = [];
    for (const path of paths) {
      const parts = path.split("/");
      let currentLevel = root;
      let accumulatedPath = "";

      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        const isFile = i === parts.length - 1;
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
      }
    }
    return root;
  }

  private rebuildLookupMap(): void {
    this.nameToNodesMap.clear();
    const stack: FileNode[] = [...this.fileTree];

    while (stack.length > 0) {
      const node = stack.pop()!;
      const key = node.name.toLowerCase();
      const existing = this.nameToNodesMap.get(key) || [];
      existing.push(node);
      this.nameToNodesMap.set(key, existing);
      if (node.children.length > 0) stack.push(...node.children);
    }
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
      candidateNodes = this.searchNodesByMap(currentSearch);
    } else {
      const matchingContexts = this.findNodesBySequence(lockedSegments);
      for (const node of matchingContexts) {
        for (const child of node.children) {
          if (child.name.toLowerCase().startsWith(currentSearch)) {
            candidateNodes.push(child);
          }
        }
      }
    }

    const uniqueResults = new Map<string, FileNode>();
    for (const n of candidateNodes) {
      uniqueResults.set(`${n.name}-${n.type}`, n);
    }

    return Array.from(uniqueResults.values()).map((node) =>
      this.createCompletionItem(node, position, currentSearch),
    );
  }

  private searchNodesByMap(search: string): FileNode[] {
    const found: FileNode[] = [];
    for (const [name, nodes] of this.nameToNodesMap) {
      if (name.includes(search)) {
        found.push(...nodes);
      }
    }
    const seen = new Set<string>();
    return found.filter((node) => {
      const key = `${node.name}-${node.type}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private findNodesBySequence(sequence: string[]): FileNode[] {
    const startNodes = this.nameToNodesMap.get(sequence[0].toLowerCase()) || [];
    const matches: FileNode[] = [];

    for (const startNode of startNodes) {
      let walker: FileNode | undefined = startNode;
      for (let i = 1; i < sequence.length; i++) {
        const target = sequence[i].toLowerCase();
        walker = walker?.children.find((c) => c.name.toLowerCase() === target);
        if (!walker) break;
      }
      if (walker) matches.push(walker);
    }
    return matches;
  }

  private createCompletionItem(
    node: FileNode,
    position: vscode.Position,
    currentSearch: string,
  ): vscode.CompletionItem {
    const isDir = node.type === "directory";
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
    if (!(item instanceof WlyFileCompletionItem) || item.nodeType !== "file") {
      return item;
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (workspaceFolder) {
      const absolutePath = vscode.Uri.joinPath(
        workspaceFolder.uri,
        item.fullPath,
      );
      const docs = new vscode.MarkdownString();
      docs.supportHtml = true;
      docs.appendMarkdown(`![Preview](${absolutePath.toString()})`);
      item.documentation = docs;
    }

    return item;
  }
}
