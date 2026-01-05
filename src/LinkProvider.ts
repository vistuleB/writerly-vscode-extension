import * as vscode from "vscode";
import { WriterlyDocumentWalker, LineType } from "./DocumentWalker";
import StaticDocumentValidator from "./StaticValidator";

enum ValidationState {
  UNKNOWN = "unknown",
  OK = "ok",
  ERROR = "error",
}

declare module "vscode" {
  export interface DocumentLink {
    data: { handleName: string; fsPath: string; validated: ValidationState };
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

const HANDLE_START_CHARS: string = "a-zA-Z_";
const HANDLE_BODY_CHARS: string = "-a-zA-Z0-9\\._%\\^\\+";
const HANDLE_END_CHARS: string = "a-zA-Z0-9_\\^";
const HANDLE_REGEX_STRING: string = `([${HANDLE_START_CHARS}][${HANDLE_BODY_CHARS}]*[${HANDLE_END_CHARS}])|[${HANDLE_START_CHARS}]`;
// const DEF_REGEX = new RegExp(`^handle=\\s*(${HANDLE_REGEX_STRING})(:|\\s|$)`);
const DEF_REGEX = new RegExp(
  `^\\s*handle=\\s*(${HANDLE_REGEX_STRING})(:|\\s|$)`,
);
const USAGE_REGEX = new RegExp(`>>(${HANDLE_REGEX_STRING})`, "g");

export class WlyLinkProvider
  implements
    vscode.DocumentLinkProvider,
    vscode.CodeActionProvider,
    vscode.DefinitionProvider,
    vscode.RenameProvider
{
  private definitions: Map<HandleName, HandleDefinition[]> = new Map();
  private parents: FSPath[] = [];
  private diagnosticCollection!: vscode.DiagnosticCollection;
  private isInitialized = false;
  private documentLinks: Map<FSPath, vscode.DocumentLink[]> = new Map();
  private usageCounts: Map<HandleName, number> = new Map();
  private revalidateTimer: NodeJS.Timeout | undefined;

  constructor(context: vscode.ExtensionContext) {
    this.diagnosticCollection =
      vscode.languages.createDiagnosticCollection("writerly-links");
    const disposables = [
      this.diagnosticCollection,
      vscode.workspace.onDidChangeTextDocument((event) =>
        this.onDidChange(event.document),
      ),
      vscode.workspace.onDidRenameFiles((event) => this.onDidRename(event)),
      vscode.workspace.onDidDeleteFiles((event) => this.onDidDelete(event)),
      vscode.workspace.onDidCreateFiles((event) => this.onDidCreate(event)),
      vscode.languages.registerDocumentLinkProvider(
        { scheme: "file", language: "writerly" },
        this,
      ),
      vscode.languages.registerCodeActionsProvider(
        { scheme: "file", language: "writerly" },
        this,
        { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] },
      ),
      vscode.languages.registerDefinitionProvider(
        { scheme: "file", language: "writerly" },
        this,
      ),
      vscode.languages.registerRenameProvider(
        { scheme: "file", language: "writerly" },
        this,
      ),
    ];
    disposables.forEach((disp) => context.subscriptions.push(disp));
    this.initializeAsync();
  }

  private async initializeAsync(): Promise<void> {
    try {
      await this.discoverParentDirectories();
      await this.processAllDocuments();
      this.isInitialized = true;
    } catch (error) {
      console.error("WlyLinkProvider initialization failed:", error);
    }
  }

  private async processAllDocuments(): Promise<void> {
    const uris = await vscode.workspace.findFiles(
      `**/*${FILE_EXTENSION}`,
      null,
      MAX_FILES,
    );

    // process all files and await completion
    await Promise.all(uris.map((uri) => this.processUri(uri)));
  }

  private async discoverParentDirectories(): Promise<void> {
    const parentFiles = await vscode.workspace.findFiles(
      `**/${PARENT_FILE_NAME}`,
      null,
      MAX_FILES,
    );

    this.parents = parentFiles.map((uri) =>
      uri.fsPath.replace(new RegExp(`[/\\\\]${PARENT_FILE_NAME}$`), ""),
    );
  }

  private onDidChange(document: vscode.TextDocument): void {
    if (!this.isWriterlyFile(document.uri.fsPath)) return;
    this.processDocument(document);
  }

