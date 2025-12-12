import * as vscode from "vscode";
import { WriterlyDocumentWalker, LineType } from "./walker";

declare module "vscode" {
  export interface DocumentLink {
    data: { handleName: string; fsPath: string };
  }
}

type FSPath = string;
type HandleName = string;

type HandleDefinition = {
  fsPath: FSPath;
  range: vscode.Range;
};

const FILE_EXTENSION: string = ".wly";
const PARENT_FILE_NAME: string = "__parent.wly";
const MAX_FILES: number = 1500;
const DIAGNOSTIC_COLLECTION_NAME: string = "writerly-links";

const HANDLE_START_CHARS: string = "a-zA-Z_"
const HANDLE_BODY_CHARS: string = "-a-zA-Z0-9\\._\\^";
const HANDLE_END_CHARS: string = "a-zA-Z0-9_\\^";
const HANDLE_REGEX_STRING: string = `([${HANDLE_START_CHARS}][${HANDLE_BODY_CHARS}]*[${HANDLE_END_CHARS}])|[${HANDLE_START_CHARS}]`;
const DEF_REGEX = new RegExp(`^handle=\\s*(${HANDLE_REGEX_STRING})(:|\\s|$)`);
const USAGE_REGEX = new RegExp(`>>(${HANDLE_REGEX_STRING})`, "g");

export class WriterlyLinkProvider implements vscode.DocumentLinkProvider {
  private definitions: Map<HandleName, HandleDefinition[]> = new Map();
  private parents: FSPath[] = [];
  private diagnosticCollection!: vscode.DiagnosticCollection;
  private isInitialized = false;

  constructor(context: vscode.ExtensionContext) {
    this.setupDiagnostics(context);
    this.registerEventHandlers(context);
    this.initializeAsync();
  }

  private setupDiagnostics(context: vscode.ExtensionContext): void {
    this.diagnosticCollection = vscode.languages.createDiagnosticCollection(
      DIAGNOSTIC_COLLECTION_NAME
    );
    context.subscriptions.push(this.diagnosticCollection);
  }

  private registerEventHandlers(context: vscode.ExtensionContext): void {
    const subscriptions = [
      vscode.workspace.onDidChangeTextDocument((event) =>
        this.onDidChange(event.document)
      ),
      vscode.workspace.onDidRenameFiles((event) => this.onDidRename(event)),
      vscode.workspace.onDidDeleteFiles((event) => this.onDidDelete(event)),
      vscode.workspace.onDidCreateFiles((event) => this.onDidCreate(event)),
      vscode.languages.registerDocumentLinkProvider(
        { scheme: "file", language: "writerly" },
        this
      ),
    ];

    subscriptions.forEach((sub) => context.subscriptions.push(sub));
  }

  private async initializeAsync(): Promise<void> {
    try {
      await this.discoverParentDirectories();
      await this.processAllDocuments();
      this.isInitialized = true;
    } catch (error) {
      console.error("WriterlyLinkProvider initialization failed:", error);
    }
  }

  private async processAllDocuments(): Promise<void> {
    const uris = await vscode.workspace.findFiles(
      `**/*${FILE_EXTENSION}`,
      null,
      MAX_FILES
    );

    // process all files and await completion
    await Promise.all(uris.map((uri) => this.processUri(uri)));
  }

  private async discoverParentDirectories(): Promise<void> {
    const parentFiles = await vscode.workspace.findFiles(
      `**/${PARENT_FILE_NAME}`,
      null,
      MAX_FILES
    );

    this.parents = parentFiles.map((uri) =>
      uri.fsPath.replace(
        new RegExp(`[/\\\\]${PARENT_FILE_NAME}$`),
        ""
      )
    );
  }

  // event handlers
  private onDidChange(document: vscode.TextDocument): void {
    if (!this.isWriterlyFile(document.uri.fsPath)) return;
    this.processDocument(document);
  }

  private onDidRename(event: vscode.FileRenameEvent): void {
    const writerlyFiles = event.files.filter((file) =>
      this.isWriterlyFile(file.oldUri.fsPath)
    );

    writerlyFiles.forEach((file) => this.renameUri(file.oldUri, file.newUri));
  }

  private onDidDelete(event: vscode.FileDeleteEvent): void {
    const writerlyFiles = event.files.filter((uri) =>
      this.isWriterlyFile(uri.fsPath)
    );

    writerlyFiles.forEach((uri) => this.deleteUri(uri));
  }

