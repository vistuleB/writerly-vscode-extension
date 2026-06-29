import * as vscode from "vscode";
import * as path from "path";
import { isWriterlyFilePath } from "./WriterlyFileExtensions";
import { LineType, WriterlyDocumentWalker } from "./WriterlyDocumentWalker";
import { SUPPORTED_IMAGE_FILE_EXTENSIONS } from "./utils/file-utils";

interface FileNode {
  name: string;
  type: "file" | "directory";
  fullPath: string;
  uri?: vscode.Uri;
  children: FileNode[];
}

type ImagePath = {
  relativePath: string;
  uri: vscode.Uri;
};

type PathCompletionContext = {
  fullTypedPath: string;
};

/**
 * Custom CompletionItem that preserves the full path for the resolution phase.
 */
class WriterlyFileCompletionItem extends vscode.CompletionItem {
  constructor(
    public label: string,
    public kind: vscode.CompletionItemKind,
    public fullPath: string,
    public nodeType: "file" | "directory",
    public uri: vscode.Uri | undefined,
  ) {
    super(label, kind);
  }
}

export class WriterlyCompletionProvider
  implements vscode.CompletionItemProvider
{
  private fileTree: FileNode[] = [];
  private nameToNodesMap: Map<string, FileNode[]> = new Map();
  private loadFilesTimeout: NodeJS.Timeout | undefined;
  private readonly imgExtensions: string[] = [
    ...SUPPORTED_IMAGE_FILE_EXTENSIONS,
    ...SUPPORTED_IMAGE_FILE_EXTENSIONS.map((ext) => ext.toUpperCase()),
  ];

  constructor(context: vscode.ExtensionContext) {
    this.loadFiles();

    const completionItemProvider =
      vscode.languages.registerCompletionItemProvider(
        { scheme: "file", language: "writerly" },
        this,
        "=",
        " ",
        "/",
        "(",
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
   * Clears the image cache and rebuilds the file tree immediately.
   * Called by the WriterlyController.
   */
  public async reset(): Promise<void> {
    // 1. Cancel any pending debounced loads
    if (this.loadFilesTimeout) {
      clearTimeout(this.loadFilesTimeout);
      this.loadFilesTimeout = undefined;
    }

    // 2. Clear current state
    this.fileTree = [];
    this.nameToNodesMap.clear();

    // 3. Re-index immediately (without the 300ms delay)
    const imagePaths = await this.getAllImagePaths();
    this.fileTree = this.buildFileTree(imagePaths);
    this.rebuildLookupMap();
  }

  /**
   * Rebuilds the tree and the fast-lookup index.
   */
  private async loadFiles(): Promise<void> {
    if (this.loadFilesTimeout) clearTimeout(this.loadFilesTimeout);

    this.loadFilesTimeout = setTimeout(async () => {
      const imagePaths = await this.getAllImagePaths();
      this.fileTree = this.buildFileTree(imagePaths);
      this.rebuildLookupMap();
    }, 300);
  }

  private buildFileTree(paths: ImagePath[]): FileNode[] {
    const root: FileNode[] = [];
    for (const imagePath of paths) {
      const parts = imagePath.relativePath.split("/");
      let currentLevel = root;
      let accumulatedPath = "";

      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        const isFile = i === parts.length - 1;
        accumulatedPath = accumulatedPath ? `${accumulatedPath}/${part}` : part;

        let existingNode = isFile
          ? undefined
          : currentLevel.find((node) => node.name === part);
        if (!existingNode) {
          existingNode = {
            name: part,
            type: isFile ? "file" : "directory",
            fullPath: accumulatedPath,
            uri: isFile ? imagePath.uri : undefined,
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

  private async getAllImagePaths(): Promise<ImagePath[]> {
    const excludePattern = "{**/node_modules/**,**/build/**,**/.*/**,**/.*}";
    const files = await vscode.workspace.findFiles(
      `**/*.{${this.imgExtensions.join(",")}}`,
      excludePattern,
    );
    return files.map((file) => ({
      relativePath: vscode.workspace.asRelativePath(file, false),
      uri: file,
    }));
  }

  public provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.ProviderResult<vscode.CompletionItem[]> {
    if (!isWriterlyFilePath(document.uri.fsPath)) {
      return undefined;
    }

    const completionContext = this.getPathCompletionContext(
      document,
      position,
    );
    if (!completionContext) return undefined;

    const fullTypedPath = completionContext.fullTypedPath;
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

    const sortedNodes = this.sortNodesByCloseness(
      this.dedupeCandidateNodes(candidateNodes),
      document.uri.fsPath,
    );
    return sortedNodes.map((node) =>
      this.createCompletionItem(node, position, currentSearch),
    );
  }

  private getPathCompletionContext(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): PathCompletionContext | undefined {
    const lineType = WriterlyDocumentWalker.onTheFlyLineClassification(
      document,
      position,
    );
    const linePrefix = document
      .lineAt(position)
      .text.substring(0, position.character);

    if (lineType === LineType.Attribute) {
      const match = linePrefix.match(/\b(src|original)=\s*(\S*)$/);
      return match ? { fullTypedPath: match[2] } : undefined;
    }

    if (lineType === LineType.Text) {
      const match = linePrefix.match(/!\[[^\]]*\]\(([^)\s]*)$/);
      return match ? { fullTypedPath: match[1] } : undefined;
    }

    return undefined;
  }

  private searchNodesByMap(search: string): FileNode[] {
    const found: FileNode[] = [];
    for (const [name, nodes] of this.nameToNodesMap) {
      if (name.includes(search)) {
        found.push(...nodes);
      }
    }
    return found;
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

  private dedupeCandidateNodes(nodes: FileNode[]): FileNode[] {
    const seen = new Set<string>();
    return nodes.filter((node) => {
      const key = node.uri?.fsPath ?? `${node.type}:${node.fullPath}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private sortNodesByCloseness(
    nodes: FileNode[],
    currentFsPath: string,
  ): FileNode[] {
    return [...nodes].sort((a, b) => {
      const closenessDelta =
        this.commonAncestorDepth(b.uri?.fsPath, currentFsPath) -
        this.commonAncestorDepth(a.uri?.fsPath, currentFsPath);
      if (closenessDelta !== 0) return closenessDelta;
      return a.fullPath.localeCompare(b.fullPath);
    });
  }

  private commonAncestorDepth(
    candidateFsPath: string | undefined,
    currentFsPath: string,
  ): number {
    if (!candidateFsPath) return -1;

    const candidateParts = path.dirname(candidateFsPath).split(path.sep);
    const currentParts = path.dirname(currentFsPath).split(path.sep);
    let depth = 0;

    while (
      depth < candidateParts.length &&
      depth < currentParts.length &&
      candidateParts[depth] === currentParts[depth]
    ) {
      depth++;
    }

    return depth;
  }

  private createCompletionItem(
    node: FileNode,
    position: vscode.Position,
    currentSearch: string,
  ): vscode.CompletionItem {
    const isDir = node.type === "directory";
    const item = new WriterlyFileCompletionItem(
      node.name,
      isDir ? vscode.CompletionItemKind.Folder : vscode.CompletionItemKind.File,
      node.fullPath,
      node.type,
      node.uri,
    );

    item.insertText = isDir ? node.name + "/" : node.name;

    const pathParts = node.fullPath.split("/");
    if (pathParts.length > 1) {
      item.detail = `in ${pathParts.slice(0, -1).join(" › ")}`;
    }
    const workspaceFolder = node.uri
      ? vscode.workspace.getWorkspaceFolder(node.uri)
      : undefined;
    if (workspaceFolder) {
      item.detail = item.detail
        ? `${item.detail} (${workspaceFolder.name})`
        : `in ${workspaceFolder.name}`;
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
    _token: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.CompletionItem> {
    if (
      !(item instanceof WriterlyFileCompletionItem) ||
      item.nodeType !== "file"
    ) {
      return item;
    }

    if (item.uri) {
      const docs = new vscode.MarkdownString();
      docs.supportHtml = true;
      docs.appendMarkdown(`![Preview](${item.uri.toString()})`);
      item.documentation = docs;
    }

    return item;
  }
}
