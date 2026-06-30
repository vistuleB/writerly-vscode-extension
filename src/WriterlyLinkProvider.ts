import * as vscode from "vscode";
import * as path from "path";
import { WriterlyDocumentWalker, LineType } from "./WriterlyDocumentWalker";
import WriterlyStaticValidator from "./WriterlyStaticValidator";
import {
  ALL_WRITERLY_FILE_GLOB,
  getWriterlyFileGlob,
  isWriterlyFilePath,
} from "./WriterlyFileExtensions";
import {
  discoverWriterlyDocumentRoots,
  getDocumentTreeKeys,
  isInSameWriterlyDocumentTree,
} from "./WriterlyDocumentTrees";

/*
 * WriterlyLinkProvider currently owns the handle subsystem end to end.
 *
 * Maintained state:
 * - definitions: maps each handle name to every definition range currently
 *   indexed in active Writerly files. Multiple definitions are allowed in the
 *   raw cache; diagnostics and navigation resolve ambiguity later within the
 *   caller's document-tree scope.
 * - documentLinks: maps each file path to the handle-usage links extracted
 *   from that file. Each link stores the handle name, source file path, and
 *   current validation state so link rendering, diagnostics, rename, and usage
 *   counts all work from the same extracted usage data.
 * - usageCounts: maps each handle name to usage counts per document tree.
 *   Counts are updated when a file is reprocessed so unused-handle diagnostics
 *   stay scoped to the same assemblable document roots as definitions.
 * - documentRoots: stores extension document roots. A directory is a root when
 *   it contains at least one direct .wly file; editor semantics intentionally
 *   ignore # path segments.
 * - diagnosticCollection: owns all handle and syntax diagnostics reported by
 *   this provider; diagnostics are replaced per file after reprocessing.
 * - isInitialized/revalidateTimer: prevent premature provider work and debounce
 *   tree-wide revalidation after file creates/deletes/renames that can change
 *   assemblable roots.
 *
 * Features provided:
 * - Workspace indexing:
 *   - discovers active Writerly files and assemblable root directories
 *   - walks documents to extract handle definitions and usages
 *   - updates caches from file-system events and open-document changes
 * - Document-tree scoping:
 *   - resolves whether files can be assembled into the same document
 *   - filters definitions and usage counts to those document roots
 * - Editor navigation:
 *   - DocumentLinkProvider renders >>handle usages as clickable editor links
 *   - DefinitionProvider resolves F12 targets for visible, unambiguous handles
 * - Rename support:
 *   - RenameProvider renames handle attribute definitions, in-text definitions,
 *     and usages across the current document tree
 *   - non-handle rename positions return undefined so other RenameProviders can
 *     handle other Writerly rename targets, such as file paths
 * - Completion support:
 *   - CompletionItemProvider offers visible handle names after >>
 * - Diagnostics and quick fixes:
 *   - runs WriterlyStaticValidator while walking documents
 *   - reports invalid handle names, unresolved usages, duplicate definitions,
 *     and optionally unused definitions
 *   - CodeActionProvider offers quick fixes for unresolved handle diagnostics
 *
 * These domains share the same definition/link/scope caches, so they remain in
 * one file for now. Future factoring can split the index/cache, document-tree
 * scope resolution, diagnostics, and VS Code provider adapters.
 */

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
type DocumentTreeKey = string;
type UsageCounts = Map<HandleName, Map<DocumentTreeKey, number>>;

type HandleDefinition = {
  fsPath: FSPath;
  range: vscode.Range;
};

type HandleAtPosition = {
  handleName: HandleName;
  range: vscode.Range;
};

const MAX_FILES: number = 1500;