  private async onDidCreate(event: vscode.FileCreateEvent): Promise<void> {
    const writerlyFiles = event.files.filter((uri) =>
      this.isWriterlyFile(uri.fsPath)
    );

    await Promise.all(writerlyFiles.map((uri) => this.processUri(uri)));
  }

  // utility methods
  private isWriterlyFile(fsPath: string): boolean {
    return fsPath.endsWith(FILE_EXTENSION);
  }

  private async renameUri(
    oldUri: vscode.Uri,
    newUri: vscode.Uri
  ): Promise<void> {
    const oldPath = oldUri.fsPath;
    const newPath = newUri.fsPath;

    for (const [handleName, definitions] of this.definitions) {
      const hasChanges = definitions.some((def) => def.fsPath === oldPath);

      if (hasChanges) {
        const updatedDefinitions = definitions.map((def) =>
          def.fsPath === oldPath ? { ...def, fsPath: newPath } : def
        );
        this.definitions.set(handleName, updatedDefinitions);
      }
    }
  }

  private deleteUri(uri: vscode.Uri): void {
    const targetPath = uri.fsPath;

    for (const [handleName, definitions] of this.definitions) {
      const filteredDefinitions = definitions.filter(
        (def) => def.fsPath !== targetPath
      );

      if (filteredDefinitions.length === 0) {
        this.definitions.delete(handleName);
      } else if (filteredDefinitions.length !== definitions.length) {
        this.definitions.set(handleName, filteredDefinitions);
      }
    }
  }

  private async processUri(uri: vscode.Uri): Promise<void> {
    try {
      const document = await vscode.workspace.openTextDocument(uri);
      this.processDocument(document);
    } catch (error) {
      console.error(`Failed to process document ${uri.fsPath}:`, error);
    }
  }

  private processDocument(
    document: vscode.TextDocument
  ): vscode.DocumentLink[] {
    const currentFsPath = document.uri.fsPath;

    // clear existing definitions for this document
    this.clearDocumentDefinitions(currentFsPath);

    // extract definitions and usage
    const documentLinks = this.extractHandlesFromDocument(document);

    // only validate if initialization is complete
    if (this.isInitialized) {
      this.validateHandleUsage(document, documentLinks);
    }

    return documentLinks;
  }

  private clearDocumentDefinitions(fsPath: string): void {
    for (const [handleName, definitions] of this.definitions) {
      const filteredDefinitions = definitions.filter(
        (def) => def.fsPath !== fsPath
      );

      if (filteredDefinitions.length === 0) {
        this.definitions.delete(handleName);
      } else if (filteredDefinitions.length !== definitions.length) {
        this.definitions.set(handleName, filteredDefinitions);
      }
    }
  }

  private extractHandlesFromDocument(
    document: vscode.TextDocument
  ): vscode.DocumentLink[] {
    const documentLinks: vscode.DocumentLink[] = [];
    const currentFsPath = document.uri.fsPath;

    WriterlyDocumentWalker.walk(
      document,
      (
        _stateBeforeLine,
        lineType,
        _stateAfterLine,
        lineNumber,
        indent,
        content
      ) => {
        // extract handle definitions
        if (lineType === LineType.Attribute) {
          this.extractHandleDefinition(
            content,
            lineNumber,
            indent,
            currentFsPath
          );
        }

        // extract handle usage (skip certain line types)
        if (this.shouldProcessUsageInLine(lineType)) {
          const usageLinks = this.extractHandleUsage(
            content,
            lineNumber,
            indent,
            currentFsPath
          );
          documentLinks.push(...usageLinks);
        }
      }
    );

    return documentLinks;
  }

  private shouldProcessUsageInLine(lineType: LineType): boolean {
    return (
      lineType !== LineType.CodeBlockLine &&
      lineType !== LineType.Tag &&
      lineType !== LineType.CodeBlockClosing
    );
  }

  private extractHandleDefinition(
    content: string,
    lineNumber: number,
    indent: number,
    fsPath: string
  ): void {
    const handleMatch = content.match(DEF_REGEX);
    if (!handleMatch) return;

    const handleName = handleMatch[1];
    const handleStart = content.indexOf(handleMatch[0]);

    const range = new vscode.Range(
      lineNumber,
      indent + handleStart,
      lineNumber,
      indent + handleStart + handleMatch[0].length
    );

    const definition: HandleDefinition = { fsPath, range };

    if (!this.definitions.has(handleName)) {
      this.definitions.set(handleName, []);
    }
    this.definitions.get(handleName)!.push(definition);
  }

