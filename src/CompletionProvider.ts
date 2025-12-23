import * as vscode from "vscode";

export class WlyCompletionProvider implements vscode.CompletionItemProvider {
  private files: string[] = [];
  private imgExtensions: string[] = (() => {
    const extensions = [
      "png",
      "jpg",
      "jpeg",
      "gif",
      "svg",
      "webp",
      "bmp",
      "ipe",
    ];
    const capitalized = extensions.map((s) => s.toUpperCase());
    return [...extensions, ...capitalized];
  })();

  constructor(context: vscode.ExtensionContext) {
    this.loadFiles();
    const completionItemProvider =
      vscode.languages.registerCompletionItemProvider(
        { scheme: "file", language: "writerly" },
        this,
        "=", // Trigger on equals sign
      );

    context.subscriptions.push(completionItemProvider);

    // Watcher
    const imgExtensionsPattern = this.imgExtensions.join(",");
    const watcher = vscode.workspace.createFileSystemWatcher(
      `**/*.{${imgExtensionsPattern}}`,
    );
    // Update the files list whenever files change
    watcher.onDidCreate(() => this.loadFiles());
    watcher.onDidDelete(() => this.loadFiles());
    watcher.onDidChange(() => this.loadFiles());

    context.subscriptions.push(watcher);
  }

  private async loadFiles(): Promise<void> {
    this.files = await this.getAllImageRelativePaths();
  }

  private async getAllImageRelativePaths(): Promise<string[]> {
    const excludePattern = "{**/node_modules/**,**/build/**,**/.*/**,**/.*}";
    const imgExtensionsPattern = this.imgExtensions.join(",");
    // Find all files in the workspace (excluding node_modules, build, and dot file and directories)
    // findFiles(includePattern, excludePattern, maxResults?)
    const files = await vscode.workspace.findFiles(
      `**/*.{${imgExtensionsPattern}}`,
      excludePattern,
    );

    // Map the resulting Uris to relative strings
    const relativePaths = files.map((file) => {
      // includeWorkspaceFolder: false returns "img/1.svg"
      // includeWorkspaceFolder: true returns "my-project/img/1.svg"
      return vscode.workspace.asRelativePath(file, false);
    });

    return relativePaths;
  }

  public provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
    context: vscode.CompletionContext,
  ): vscode.ProviderResult<vscode.CompletionItem[]> {
    // Get the text of the current line up to the cursor
    const linePrefix = document
      .lineAt(position)
      .text.substring(0, position.character);

    // Check if the line ends with 'src=' or 'original='
    // This regex looks for 'src=' or 'original=' directly before the cursor
    const triggerRegex = /\b(src|original)=\S*$/;
    if (!triggerRegex.test(linePrefix)) {
      return undefined;
    }

    const completionItems: vscode.CompletionItem[] = this.files.map((file) =>
      this.toCompletionItem(file),
    );

    return completionItems;
  }

  public resolveCompletionItem(
    item: vscode.CompletionItem,
    token: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.CompletionItem> {
    const relativePath =
      typeof item.label === "string" ? item.label : item.label.label;

    // Check if the file is an image BEFORE generating preview
    if (!this.isImageFile(relativePath)) {
      return item;
    }

    // Find the absolute path
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (workspaceFolder) {
      const absolutePath = vscode.Uri.joinPath(
        workspaceFolder.uri,
        relativePath,
      );

      // Attach the documentation preview
      const docs = new vscode.MarkdownString();
      docs.supportHtml = true;

      // Use the absolute URI for the markdown image source
      docs.appendMarkdown(`![Preview](${absolutePath.toString()}|width=250)`);

      item.documentation = docs;
    }

    return item;
  }

  private isImageFile(path: string): boolean {
    const imageExtensions = [
      "png",
      "jpg",
      "jpeg",
      "gif",
      "svg",
      "webp",
      "bmp",
      "ipe",
    ];
    const extension = path.split(".").pop()?.toLowerCase();
    return !!extension && imageExtensions.includes(extension);
  }

  private toCompletionItem(file: string): vscode.CompletionItem {
    const completionItem = new vscode.CompletionItem(file);
    completionItem.kind = vscode.CompletionItemKind.File;
    completionItem.insertText = this.normalize_path(file);

    return completionItem;
  }

  private normalize_path(path: string): string {
    // truncate anything that appears before "img", "images" or "image"
    // `public/img/1.svg` becomes `img/1.svg`
    const pattern = "^.*?\/(images?|img)\/";
    const normalized = path.replace(new RegExp(pattern), "$1/"); // `/` is important it appends after an "(images?|img)"

    return normalized;
  }
}