const HANDLE_CHARS: string = "\\p{L}\\p{N}\\p{M}_.:\\-\\^";
const HANDLE_END_CHARS: string = "\\p{L}\\p{N}\\p{M}_\\^";
const HANDLE_REGEX_STRING: string = `(?:[${HANDLE_CHARS}]*[${HANDLE_END_CHARS}])`;
const HANDLE_DEF_RENAME_REGEX = new RegExp(
  `^\\s*(?:!!\\s*)?handle=\\s*(${HANDLE_REGEX_STRING})(#|\\s|$)`,
  "u",
);
const USAGE_REGEX = new RegExp(`>>(${HANDLE_REGEX_STRING})`, "gu");
const LOOSE_DEF_REGEX = /^handle=\s*([^\s#|]+)/u;

// Decorator chars are HANDLE_CHARS minus '.' and '^'
const HANDLE_DECORATOR_CHARS: string = "\\p{L}\\p{N}\\p{M}_:\\-";
const HANDLE_DECORATOR_REGEX_STRING: string = `#[${HANDLE_DECORATOR_CHARS}]+`;
const HANDLE_DECORATORS_REGEX_STRING: string = `(?:${HANDLE_DECORATOR_REGEX_STRING})*`;
// Matches "handleName[decorators]##<<" at start of content or preceded by space, '{', '(', or '['
const IN_TEXT_DEF_REGEX = new RegExp(
  `(?:^|[ {(\\[])(${HANDLE_REGEX_STRING})(${HANDLE_DECORATORS_REGEX_STRING})##<<`,
  "gu",
);

export class WriterlyLinkProvider
  implements
    vscode.DocumentLinkProvider,
    vscode.CodeActionProvider,
    vscode.DefinitionProvider,
    vscode.RenameProvider,
    vscode.CompletionItemProvider
{
  private definitions: Map<HandleName, HandleDefinition[]> = new Map();
  private documentRoots: FSPath[] = [];
  private diagnosticCollection: vscode.DiagnosticCollection;
  private isInitialized = false;
  private documentLinks: Map<FSPath, vscode.DocumentLink[]> = new Map();
  private usageCounts: UsageCounts = new Map();
  private revalidateTimer: NodeJS.Timeout | undefined;

  constructor(context: vscode.ExtensionContext) {
    this.diagnosticCollection =
      vscode.languages.createDiagnosticCollection("writerly-links");
    const watcher = vscode.workspace.createFileSystemWatcher(
      ALL_WRITERLY_FILE_GLOB,
    );
    watcher.onDidChange((uri) => this.processUri(uri));
    watcher.onDidCreate((uri) => this.createUri(uri));
    watcher.onDidDelete((uri) => this.deleteUri(uri));
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
      vscode.languages.registerCompletionItemProvider(
        { scheme: "file", language: "writerly" },
        this,
        ">", // Triggered when the user types the second '>'
      ),

      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("writerly.enableUnusedHandleWarnings")) {
          // Re-validate all open documents to add/remove the warnings immediately
          for (const doc of vscode.workspace.textDocuments) {
            if (this.isWriterlyFile(doc.uri.fsPath)) {
              this.processDocument(doc);
            }
          }
        }
      }),
      watcher,
    ];
    disposables.forEach((disp) => context.subscriptions.push(disp));
    this.initializeAsync();
  }

  /**
   * Performs a deep reset of the provider's state and re-indexes the workspace.
   * Called by the WriterlyController.
   */
  public async reset(): Promise<void> {
    this.definitions.clear();
    this.documentLinks.clear();
    this.usageCounts.clear();
    this.documentRoots = [];
    this.isInitialized = false;
    this.diagnosticCollection.clear();

    if (this.revalidateTimer) {
      clearTimeout(this.revalidateTimer);
      this.revalidateTimer = undefined;
    }

    await this.initializeAsync();

    for (const doc of vscode.workspace.textDocuments) {
      if (this.isWriterlyFile(doc.uri.fsPath)) {
        this.processDocument(doc);
      }
    }
  }

  private async initializeAsync(): Promise<void> {
    try {
      await this.discoverDocumentRoots();
      await this.processAllDocuments();

      this.isInitialized = true;

      for (const doc of vscode.workspace.textDocuments) {
        if (this.isWriterlyFile(doc.uri.fsPath)) {
          this.processDocument(doc);
        }
      }
    } catch (error) {
      console.error("WriterlyLinkProvider initialization failed:", error);
    }
  }

  private async processAllDocuments(): Promise<void> {
    const fileGlob = getWriterlyFileGlob();
    if (!fileGlob) return;

    const uris = await vscode.workspace.findFiles(
      fileGlob,
      null,
      MAX_FILES,
    );

    // process all files and await completion
    await Promise.all(uris.map((uri) => this.processUri(uri)));
  }

  private async discoverDocumentRoots(): Promise<void> {
    this.documentRoots = await discoverWriterlyDocumentRoots(MAX_FILES);
  }

  private onDidChange(document: vscode.TextDocument): void {
    if (!this.isWriterlyFile(document.uri.fsPath)) return;
    this.processDocument(document);
  }

  private async onDidRename(event: vscode.FileRenameEvent): Promise<void> {
    for (const file of event.files) {
      if (
        this.isWriterlyFile(file.oldUri.fsPath) &&
        this.isWriterlyFile(file.newUri.fsPath)
      ) {
        await this.renameUri(file.oldUri, file.newUri);
      } else if (this.isWriterlyFile(file.oldUri.fsPath)) {
        await this.deleteUri(file.oldUri);
      } else if (this.isWriterlyFile(file.newUri.fsPath)) {
        await this.createUri(file.newUri);
      }
    }
  }

  private async onDidDelete(event: vscode.FileDeleteEvent): Promise<void> {
    for (const uri of event.files) {
      if (this.isWriterlyFile(uri.fsPath)) {
        await this.deleteUri(uri);
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
    return isWriterlyFilePath(fsPath);
  }

  private async renameUri(
    oldUri: vscode.Uri,
    newUri: vscode.Uri,
  ): Promise<void> {
    const oldPath = oldUri.fsPath;
    const newPath = newUri.fsPath;

    for (const [handleName, definitions] of this.definitions) {
      const hasChanges = definitions.some((def) => def.fsPath === oldPath);
      if (hasChanges) {
        const updatedDefinitions = definitions.map((def) =>
          def.fsPath === oldPath ? { ...def, fsPath: newPath } : def,
        );
        this.definitions.set(handleName, updatedDefinitions);
      }
    }

    await this.discoverDocumentRoots();
    this.rebuildUsageCounts();
  }

  private async deleteUri(uri: vscode.Uri): Promise<void> {
    const targetPath = uri.fsPath;

    // Subtract usages before cached links are removed.
    const cachedLinks = this.documentLinks.get(targetPath);
    if (cachedLinks) {
      this.updateUsageCountsForLinks(cachedLinks, -1);
    }

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

    this.diagnosticCollection.delete(uri);

    this.documentLinks.delete(targetPath);

    await this.discoverDocumentRoots();
    this.rebuildUsageCounts();

    if (this.isInitialized) {
      this.triggerTreeRevalidation(targetPath);
    }
  }

  private async createUri(uri: vscode.Uri): Promise<void> {
    await this.discoverDocumentRoots();
    await this.processUri(uri);
    this.rebuildUsageCounts();
  }

  private async processUri(uri: vscode.Uri): Promise<void> {
    if (!this.isWriterlyFile(uri.fsPath)) return;

    try {
      const document = await vscode.workspace.openTextDocument(uri);
      this.processDocument(document);
    } catch (error) {
      console.error(`Failed to process document ${uri.fsPath}:`, error);
    }
  }

  private processDocument(
    document: vscode.TextDocument,
    triggerRevalidation: boolean = true,
  ): vscode.DocumentLink[] {
    const currentFsPath = document.uri.fsPath;

    const oldLinks = this.documentLinks.get(currentFsPath) || [];
    this.updateUsageCountsForLinks(oldLinks, -1);
    this.clearDocumentDefinitions(currentFsPath);
    const diagnostics: vscode.Diagnostic[] = [];
    const documentLinks = this.walkDocument(document, diagnostics);
    this.updateUsageCountsForLinks(documentLinks, 1);

    if (this.isInitialized) {
      this.validateHandleUsage(documentLinks, diagnostics);
      this.validateHandleDefinitions(document, diagnostics);

      if (triggerRevalidation) {
        this.triggerTreeRevalidation(currentFsPath);
      }
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

  private walkDocument(
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
        WriterlyStaticValidator.validateLine(
          _stateBeforeLine,
          lineType,
          _stateAfterLine,
          lineNumber,
          indent,
          content,
          diagnostics,
        );

        if (lineType === LineType.Attribute) {
          this.extractHandleDefinition(
            content,
            lineNumber,
            indent,
            currentFsPath,
          );
        }

        if (lineType === LineType.Text) {
          this.extractInTextHandleDefinitions(
            content,
            lineNumber,
            indent,
            currentFsPath,
          );
        }

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

    WriterlyStaticValidator.validateFinalState(
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
    const looseMatch = content.match(LOOSE_DEF_REGEX);
    if (!looseMatch) return;

    const handleName = looseMatch[1];
    const fullMatchText = looseMatch[0];
    const handleStart = content.indexOf(fullMatchText);

    const range = new vscode.Range(
      lineNumber,
      indent + handleStart + fullMatchText.indexOf(handleName),
      lineNumber,
      indent +
        handleStart +
        fullMatchText.indexOf(handleName) +
        handleName.length,
    );

    this.addDefinition(handleName, { fsPath, range });
  }

  private extractInTextHandleDefinitions(
    content: string,
    lineNumber: number,
    indent: number,
    fsPath: string,
  ): void {
    IN_TEXT_DEF_REGEX.lastIndex = 0;
    let match;
    while ((match = IN_TEXT_DEF_REGEX.exec(content)) !== null) {
      const handleName = match[1];
      const handleNameStart = match.index + match[0].indexOf(handleName);
      const range = new vscode.Range(
        lineNumber,
        indent + handleNameStart,
        lineNumber,
        indent + handleNameStart + handleName.length,
      );
      this.addDefinition(handleName, { fsPath, range });
    }
  }

  private addDefinition(
    handleName: HandleName,
    definition: HandleDefinition,
  ): void {
    const definitions = this.definitions.get(handleName) || [];
    definitions.push(definition);
    this.definitions.set(handleName, definitions);
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
    const strictRegex = new RegExp(`^${HANDLE_REGEX_STRING}$`, "u");

    for (const link of documentLinks) {
      const handleName = link.data?.handleName;
      const currentFsPath = link.data?.fsPath;

      if (!handleName || !currentFsPath) continue;

      // if it doesn't match the strict regex, underline it in red immediately.
      if (!strictRegex.test(handleName)) {
        link.data.validated = ValidationState.ERROR;
        diagnostics.push(
          new vscode.Diagnostic(
            link.range,
            `Invalid handle name: '${handleName}'. Handles may contain letters, numbers, marks, dots, underscores, hyphens, colons, and carets, and must end with a letter, number, mark, underscore, or caret.`,
            vscode.DiagnosticSeverity.Error,
          ),
        );
        continue; // Skip tree lookup for invalid names
      }

      const validDefinitions = this.findValidDefinitions(
        handleName,
        currentFsPath,
      );

      if (validDefinitions.length === 1) {
        // exactly one definition found in this logical tree
        link.data.validated = ValidationState.OK;
      } else {
        // zero or multiple definitions found
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
    for (const folder of vscode.workspace.workspaceFolders || []) {
      const workspaceRoot = folder.uri.fsPath;
      if (!this.isPathUnderParent(fullPath, workspaceRoot)) continue;

      const relativePath = path.relative(workspaceRoot, fullPath);
      return relativePath
        ? this.normalizePathSeparators(relativePath)
        : folder.name;
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
    if (!this.isWriterlyFile(document.uri.fsPath)) return undefined;

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
    _range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext,
    _token: vscode.CancellationToken,
  ): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];

    const multipleDefDiagnostics = context.diagnostics.filter((diagnostic) =>
      diagnostic.message.includes("has multiple definitions"),
    );

    for (const diagnostic of multipleDefDiagnostics) {
      const handleMatch = diagnostic.message.match(
        /Handle '([^']+)' has multiple definitions/,
      );
      if (!handleMatch) continue;

      const handleName = handleMatch[1];
      const validDefinitions = this.findValidDefinitions(
        handleName,
        document.uri.fsPath,
      );

      validDefinitions.forEach((def, _index) => {
        const action = this.createGoToDefinitionAction(def);
        action.diagnostics = [diagnostic];
        actions.push(action);
      });
    }

    return actions;
  }

  public provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.Definition> {
    if (!this.isWriterlyFile(document.uri.fsPath)) {
      return undefined;
    }

    if (!this.isInitialized) {
      return undefined;
    }

    const usage = this.getUsageOnLine(document, position);
    return usage
      ? this.getDefinitionForHandle(usage.handleName, document.uri.fsPath)
      : undefined;
  }

  public prepareRename(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): { range: vscode.Range; placeholder: string } | undefined {
    if (!this.isWriterlyFile(document.uri.fsPath)) {
      return undefined;
    }

    const handle = this.getHandleAtPosition(document, position);
    if (handle) {
      return { range: handle.range, placeholder: handle.handleName };
    }

    return undefined;
  }

  public async provideRenameEdits(
    document: vscode.TextDocument,
    position: vscode.Position,
    newName: string,
    _token: vscode.CancellationToken,
  ): Promise<vscode.WorkspaceEdit | undefined> {
    if (!this.isWriterlyFile(document.uri.fsPath)) {
      return undefined;
    }

    const handle = this.getHandleAtPosition(document, position);
    if (!handle) {
      return undefined;
    }
    const oldName = handle.handleName;

    const workspaceEdit = new vscode.WorkspaceEdit();
    const originFsPath = document.uri.fsPath;

    const escapedName = oldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const exactMatchRegex = new RegExp(`^${escapedName}$`, "u");

    for (const [fsPath, links] of this.documentLinks) {
      if (!this.isInSameDocumentTree(originFsPath, fsPath)) {
        continue;
      }

      const uri = vscode.Uri.file(fsPath);

      for (const link of links) {
        if (
          link.data?.handleName &&
          exactMatchRegex.test(link.data.handleName)
        ) {
          const nameRange = new vscode.Range(
            link.range.start.line,
            link.range.start.character + 2,
            link.range.end.line,
            link.range.end.character,
          );
          workspaceEdit.replace(uri, nameRange, newName);
        }
      }

      const defs = this.definitions.get(oldName);
      if (defs) {
        for (const def of defs) {
          if (def.fsPath === fsPath) {
            workspaceEdit.replace(uri, def.range, newName);
          }
        }
      }
    }

    return workspaceEdit;
  }

  public provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken,
    _context: vscode.CompletionContext,
  ): vscode.ProviderResult<vscode.CompletionItem[] | vscode.CompletionList> {
    if (!this.isWriterlyFile(document.uri.fsPath)) {
      return undefined;
    }

    // 1. Check if we are actually after a '>>'
    const linePrefix = document
      .lineAt(position)
      .text.substring(0, position.character);
    if (!linePrefix.endsWith(">>")) {
      return undefined;
    }

    const completionItems: vscode.CompletionItem[] = [];
    const currentFsPath = document.uri.fsPath;

    for (const [handleName, defs] of this.definitions) {
      if (!this.isHandleVisibleFromFile(defs, currentFsPath)) continue;
      completionItems.push(this.createHandleCompletionItem(handleName));
    }

    return completionItems;
  }

  private createGoToDefinitionAction(
    definition: HandleDefinition,
  ): vscode.CodeAction {
    const relativePath = this.getRelativeWorkspacePath(definition.fsPath);
    const lineNumber = definition.range.start.line + 1;
    const action = new vscode.CodeAction(
      `Go to definition in ${relativePath}:${lineNumber}`,
      vscode.CodeActionKind.QuickFix,
    );
    const selectionStart = definition.range.start.translate(0, 7);

    action.command = {
      title: `Go to ${relativePath}:${lineNumber}`,
      command: "vscode.open",
      arguments: [
        vscode.Uri.file(definition.fsPath),
        {
          selection: new vscode.Range(selectionStart, selectionStart),
          preserveFocus: false,
        },
      ],
    };

    return action;
  }

  private isHandleVisibleFromFile(
    definitions: HandleDefinition[],
    fsPath: string,
  ): boolean {
    return definitions.some((def) =>
      this.isInSameDocumentTree(fsPath, def.fsPath),
    );
  }

  private createHandleCompletionItem(
    handleName: string,
  ): vscode.CompletionItem {
    const item = new vscode.CompletionItem(
      handleName,
      vscode.CompletionItemKind.Reference,
    );
    item.insertText = handleName;
    return item;
  }

  private getDefinitionOnLine(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): HandleAtPosition | undefined {
    const line = document.lineAt(position.line);
    const match = line.text.match(HANDLE_DEF_RENAME_REGEX);

    if (!match) return undefined;

    let lineType = WriterlyDocumentWalker.onTheFlyLineClassification(
      document,
      position,
    );
    if (
      lineType !== LineType.Attribute &&
      lineType !== LineType.AttributeZoneComment
    )
      return undefined;

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

  private getInTextDefinitionOnLine(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): HandleAtPosition | undefined {
    const lineType = WriterlyDocumentWalker.onTheFlyLineClassification(
      document,
      position,
    );
    if (lineType !== LineType.Text) return undefined;

    const line = document.lineAt(position.line).text.trimEnd();
    const spaces = line.match(/^( *)/)?.[1] || "";
    const indent = spaces.length;
    const content = line.slice(indent);

    IN_TEXT_DEF_REGEX.lastIndex = 0;
    let match;
    while ((match = IN_TEXT_DEF_REGEX.exec(content)) !== null) {
      const handleName = match[1];
      const handleNameStart = match.index + match[0].indexOf(handleName);
      const range = new vscode.Range(
        position.line,
        indent + handleNameStart,
        position.line,
        indent + handleNameStart + handleName.length,
      );

      if (range.contains(position)) {
        return { handleName, range };
      }
    }

    return undefined;
  }

  private getUsageOnLine(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): HandleAtPosition | undefined {
    const line = document.lineAt(position).text;
    let usageMatch;
    USAGE_REGEX.lastIndex = 0;

    while ((usageMatch = USAGE_REGEX.exec(line)) !== null) {
      const matchStart = usageMatch.index;
      const matchEnd = matchStart + usageMatch[0].length;

      if (position.character >= matchStart && position.character <= matchEnd) {
        const handleName = usageMatch[1];
        const range = new vscode.Range(
          position.line,
          matchStart + 2,
          position.line,
          matchEnd,
        );
        return { handleName, range };
      }
    }

    return undefined;
  }

  private getHandleAtPosition(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): HandleAtPosition | undefined {
    const attributeDefinition = this.getDefinitionOnLine(document, position);
    if (attributeDefinition?.range.contains(position)) {
      return attributeDefinition;
    }

    const inTextDefinition = this.getInTextDefinitionOnLine(document, position);
    if (inTextDefinition?.range.contains(position)) {
      return inTextDefinition;
    }

    return this.getUsageOnLine(document, position);
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

    return isInSameWriterlyDocumentTree(
      currentFsPath,
      definitionFsPath,
      this.documentRoots,
    );
  }

  private isPathUnderParent(filePath: string, parentPath: string): boolean {
    const relativePath = path.relative(parentPath, filePath);
    return (
      relativePath === "" ||
      (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
    );
  }

  private normalizePathSeparators(filePath: string): string {
    return filePath.replace(/\\/g, "/");
  }

  private validateHandleDefinitions(
    document: vscode.TextDocument,
    diagnostics: vscode.Diagnostic[],
  ): void {
    const currentFsPath = document.uri.fsPath;
    const strictRegex = new RegExp(`^(${HANDLE_REGEX_STRING})$`, "u");

    this.definitions.forEach((defs, handleName) => {
      const localDefs = defs.filter((d) => d.fsPath === currentFsPath);
      if (localDefs.length === 0) return;

      if (!strictRegex.test(handleName)) {
        this.addInvalidHandleDefinitionDiagnostics(
          handleName,
          localDefs,
          diagnostics,
        );
        return;
      }

      const treeDefs = this.findValidDefinitions(handleName, currentFsPath);
      const uniqueTreeDefs = this.dedupeDefinitions(treeDefs);
      if (uniqueTreeDefs.length > 1) {
        this.addDuplicateHandleDefinitionDiagnostics(
          handleName,
          localDefs,
          uniqueTreeDefs.length,
          diagnostics,
        );
        return;
      }

      if (this.isUnusedWarningEnabled()) {
        if (this.getUsageCountInDocumentTree(handleName, currentFsPath) === 0) {
          this.addUnusedHandleDefinitionDiagnostics(
            handleName,
            localDefs,
            diagnostics,
          );
        }
      }
    });
  }

  private addInvalidHandleDefinitionDiagnostics(
    handleName: HandleName,
    definitions: HandleDefinition[],
    diagnostics: vscode.Diagnostic[],
  ): void {
    definitions.forEach((definition) => {
      diagnostics.push(
        new vscode.Diagnostic(
          definition.range,
          `Invalid handle name: '${handleName}'.`,
          vscode.DiagnosticSeverity.Error,
        ),
      );
    });
  }

  private addDuplicateHandleDefinitionDiagnostics(
    handleName: HandleName,
    definitions: HandleDefinition[],
    definitionCount: number,
    diagnostics: vscode.Diagnostic[],
  ): void {
    definitions.forEach((definition) => {
      diagnostics.push(
        new vscode.Diagnostic(
          definition.range,
          `Handle '${handleName}' is defined in multiple places (${definitionCount}) in this document tree.`,
          vscode.DiagnosticSeverity.Error,
        ),
      );
    });
  }

  private addUnusedHandleDefinitionDiagnostics(
    handleName: HandleName,
    definitions: HandleDefinition[],
    diagnostics: vscode.Diagnostic[],
  ): void {
    definitions.forEach((definition) => {
      diagnostics.push(
        new vscode.Diagnostic(
          definition.range,
          `Unused handle: '${handleName}' is defined but never used.`,
          vscode.DiagnosticSeverity.Warning,
        ),
      );
    });
  }

  private triggerTreeRevalidation(originFsPath: string) {
    if (this.revalidateTimer) {
      clearTimeout(this.revalidateTimer);
    }

    this.revalidateTimer = setTimeout(() => {
      // 1. create a quick-lookup map of currently open documents
      const openDocsMap = new Map<string, vscode.TextDocument>();
      for (const doc of vscode.workspace.textDocuments) {
        openDocsMap.set(doc.uri.fsPath, doc);
      }

      // 2. iterate only once through documentLinks
      for (const [fsPath] of this.documentLinks) {
        // Skip the file that triggered this revalidation, as it was already processed
        if (fsPath === originFsPath) continue;

        // 3. only process if it belongs to the same tree
        if (this.isInSameDocumentTree(originFsPath, fsPath)) {
          const openDoc = openDocsMap.get(fsPath);

          // we only update diagnostics for open documents to save UI thread resources.
          // closed documents will be validated when the user opens them.
          if (openDoc) {
            // Re-process the document to gather all current diagnostics (including indentation)
            // but set triggerRevalidation to false to prevent infinite loops
            this.processDocument(openDoc, false);
          }
        }
      }
    }, 300);
  }

  private dedupeDefinitions(
    definitions: HandleDefinition[],
  ): HandleDefinition[] {
    return definitions.filter(
      (definition, index, allDefinitions) =>
        index ===
        allDefinitions.findIndex((candidate) =>
          this.isSameDefinition(candidate, definition),
        ),
    );
  }

  private isSameDefinition(
    a: HandleDefinition,
    b: HandleDefinition,
  ): boolean {
    return (
      a.fsPath === b.fsPath &&
      a.range.start.line === b.range.start.line &&
      a.range.start.character === b.range.start.character
    );
  }

  private getDocumentTreeKeys(fsPath: string): DocumentTreeKey[] {
    return getDocumentTreeKeys(fsPath, this.documentRoots);
  }

  private getUsageCountInDocumentTree(
    handleName: string,
    fsPath: string,
  ): number {
    const countsByTree = this.usageCounts.get(handleName);
    if (!countsByTree) return 0;

    return this.getDocumentTreeKeys(fsPath).reduce(
      (sum, treeKey) => sum + (countsByTree.get(treeKey) || 0),
      0,
    );
  }

  private rebuildUsageCounts(): void {
    this.usageCounts.clear();
    for (const links of this.documentLinks.values()) {
      this.updateUsageCountsForLinks(links, 1);
    }
  }

  private updateUsageCountsForLinks(
    links: vscode.DocumentLink[],
    delta: number,
  ): void {
    for (const link of links) {
      this.updateUsageCount(link.data.handleName, link.data.fsPath, delta);
    }
  }

  private updateUsageCount(handleName: string, fsPath: string, delta: number) {
    let countsByTree = this.usageCounts.get(handleName);
    if (!countsByTree) {
      countsByTree = new Map();
      this.usageCounts.set(handleName, countsByTree);
    }

    for (const treeKey of this.getDocumentTreeKeys(fsPath)) {
      const current = countsByTree.get(treeKey) || 0;
      const next = current + delta;
      if (next <= 0) {
        countsByTree.delete(treeKey);
      } else {
        countsByTree.set(treeKey, next);
      }
    }

    if (countsByTree.size === 0) {
      this.usageCounts.delete(handleName);
    }
  }
  private isUnusedWarningEnabled(): boolean {
    return vscode.workspace
      .getConfiguration("writerly")
      .get<boolean>("enableUnusedHandleWarnings", true);
  }
}