  private extractHandleUsage(
    content: string,
    lineNumber: number,
    indent: number,
    fsPath: string
  ): vscode.DocumentLink[] {
    const links: vscode.DocumentLink[] = [];
    let usageMatch;

    USAGE_REGEX.lastIndex = 0;

    while ((usageMatch = USAGE_REGEX.exec(content)) !== null) {
      const handleName = usageMatch[1];
      const matchStart = usageMatch.index;

      const range = new vscode.Range(
        lineNumber,
        indent + matchStart,
        lineNumber,
        indent + matchStart + usageMatch[0].length
      );

      const link = new vscode.DocumentLink(range);
      link.data = { handleName, fsPath };
      links.push(link);
    }

    return links;
  }

  private validateHandleUsage(
    document: vscode.TextDocument,
    documentLinks: vscode.DocumentLink[]
  ): void {
    const diagnostics: vscode.Diagnostic[] = [];

    for (const link of documentLinks) {
      const handleName = link.data?.handleName;
      const currentFsPath = link.data?.fsPath;

      if (!handleName || !currentFsPath) continue;

      const validDefinitions = this.findValidDefinitions(
        handleName,
        currentFsPath
      );
      const diagnostic = this.createDiagnosticForUsage(
        link,
        handleName,
        validDefinitions.length
      );

      if (diagnostic) {
        diagnostics.push(diagnostic);
      }
    }

    this.diagnosticCollection.set(document.uri, diagnostics);
  }

  private createDiagnosticForUsage(
    link: vscode.DocumentLink,
    handleName: string,
    definitionCount: number
  ): vscode.Diagnostic | null {
    if (definitionCount === 1) {
      return null; // No error
    }

    const message =
      definitionCount === 0
        ? `Handle '${handleName}' not found`
        : `Handle '${handleName}' has multiple definitions (${definitionCount} found)`;

    return new vscode.Diagnostic(
      link.range,
      message,
      vscode.DiagnosticSeverity.Error
    );
  }

  private findValidDefinitions(
    handleName: string,
    currentFsPath: string
  ): HandleDefinition[] {
    const definitions = this.definitions.get(handleName);
    if (!definitions || definitions.length === 0) {
      return [];
    }

    return definitions.filter((def) =>
      this.isInSameDocumentTree(currentFsPath, def.fsPath)
    );
  }

  // VS Code interface implementations
  public provideDocumentLinks(
    document: vscode.TextDocument,
    _token: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.DocumentLink[]> {
    return this.processDocument(document);
  }

  public resolveDocumentLink(
    link: vscode.DocumentLink,
    _token: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.DocumentLink> {
    const handleName = link.data?.handleName;
    const currentFsPath = link.data?.fsPath;

    if (!handleName || !currentFsPath) {
      return undefined;
    }

    const validDefinitions = this.findValidDefinitions(
      handleName,
      currentFsPath
    );

    if (validDefinitions.length !== 1) {
      return undefined;
    }

    const definition = validDefinitions[0];
    const uri = vscode.Uri.file(definition.fsPath);
    const targetUri = this.attachRangeToUri(uri, definition.range);

    link.target = targetUri;
    return link;
  }

  private attachRangeToUri(uri: vscode.Uri, range: vscode.Range): vscode.Uri {
    const line = range.start.line + 1;
    const character = range.start.character + 1;
    const fragment = `${line},${character}`;
    return uri.with({ fragment });
  }

  private isInSameDocumentTree(
    currentFsPath: string,
    definitionFsPath: string
  ): boolean {
    if (currentFsPath === definitionFsPath) {
      return true;
    }

    return this.parents.some((parentPath) => {
      const currentUnderParent = this.isPathUnderParent(
        currentFsPath,
        parentPath
      );
      const definitionUnderParent = this.isPathUnderParent(
        definitionFsPath,
        parentPath
      );
      return currentUnderParent && definitionUnderParent;
    });
  }

  private isPathUnderParent(filePath: string, parentPath: string): boolean {
    return (
      filePath === parentPath ||
      filePath.startsWith(parentPath + "/") ||
      filePath.startsWith(parentPath + "\\")
    );
  }
}
