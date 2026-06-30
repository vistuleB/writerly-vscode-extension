import * as vscode from "vscode";
import * as path from "path";
import { isWriterlyFilePath } from "./WriterlyFileExtensions";
import { LineType, WriterlyDocumentWalker } from "./WriterlyDocumentWalker";
import { fileUtils } from "./utils/file-utils";

interface FileNode {
  name: string;
  type: "file" | "directory";
  fullPath: string;
  uri?: vscode.Uri;
  children: FileNode[];
}

type IndexedPath = {
  relativePath: string;
  uri: vscode.Uri;
};

type PathCompletionContext = {
  fullTypedPath: string;
};

const PATH_COMPLETION_TRIGGER_CHARACTERS = [
  "=",
  " ",
  "/",
  "(",
  ".",
  "-",
  "_",
];
const FILENAME_CHARACTER_PATTERN = /^[A-Za-z0-9._-]$/;
const PATH_ATTRIBUTE_NAMES = new Set([
  "original",
  "href",
  "srcset",
  "poster",
  "data",
  "background",
  "icon",
  "favicon",
  "image",
  "logo",
  "thumbnail",
  "preview",
  "cover",
  "file",
  "path",
  "url",
  "uri",
  "source",
  "use",
]);

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

  constructor(context: vscode.ExtensionContext) {
    this.loadFiles();

    const completionItemProvider =
      vscode.languages.registerCompletionItemProvider(
        { scheme: "file", language: "writerly" },
        this,
        ...PATH_COMPLETION_TRIGGER_CHARACTERS,
      );

    const watcher = vscode.workspace.createFileSystemWatcher(
      "**/*",
    );

    // Debounce watcher events to avoid jitter during bulk operations
    const debouncedLoad = () => this.loadFiles();
    watcher.onDidCreate(debouncedLoad);
    watcher.onDidDelete(debouncedLoad);
    // watcher.onDidChange(debouncedLoad);

    const retriggerPathCompletion =
      vscode.workspace.onDidChangeTextDocument((event) => {
        this.retriggerPathCompletionAfterFilenameCharacter(event);
      });

    context.subscriptions.push(
      completionItemProvider,
      watcher,
      retriggerPathCompletion,
    );
  }

  /**
   * Clears the file cache and rebuilds the file tree immediately.
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
    const indexedPaths = await this.getAllIndexedPaths();
    this.fileTree = this.buildFileTree(indexedPaths);
    this.rebuildLookupMap();
  }

  /**
   * Rebuilds the tree and the fast-lookup index.
   */
  private async loadFiles(): Promise<void> {
    if (this.loadFilesTimeout) clearTimeout(this.loadFilesTimeout);

    this.loadFilesTimeout = setTimeout(async () => {
      const indexedPaths = await this.getAllIndexedPaths();
      this.fileTree = this.buildFileTree(indexedPaths);
      this.rebuildLookupMap();
    }, 300);
  }

  private buildFileTree(paths: IndexedPath[]): FileNode[] {
    const root: FileNode[] = [];
    for (const indexedPath of paths) {
      const parts = indexedPath.relativePath.split("/");
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
            uri: isFile ? indexedPath.uri : undefined,
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

  private async getAllIndexedPaths(): Promise<IndexedPath[]> {
    const excludePattern =
      "{**/node_modules/**,**/dist/**,**/build/**,**/.*/**,**/.*}";
    const files = await vscode.workspace.findFiles(
      "**/*",
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
    const linePrefix = document
      .lineAt(position)
      .text.substring(0, position.character);

    const attributeMatch = linePrefix.match(
      /(?:^|\s)([A-Za-z0-9_.:-]+)=\s*(\S*)$/,
    );
    if (attributeMatch) {
      if (!this.isPathAttributeName(attributeMatch[1])) return undefined;

      const lineType = WriterlyDocumentWalker.onTheFlyLineClassification(
        document,
        position,
      );
      return lineType === LineType.Attribute
        ? { fullTypedPath: attributeMatch[2] }
        : undefined;
    }

    const markdownLinkMatch = linePrefix.match(/!?\[[^\]]*\]\(([^)\s]*)$/);
    if (markdownLinkMatch) {
      const lineType = WriterlyDocumentWalker.onTheFlyLineClassification(
        document,
        position,
      );
      return lineType === LineType.Text
        ? { fullTypedPath: markdownLinkMatch[1] }
        : undefined;
    }

    return undefined;
  }

  private isPathAttributeName(attributeName: string): boolean {
    const normalized = attributeName.toLowerCase();
    return normalized.endsWith("src") || PATH_ATTRIBUTE_NAMES.has(normalized);
  }

  private retriggerPathCompletionAfterFilenameCharacter(
    event: vscode.TextDocumentChangeEvent,
  ): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document !== event.document) return;
    if (!isWriterlyFilePath(event.document.uri.fsPath)) return;
    if (event.contentChanges.length !== 1) return;

    const change = event.contentChanges[0];
    if (!FILENAME_CHARACTER_PATTERN.test(change.text)) return;

    const position = change.range.start.translate(0, change.text.length);
    if (!this.getPathCompletionContext(event.document, position)) return;

    void vscode.commands.executeCommand("editor.action.triggerSuggest");
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

    if (item.uri && fileUtils.isImageFile(item.uri.fsPath)) {
      const docs = new vscode.MarkdownString();
      docs.supportHtml = true;
      docs.appendMarkdown(`![Preview](${item.uri.toString()})`);
      item.documentation = docs;
    }

    return item;
  }
}