  private onDidRename(event: vscode.FileRenameEvent): void {
    for (const file of event.files) {
      if (
        this.isWriterlyFile(file.oldUri.fsPath) &&
        this.isWriterlyFile(file.newUri.fsPath)
      ) {
        this.renameUri(file.oldUri, file.newUri);
      } else if (this.isWriterlyFile(file.oldUri.fsPath)) {
        this.deleteUri(file.oldUri);
      } else if (this.isWriterlyFile(file.newUri.fsPath)) {
        this.createUri(file.newUri);
      }
    }
  }

  private onDidDelete(event: vscode.FileDeleteEvent): void {
    for (const uri of event.files) {
      if (this.isWriterlyFile(uri.fsPath)) {
        this.deleteUri(uri);
      }
    }
  }

  private async onDidCreate(event: vscode.FileCreateEvent): Promise<void> {
    for (const uri of event.files) {
      if (this.isWriterlyFile(uri.fsPath)) {
        await this.createUri(uri);
      }
    }
  }

  // utility methods
  private isWriterlyFile(fsPath: string): boolean {
    return fsPath.endsWith(FILE_EXTENSION);
  }

  private isWriterlyParent(fsPath: string): boolean {
    return fsPath.endsWith(PARENT_FILE_NAME);
  }

  private getParentDirFromFilePath(filePath: string): string {
    return filePath.replace(new RegExp(`[/\\\\]${PARENT_FILE_NAME}$`), "");
  }

  // parent directory management methods
  private handleParentFileCreate(uri: vscode.Uri): void {
    const parentDir = this.getParentDirFromFilePath(uri.fsPath);
    if (!this.parents.includes(parentDir)) {
      this.parents.push(parentDir);
    }
  }

  private handleParentFileDelete(uri: vscode.Uri): void {
    const parentDir = this.getParentDirFromFilePath(uri.fsPath);
    this.parents = this.parents.filter((dir) => dir !== parentDir);
  }

  private async renameUri(
    oldUri: vscode.Uri,
    newUri: vscode.Uri,
  ): Promise<void> {
    const oldPath = oldUri.fsPath;
    const newPath = newUri.fsPath;

    if (this.isWriterlyParent(oldPath)) this.handleParentFileDelete(oldUri);
    if (this.isWriterlyParent(newPath)) this.handleParentFileCreate(newUri);

    for (const [handleName, definitions] of this.definitions) {
      const hasChanges = definitions.some((def) => def.fsPath === oldPath);
      if (hasChanges) {
        const updatedDefinitions = definitions.map((def) =>
          def.fsPath === oldPath ? { ...def, fsPath: newPath } : def,
        );
        this.definitions.set(handleName, updatedDefinitions);
      }
    }
  }

  private deleteUri(uri: vscode.Uri): void {
    const targetPath = uri.fsPath;

    // 1. subtract usages from the global counter before we lose the data
    const cachedLinks = this.documentLinks.get(targetPath);
    if (cachedLinks) {
      cachedLinks.forEach((link) =>
        this.updateUsageCount(link.data.handleName, -1),
      );
    }

    // 2. handle parent directory logic
    if (this.isWriterlyParent(uri.fsPath)) this.handleParentFileDelete(uri);

    // 3. clear definitions from the map
    for (const [handleName, definitions] of this.definitions) {
      const filteredDefinitions = definitions.filter(
        (def) => def.fsPath !== targetPath,
      );

      if (filteredDefinitions.length === 0) {
        this.definitions.delete(handleName);
      } else if (filteredDefinitions.length !== definitions.length) {
        this.definitions.set(handleName, filteredDefinitions);
      }
    }

    // 4. remove from links map
    this.documentLinks.delete(targetPath);

    // 5. trigger tree revalidation to clear warnings in other files
    if (this.isInitialized) {
      this.triggerTreeRevalidation(targetPath);
    }
  }

  private async createUri(uri: vscode.Uri): Promise<void> {
    if (this.isWriterlyParent(uri.fsPath)) this.handleParentFileCreate(uri);
    this.processUri(uri);
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
    document: vscode.TextDocument,
  ): vscode.DocumentLink[] {
    const currentFsPath = document.uri.fsPath;

    // 1. subtract old usages from this specific file before clearing
    const oldLinks = this.documentLinks.get(currentFsPath) || [];
    oldLinks.forEach((link) => this.updateUsageCount(link.data.handleName, -1));

    // 2. standard cleanup and extraction
    this.clearDocumentDefinitions(currentFsPath);
    const diagnostics: vscode.Diagnostic[] = [];
    const documentLinks = this.extractHandlesFromDocument(
      document,
      diagnostics,
    );

    // 3. add new usages to the global counter
    documentLinks.forEach((link) =>
      this.updateUsageCount(link.data.handleName, 1),
    );

    if (this.isInitialized) {
      this.validateHandleUsage(documentLinks, diagnostics);
      this.validateHandleDefinitions(document, diagnostics);

      // 4. trigger the debounced revalidation
      this.triggerTreeRevalidation(currentFsPath);
    }

    this.diagnosticCollection.set(document.uri, diagnostics);
    this.documentLinks.set(currentFsPath, documentLinks);
    return documentLinks;
  }

  private clearDocumentDefinitions(fsPath: string): void {
    for (const [handleName, definitions] of this.definitions) {
      const filteredDefinitions = definitions.filter(
        (def) => def.fsPath !== fsPath,
      );

      if (filteredDefinitions.length === 0) {
        this.definitions.delete(handleName);
      } else if (filteredDefinitions.length !== definitions.length) {
        this.definitions.set(handleName, filteredDefinitions);
      }
    }
  }

  private extractHandlesFromDocument(
    document: vscode.TextDocument,
    diagnostics: vscode.Diagnostic[],
  ): vscode.DocumentLink[] {
    const documentLinks: vscode.DocumentLink[] = [];
    const currentFsPath = document.uri.fsPath;

    let finalState = WriterlyDocumentWalker.walk(
      document,
      (
        _stateBeforeLine,
        lineType,
        _stateAfterLine,
        lineNumber,
        indent,
        content,
      ) => {
        StaticDocumentValidator.validateLine(
          _stateBeforeLine,
          lineType,
          _stateAfterLine,
          lineNumber,
          indent,
          content,
          diagnostics,
        );

        // extract handle definitions
        if (lineType === LineType.Attribute) {
          this.extractHandleDefinition(
            content,
            lineNumber,
            indent,
            currentFsPath,
          );
        }

        // extract handle usage (skip certain line types)
        if (this.shouldProcessUsageInLine(lineType)) {
          const usageLinks = this.extractHandleUsage(
            content,
            lineNumber,
            indent,
            currentFsPath,
          );
          documentLinks.push(...usageLinks);
        }
      },
    );

    StaticDocumentValidator.validateFinalState(
      document,
      finalState,
      diagnostics,
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
    fsPath: string,
  ): void {
    const handleMatch = content.match(DEF_REGEX);
    if (!handleMatch) return;

    const handleName = handleMatch[1];
    const handleStart = content.indexOf(handleMatch[0]);

    const range = new vscode.Range(
      lineNumber,
      indent + handleStart,
      lineNumber,
      indent + handleStart + handleMatch[0].length,
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
    fsPath: string,
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
        indent + matchStart + usageMatch[0].length,
      );

      const link = new vscode.DocumentLink(range);
      link.data = { handleName, fsPath, validated: ValidationState.UNKNOWN };
      links.push(link);
    }

    return links;
  }

  private validateHandleUsage(
    documentLinks: vscode.DocumentLink[],
    diagnostics: vscode.Diagnostic[] = [],
  ): void {
    for (const link of documentLinks) {
      const handleName = link.data?.handleName;
      const currentFsPath = link.data?.fsPath;

      if (!handleName || !currentFsPath) continue;

      const validDefinitions = this.findValidDefinitions(
        handleName,
        currentFsPath,
      );

      if (validDefinitions.length === 1) {
        link.data.validated = ValidationState.OK;
      } else {
        link.data.validated = ValidationState.ERROR;
        const diagnostic = this.createDiagnosticForUsage(
          link,
          handleName,
          validDefinitions,
        );

        if (diagnostic) {
          diagnostics.push(diagnostic);
        }
      }
    }
  }

  private createDiagnosticForUsage(
    link: vscode.DocumentLink,
    handleName: string,
    validDefinitions: HandleDefinition[],
  ): vscode.Diagnostic | null {
    const definitionCount = validDefinitions.length;

    if (definitionCount === 1) {
      return null; // No error
    }

    let message: string;
    if (definitionCount === 0) {
      message = `Handle '${handleName}' not found`;
    } else {
      const locationInfo = validDefinitions
        .map((def) => {
          const relativePath = this.getRelativeWorkspacePath(def.fsPath);
          const lineNumber = def.range.start.line + 1;
          return `${relativePath}:${lineNumber}`;
        })
        .join("\n ");
      message = `Handle '${handleName}' has multiple definitions (${definitionCount} found): \n ${locationInfo}`;
    }

    return new vscode.Diagnostic(
      link.range,
      message,
      vscode.DiagnosticSeverity.Error,
    );
  }

  private getRelativeWorkspacePath(fullPath: string): string {
    if (!vscode.workspace.workspaceFolders) {
      return fullPath.split(/[/\\]/).pop() || fullPath;
    }

    const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
    if (fullPath.startsWith(workspaceRoot)) {
      return fullPath.slice(workspaceRoot.length).replace(/^[/\\]/, "/");
    }

    return fullPath.split(/[/\\]/).pop() || fullPath;
  }

  private findValidDefinitions(
    handleName: string,
    currentFsPath: string,
  ): HandleDefinition[] {
    const definitions = this.definitions.get(handleName);
    if (!definitions || definitions.length === 0) {
      return [];
    }

    return definitions.filter((def) =>
      this.isInSameDocumentTree(currentFsPath, def.fsPath),
    );
  }

  // VS Code interface implementations
  public provideDocumentLinks(
    document: vscode.TextDocument,
    _token: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.DocumentLink[]> {
    let links = this.documentLinks.get(document.uri.fsPath);
    if (links !== undefined) {
      return links.filter(
        (link) => link.data.validated !== ValidationState.ERROR,
      );
    }
    return this.processDocument(document);
  }

  public resolveDocumentLink(
    link: vscode.DocumentLink,
    _token: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.DocumentLink> {
    const handleName = link.data?.handleName;
    const currentFsPath = link.data?.fsPath;

    if (!handleName || !currentFsPath) {
      return undefined;
    }

    const validDefinitions = this.findValidDefinitions(
      handleName,
      currentFsPath,
    );

    if (validDefinitions.length !== 1) {
      return undefined;
    }

    const definition = validDefinitions[0];
    const uri = vscode.Uri.file(definition.fsPath);
    const range = new vscode.Range(
      definition.range.start,
      definition.range.start,
    );
    const targetUri = this.attachRangeToUri(uri, range);

    link.target = targetUri;
    return link;
  }

  public provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext,
    token: vscode.CancellationToken,
  ): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];

    // find diagnostics about multiple definitions
    const multipleDefDiagnostics = context.diagnostics.filter((diagnostic) =>
      diagnostic.message.includes("has multiple definitions"),
    );

    for (const diagnostic of multipleDefDiagnostics) {
      // extract handle name from diagnostic message
      const handleMatch = diagnostic.message.match(
        /Handle '([^']+)' has multiple definitions/,
      );
      if (!handleMatch) continue;

      const handleName = handleMatch[1];
      const validDefinitions = this.findValidDefinitions(
        handleName,
        document.uri.fsPath,
      );

      // create a code action for each definition
      validDefinitions.forEach((def, index) => {
        const relativePath = this.getRelativeWorkspacePath(def.fsPath);
        const lineNumber = def.range.start.line + 1;

        const action = new vscode.CodeAction(
          `Go to definition in ${relativePath}:${lineNumber}`,
          vscode.CodeActionKind.QuickFix,
        );

        let z = def.range.start.translate(0, 7);

        action.command = {
          title: `Go to ${relativePath}:${lineNumber}`,
          command: "vscode.open",
          arguments: [
            vscode.Uri.file(def.fsPath),
            {
              selection: new vscode.Range(z, z),
              preserveFocus: false,
            },
          ],
        };

        action.diagnostics = [diagnostic];
        actions.push(action);
      });
    }

    return actions;
  }

  public provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.Definition> {
    if (!this.isInitialized) {
      return undefined;
    }

    // check if cursor is on a handle usage (>>handleName)
    const line = document.lineAt(position);
    const text = line.text;

    // reset regex and find all usage matches on this line
    USAGE_REGEX.lastIndex = 0;
    let usageMatch;

    while ((usageMatch = USAGE_REGEX.exec(text)) !== null) {
      const matchStart = usageMatch.index;
      const matchEnd = matchStart + usageMatch[0].length;

      // check if cursor position is within this match
      if (position.character >= matchStart && position.character <= matchEnd) {
        const handleName = usageMatch[1];
        return this.getDefinitionForHandle(handleName, document.uri.fsPath);
      }
    }

    return undefined;
  }

  public prepareRename(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): { range: vscode.Range; placeholder: string } | undefined {
    const result = this.getDefinitionOnLine(document, position);

    if (result && result.range.contains(position)) {
      return { range: result.range, placeholder: result.handleName };
    }

    throw new Error(
      "Renaming is only allowed at the definition site (handle=name).",
    );
  }

  public async provideRenameEdits(
    document: vscode.TextDocument,
    position: vscode.Position,
    newName: string,
    token: vscode.CancellationToken,
  ): Promise<vscode.WorkspaceEdit | undefined> {
    // 1. ientify what we are renaming
    const defInfo = this.getDefinitionOnLine(document, position);
    if (!defInfo) return undefined;

    const oldName = defInfo.handleName;
    const workspaceEdit = new vscode.WorkspaceEdit();
    const originFsPath = document.uri.fsPath;

    // 2. iterate through all cached documents
    for (const [fsPath, links] of this.documentLinks) {
      // only rename if within the same logical tree
      if (!this.isInSameDocumentTree(originFsPath, fsPath)) continue;

      const uri = vscode.Uri.file(fsPath);

      // try to find the document if it's currently open to get live text
      const openDoc = vscode.workspace.textDocuments.find(
        (d) => d.uri.fsPath === fsPath,
      );

      // --- PART A: rename call sites (>>oldName) ---
      links.forEach((link) => {
        if (link.data?.handleName === oldName) {
          // determine the line text (from open editor or cache-based logic)
          // note: if doc isn't open, we trust the link.range from our last processDocument
          const nameRange = new vscode.Range(
            link.range.start.line,
            link.range.start.character + 2, // Skip '>>'
            link.range.end.line,
            link.range.end.character,
          );

          // verification check: only apply if the target text matches expectations
          if (openDoc) {
            const actualText = openDoc.getText(link.range);
            if (actualText === `>>${oldName}`) {
              workspaceEdit.replace(uri, nameRange, newName);
            }
          } else {
            // if not open, we apply the edit based on our link cache
            workspaceEdit.replace(uri, nameRange, newName);
          }
        }
      });

      // --- PART B: rename definition sites (handle=oldName) ---
      const defs = this.definitions.get(oldName);
      if (defs) {
        defs.forEach((def) => {
          if (def.fsPath === fsPath) {
            // we anchor the search to the start of the 'handle=' attribute
            // to avoid hitting accidental matches in comments on the same line.
            const lineIndex = def.range.start.line;

            // we skip 'handle=' (7 chars) to get to the name
            const nameStartChar = def.range.start.character + 7;
            const defNameRange = new vscode.Range(
              lineIndex,
              nameStartChar,
              lineIndex,
              nameStartChar + oldName.length,
            );

            workspaceEdit.replace(uri, defNameRange, newName);
          }
        });
      }
    }

    return workspaceEdit;
  }

  private getDefinitionOnLine(
    document: vscode.TextDocument,
    position: vscode.Position,
  ) {
    const line = document.lineAt(position);
    const match = line.text.match(DEF_REGEX);

    if (!match) return undefined;

    const fullMatchText = match[0]; // e.g., "  handle=my_name"
    const handleName = match[1]; // e.g., "my_name"

    // 1. get the start of the whole "handle=name" block
    const matchStart = match.index || 0;

    // 2. find the name within THAT specific match block, not the whole line
    const nameOffsetInMatch = fullMatchText.indexOf(handleName);

    const absoluteNameStart = matchStart + nameOffsetInMatch;

    const range = new vscode.Range(
      position.line,
      absoluteNameStart,
      position.line,
      absoluteNameStart + handleName.length,
    );

    return { handleName, range };
  }

  private getDefinitionForHandle(
    handleName: string,
    currentFsPath: string,
  ): vscode.Definition | undefined {
    const validDefinitions = this.findValidDefinitions(
      handleName,
      currentFsPath,
    );

    // only provide definition for single, unambiguous handles
    if (validDefinitions.length !== 1) {
      return undefined;
    }

    const definition = validDefinitions[0];
    const uri = vscode.Uri.file(definition.fsPath);

    return new vscode.Location(uri, definition.range);
  }

  private attachRangeToUri(uri: vscode.Uri, range: vscode.Range): vscode.Uri {
    const line = range.start.line + 1;
    const character = range.start.character + 1;
    const fragment = `${line},${character}`;
    return uri.with({ fragment });
  }

  private isInSameDocumentTree(
    currentFsPath: string,
    definitionFsPath: string,
  ): boolean {
    if (currentFsPath === definitionFsPath) {
      return true;
    }

    return this.parents.some((parentPath) => {
      const currentUnderParent = this.isPathUnderParent(
        currentFsPath,
        parentPath,
      );
      const definitionUnderParent = this.isPathUnderParent(
        definitionFsPath,
        parentPath,
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

  private validateHandleDefinitions(
    document: vscode.TextDocument,
    diagnostics: vscode.Diagnostic[],
  ): void {
    const currentFsPath = document.uri.fsPath;

    this.definitions.forEach((defs, handleName) => {
      const localDef = defs.find((d) => d.fsPath === currentFsPath);
      if (!localDef) return;

      const globalUsageCount = this.usageCounts.get(handleName) || 0;

      if (globalUsageCount === 0) {
        diagnostics.push(
          new vscode.Diagnostic(
            localDef.range,
            `Unused handle: '${handleName}' is defined but never used.`,
            vscode.DiagnosticSeverity.Warning,
          ),
        );
      }
    });
  }

  private revalidateTree(originFsPath: string): void {
    for (const [fsPath, links] of this.documentLinks) {
      if (!this.isInSameDocumentTree(originFsPath, fsPath)) continue;

      const uri = vscode.Uri.file(fsPath);

      // check if the document is already managed by VS Code
      // before forcing a heavy 'openTextDocument' call.
      const openDoc = vscode.workspace.textDocuments.find(
        (d) => d.uri.fsPath === fsPath,
      );

      if (openDoc) {
        this.updateDiagnosticsForDoc(openDoc, links);
      } else {
        // for closed files, we can't easily re-run 'validateHandleDefinitions'
        // without the doc object, but we can update 'validateHandleUsage'
        // using the cached links.
        const diagnostics: vscode.Diagnostic[] = [];
        this.validateHandleUsage(links, diagnostics);
      }
    }
  }

  private updateDiagnosticsForDoc(
    doc: vscode.TextDocument,
    links: vscode.DocumentLink[],
  ) {
    const diagnostics: vscode.Diagnostic[] = [];
    this.validateHandleUsage(links, diagnostics);
    this.validateHandleDefinitions(doc, diagnostics);
    this.diagnosticCollection.set(doc.uri, diagnostics);
  }

  private triggerTreeRevalidation(originFsPath: string) {
    if (this.revalidateTimer) {
      clearTimeout(this.revalidateTimer);
    }

    this.revalidateTimer = setTimeout(() => {
      // only re-validate files in the same tree
      for (const [fsPath, links] of this.documentLinks) {
        if (this.isInSameDocumentTree(originFsPath, fsPath)) {
          const uri = vscode.Uri.file(fsPath);

          // only update documents that are actually open to save memory/IO
          const openDoc = vscode.workspace.textDocuments.find(
            (d) => d.uri.fsPath === fsPath,
          );
          if (openDoc) {
            const diagnostics: vscode.Diagnostic[] = [];
            this.validateHandleUsage(links, diagnostics);
            this.validateHandleDefinitions(openDoc, diagnostics);
            this.diagnosticCollection.set(uri, diagnostics);
          }
        }
      }
    }, 300); // wait for 300ms of "silence" before running
  }

  // helper to modify counts safely
  private updateUsageCount(handleName: string, delta: number) {
    const current = this.usageCounts.get(handleName) || 0;
    const next = current + delta;
    if (next <= 0) {
      this.usageCounts.delete(handleName);
    } else {
      this.usageCounts.set(handleName, next);
    }
  }
}
