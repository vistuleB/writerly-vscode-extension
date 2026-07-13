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
  discoverWriterlyContainers,
  getHashIslandDepth,
  getDocumentTreeKeys,
  isInAccessibleHashIsland,
  isInSameHashIsland,
  isInSameWriterlyDocumentTree,
  isPathUnderDirectory,
  steinbergerDistance,
} from "./WriterlyDocumentTrees";
import { fileUtils } from "./utils/file-utils";

/*
 * WriterlyLinkProvider currently owns the handle subsystem end to end.
 *
 * Maintained state:
 * - definitionsByFile: source-of-truth cache for handle definitions parsed
 *   from each indexed Writerly file.
 * - documentLinks: maps each file path to the handle-usage links extracted
 *   from that file. Each link stores the handle name, source file path, and
 *   current validation state. This is the source-of-truth cache for usages.
 * - definitions: derived map from handle name to all indexed definitions.
 *   Rebuilt from definitionsByFile after source facts change.
 * - usageCounts: derived map from handle name to usage counts per document
 *   tree. Rebuilt from documentLinks after source facts change so unused-handle
 *   diagnostics run against a complete current usage index.
 * - writerlyContainers: stores directories that directly contain .wly files.
 *   Broad document-tree membership
 *   ignores hash-commented path segments; handle lookup and duplicate
 *   diagnostics then apply hash-island scoping within that tree.
 * - diagnosticCollection: owns all handle and syntax diagnostics reported by
 *   this provider; diagnostics are replaced per file after reprocessing.
 * - isInitialized/revalidateTimer: prevent premature provider work and debounce
 *   tree-wide revalidation after file creates/deletes/renames that can change
 *   Writerly containers.
 *
 * Features provided:
 * - Workspace indexing:
 *   - discovers active Writerly files and Writerly containers
 *   - walks documents to extract handle definitions and usages
 *   - updates caches from file-system events and open-document changes
 * - Document-tree scoping:
 *   - resolves whether files can be assembled into the same document
 *   - filters definitions and usage counts to those document containers
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
    data: {
      handleName: string;
      fsPath: string;
      validated: ValidationState;
      suppressDiagnostics?: boolean;
    };
  }
}

type FSPath = string;
type HandleName = string;
type DocumentTreeKey = string;
type UsageCounts = Map<HandleName, Map<DocumentTreeKey, number>>;
export type WriterlyDiagnosticStatus = "none" | "warning" | "error";

type MissingFileValidationCache = {
  fileExists: Map<string, Promise<boolean>>;
  localPathExists: Map<string, Promise<boolean>>;
  possibleFilePaths: Map<string, Promise<string[]>>;
  possibleDirPaths: Map<string, Promise<string[]>>;
};

type HandleDefinition = {
  fsPath: FSPath;
  range: vscode.Range;
};

type ParsedDocumentFacts = {
  definitions: Map<HandleName, HandleDefinition[]>;
  documentLinks: vscode.DocumentLink[];
};

type HandleAtPosition = {
  handleName: HandleName;
  range: vscode.Range;
};

type HandleUsage = {
  fsPath: FSPath;
  range: vscode.Range;
  handleName: HandleName;
};

type HandleResolution =
  | { kind: "ok"; definition: HandleDefinition }
  | { kind: "notFound" }
  | { kind: "multiple"; definitions: HandleDefinition[] }
  | { kind: "inaccessible"; definitions: HandleDefinition[] };

const HANDLE_CHARS: string = "\\p{L}\\p{N}\\p{M}_.:'\\-\\^";
const HANDLE_END_CHARS: string = "\\p{L}\\p{N}\\p{M}_'\\^";
const HANDLE_REGEX_STRING: string = `(?:[${HANDLE_CHARS}]*[${HANDLE_END_CHARS}])`;
const HANDLE_DEF_RENAME_REGEX = new RegExp(
  `^\\s*(?:!!\\s*)?handle=\\s*(${HANDLE_REGEX_STRING})(#|\\s|$)`,
  "u",
);
const USAGE_REGEX = new RegExp(`>>(${HANDLE_REGEX_STRING})`, "gu");
const LOOSE_DEF_REGEX = /^handle=\s*([^\s#|]+)/u;

// Decorator chars are HANDLE_CHARS minus '.' and '^'
const HANDLE_DECORATOR_CHARS: string = "\\p{L}\\p{N}\\p{M}_:'\\-";
const HANDLE_DECORATOR_REGEX_STRING: string = `#[${HANDLE_DECORATOR_CHARS}]+`;
const HANDLE_DECORATORS_REGEX_STRING: string = `(?:${HANDLE_DECORATOR_REGEX_STRING})*`;
// Matches "#handleName[decorators]##<<" or "handleName##<<" at start of content or after space, '{', '(', or '['.
const IN_TEXT_DEF_REGEX = new RegExp(
  `(?:#(${HANDLE_REGEX_STRING})(${HANDLE_DECORATORS_REGEX_STRING})##<<|(?:^|[ {(\\[])(${HANDLE_REGEX_STRING})##<<)`,
  "gu",
);
const MISSING_FILE_WARNING_ATTRIBUTE_NAMES = new Set([
  "original",
  "poster",
  "cover",
  "image",
  "thumbnail",
  "preview",
  "logo",
  "icon",
  "favicon",
  "background",
  "file",
  "source",
]);
const GO_TO_HANDLE_USAGE_COMMAND = "writerly.goToHandleUsage";
const URI_SCHEME_REGEX = /^[a-z][a-z0-9+.-]*:/i;
const OPEN_DOCUMENT_PROCESSING_DELAY_MS = 250;

export class WriterlyLinkProvider
  implements
    vscode.DocumentLinkProvider,
    vscode.CodeActionProvider,
    vscode.DefinitionProvider,
    vscode.RenameProvider,
    vscode.CompletionItemProvider
{
  private definitions: Map<HandleName, HandleDefinition[]> = new Map();
  private definitionsByFile: Map<FSPath, Map<HandleName, HandleDefinition[]>> =
    new Map();
  private writerlyContainers: FSPath[] = [];
  private diagnosticCollection: vscode.DiagnosticCollection;
  private missingFileDiagnosticCollection: vscode.DiagnosticCollection;
  private isInitialized = false;
  private documentLinks: Map<FSPath, vscode.DocumentLink[]> = new Map();
  private usageCounts: UsageCounts = new Map();
  private revalidateTimer: NodeJS.Timeout | undefined;
  private missingFileRevalidateTimer: NodeJS.Timeout | undefined;
  private missingFileValidationTimer: NodeJS.Timeout | undefined;
  private openDocumentProcessingTimer: NodeJS.Timeout | undefined;
  private pendingOpenDocument: vscode.TextDocument | undefined;
  private openDocumentRevalidationTimer: NodeJS.Timeout | undefined;
  private pendingMissingFileDocuments = new Map<FSPath, vscode.TextDocument>();

  constructor(context: vscode.ExtensionContext) {
    this.diagnosticCollection =
      vscode.languages.createDiagnosticCollection("writerly-links");
    this.missingFileDiagnosticCollection =
      vscode.languages.createDiagnosticCollection("writerly-missing-files");
    const watcher = vscode.workspace.createFileSystemWatcher(
      ALL_WRITERLY_FILE_GLOB,
    );
    const assetWatcher = vscode.workspace.createFileSystemWatcher("**/*");
    watcher.onDidChange((uri) => this.processUri(uri));
    watcher.onDidCreate((uri) => this.createUri(uri));
    watcher.onDidDelete((uri) => this.deleteUri(uri));
    assetWatcher.onDidCreate((uri) => this.triggerMissingFileRevalidation(uri));
    assetWatcher.onDidDelete((uri) => this.triggerMissingFileRevalidation(uri));
    assetWatcher.onDidChange((uri) => this.triggerMissingFileRevalidation(uri));
    const disposables = [
      this.diagnosticCollection,
      this.missingFileDiagnosticCollection,
      vscode.workspace.onDidChangeTextDocument((event) =>
        this.onDidChange(event.document),
      ),
      vscode.workspace.onDidOpenTextDocument((document) =>
        this.onDidOpen(document),
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
      vscode.commands.registerCommand(GO_TO_HANDLE_USAGE_COMMAND, () =>
        this.goToHandleUsage(),
      ),

      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          e.affectsConfiguration("writerly.enableUnusedHandleWarnings") ||
          e.affectsConfiguration("writerly.enableMissingFileWarnings")
        ) {
          // Re-validate all open documents to add/remove the warnings immediately
          for (const doc of vscode.workspace.textDocuments) {
            if (this.isWriterlyFile(doc.uri.fsPath)) {
              void this.processDocument(doc);
            }
          }
        }
      }),
      watcher,
      assetWatcher,
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
    this.definitionsByFile.clear();
    this.documentLinks.clear();
    this.usageCounts.clear();
    this.writerlyContainers = [];
    this.isInitialized = false;
    this.diagnosticCollection.clear();
    this.missingFileDiagnosticCollection.clear();
    this.pendingMissingFileDocuments.clear();
    this.pendingOpenDocument = undefined;

    if (this.revalidateTimer) {
      clearTimeout(this.revalidateTimer);
      this.revalidateTimer = undefined;
    }
    if (this.missingFileRevalidateTimer) {
      clearTimeout(this.missingFileRevalidateTimer);
      this.missingFileRevalidateTimer = undefined;
    }
    if (this.missingFileValidationTimer) {
      clearTimeout(this.missingFileValidationTimer);
      this.missingFileValidationTimer = undefined;
    }
    if (this.openDocumentProcessingTimer) {
      clearTimeout(this.openDocumentProcessingTimer);
      this.openDocumentProcessingTimer = undefined;
    }
    if (this.openDocumentRevalidationTimer) {
      clearTimeout(this.openDocumentRevalidationTimer);
      this.openDocumentRevalidationTimer = undefined;
    }

    await this.initializeAsync();
  }

  private async initializeAsync(): Promise<void> {
    try {
      await this.refreshWriterlyContainers();
      await this.processAllDocuments();

      const openWriterlyDocuments: vscode.TextDocument[] = [];
      for (const doc of vscode.workspace.textDocuments) {
        if (!this.isWriterlyFile(doc.uri.fsPath)) continue;

        if (await this.shouldIndexOpenDocument(doc)) {
          openWriterlyDocuments.push(doc);
          await this.processDocument(doc);
        }
      }

      this.isInitialized = true;

      for (const doc of openWriterlyDocuments) {
        await this.processDocument(doc, false, true);
      }

      this.scheduleOpenDocumentRevalidation();
    } catch (error) {
      console.error("WriterlyLinkProvider initialization failed:", error);
    }
  }

  private async processAllDocuments(): Promise<void> {
    const fileGlob = getWriterlyFileGlob();
    if (!fileGlob) return;

    const uris = await vscode.workspace.findFiles(fileGlob);

    // process all files and await completion
    await Promise.all(uris.map((uri) => this.processUri(uri)));
  }

  private async refreshWriterlyContainers(): Promise<void> {
    this.writerlyContainers = await discoverWriterlyContainers();
  }

  private async shouldIndexOpenDocument(
    document: vscode.TextDocument,
  ): Promise<boolean> {
    if (!this.isWriterlyFile(document.uri.fsPath)) return false;
    if (!this.isInWorkspace(document.uri.fsPath)) return false;
    if (await this.localPathExists(document.uri.fsPath)) {
      return true;
    }

    await this.deleteUri(document.uri);
    return false;
  }

  private isInWorkspace(fsPath: string): boolean {
    return (vscode.workspace.workspaceFolders || []).some((folder) =>
      isPathUnderDirectory(fsPath, folder.uri.fsPath),
    );
  }

  private scheduleOpenDocumentRevalidation(): void {
    if (this.openDocumentRevalidationTimer) {
      clearTimeout(this.openDocumentRevalidationTimer);
    }

    this.openDocumentRevalidationTimer = setTimeout(() => {
      void this.revalidateOpenDocuments();
    }, 1000);
  }

  private async revalidateOpenDocuments(): Promise<void> {
    this.openDocumentRevalidationTimer = undefined;

    const openWriterlyDocuments: vscode.TextDocument[] = [];
    for (const document of vscode.workspace.textDocuments) {
      if (!this.isWriterlyFile(document.uri.fsPath)) continue;
      if (await this.shouldIndexOpenDocument(document)) {
        openWriterlyDocuments.push(document);
      }
    }

    for (const document of openWriterlyDocuments) {
      await this.processDocument(document, false, true);
    }
  }

  private onDidChange(document: vscode.TextDocument): void {
    if (!this.isWriterlyFile(document.uri.fsPath)) return;
    void this.processDocument(document);
  }

  private onDidOpen(document: vscode.TextDocument): void {
    if (!this.isInitialized) return;
    if (!this.isWriterlyFile(document.uri.fsPath)) return;
    this.scheduleOpenDocumentProcessing(document);
    this.scheduleOpenDocumentRevalidation();
  }

  private scheduleOpenDocumentProcessing(
    document: vscode.TextDocument,
  ): void {
    this.pendingOpenDocument = document;
    if (this.openDocumentProcessingTimer) {
      clearTimeout(this.openDocumentProcessingTimer);
    }

    this.openDocumentProcessingTimer = setTimeout(() => {
      void this.processPendingOpenDocument();
    }, OPEN_DOCUMENT_PROCESSING_DELAY_MS);
  }

  private async processPendingOpenDocument(): Promise<void> {
    this.openDocumentProcessingTimer = undefined;
    const document = this.pendingOpenDocument;
    this.pendingOpenDocument = undefined;
    if (!document) return;
    if (!this.isWriterlyFile(document.uri.fsPath)) return;

    const isStillOpen = vscode.workspace.textDocuments.some(
      (candidate) => candidate.uri.toString() === document.uri.toString(),
    );
    if (!isStillOpen) return;
    if (!(await this.shouldIndexOpenDocument(document))) return;

    await this.processDocument(document);
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

    const definitionsByHandle = this.definitionsByFile.get(oldPath);
    if (definitionsByHandle) {
      const renamedDefinitions = new Map<HandleName, HandleDefinition[]>();
      for (const [handleName, definitions] of definitionsByHandle) {
        renamedDefinitions.set(
          handleName,
          definitions.map((definition) => ({
            ...definition,
            fsPath: newPath,
          })),
        );
      }
      this.definitionsByFile.delete(oldPath);
      this.definitionsByFile.set(newPath, renamedDefinitions);
    }

    const documentLinks = this.documentLinks.get(oldPath);
    if (documentLinks) {
      for (const link of documentLinks) {
        link.data.fsPath = newPath;
      }
      this.documentLinks.delete(oldPath);
      this.documentLinks.set(newPath, documentLinks);
    }

    await this.refreshWriterlyContainers();
    this.rebuildHandleIndexes();
  }

  private async deleteUri(uri: vscode.Uri): Promise<void> {
    const targetPath = uri.fsPath;

    this.definitionsByFile.delete(targetPath);
    this.documentLinks.delete(targetPath);
    this.diagnosticCollection.delete(uri);
    this.missingFileDiagnosticCollection.delete(uri);
    this.pendingMissingFileDocuments.delete(uri.fsPath);

    await this.refreshWriterlyContainers();
    this.rebuildHandleIndexes();

    if (this.isInitialized) {
      this.triggerTreeRevalidation(targetPath);
    }
  }

  private async createUri(uri: vscode.Uri): Promise<void> {
    await this.refreshWriterlyContainers();
    await this.processUri(uri);
  }

  private async processUri(uri: vscode.Uri): Promise<void> {
    if (!this.isWriterlyFile(uri.fsPath)) return;

    try {
      const document = await vscode.workspace.openTextDocument(uri);
      await this.processDocument(document);
    } catch (error) {
      console.error(`Failed to process document ${uri.fsPath}:`, error);
    }
  }

  public getDiagnosticStatus(fsPath: string): WriterlyDiagnosticStatus {
    const diagnostics = [
      ...(this.diagnosticCollection.get(vscode.Uri.file(fsPath)) ?? []),
      ...(this.missingFileDiagnosticCollection.get(vscode.Uri.file(fsPath)) ?? []),
    ];

    if (
      diagnostics.some(
        (diagnostic) =>
          diagnostic.severity === vscode.DiagnosticSeverity.Error,
      )
    ) {
      return "error";
    }
    if (
      diagnostics.some(
        (diagnostic) =>
          diagnostic.severity === vscode.DiagnosticSeverity.Warning,
      )
    ) {
      return "warning";
    }
    return "none";
  }

  private async processDocument(
    document: vscode.TextDocument,
    triggerRevalidation: boolean = true,
    validateUnusedHandles: boolean = false,
  ): Promise<vscode.DocumentLink[]> {
    const currentFsPath = document.uri.fsPath;

    const diagnostics: vscode.Diagnostic[] = [];
    const parsedFacts = await this.walkDocument(document, diagnostics);
    this.definitionsByFile.set(currentFsPath, parsedFacts.definitions);
    this.documentLinks.set(currentFsPath, parsedFacts.documentLinks);
    this.rebuildHandleIndexes();

    if (this.isInitialized) {
      this.validateHandleUsage(parsedFacts.documentLinks, diagnostics);
      this.validateHandleDefinitions(
        document,
        diagnostics,
        validateUnusedHandles,
      );

      if (triggerRevalidation) {
        this.triggerTreeRevalidation(currentFsPath);
      }
    }

    this.diagnosticCollection.set(document.uri, diagnostics);
    if (this.isInitialized) {
      this.queueMissingFileValidation(document);
    }
    return parsedFacts.documentLinks;
  }

  private async walkDocument(
    document: vscode.TextDocument,
    diagnostics: vscode.Diagnostic[],
  ): Promise<ParsedDocumentFacts> {
    const documentLinks: vscode.DocumentLink[] = [];
    const definitions = new Map<HandleName, HandleDefinition[]>();
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
            definitions,
          );
        }

        if (lineType === LineType.Text) {
          this.extractInTextHandleDefinitions(
            content,
            lineNumber,
            indent,
            currentFsPath,
            definitions,
          );
        }

        if (this.shouldProcessUsageInLine(lineType)) {
          const usageLinks = this.extractHandleUsage(
            content,
            lineNumber,
            indent,
            currentFsPath,
            this.isCommentLine(lineType),
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

    return { definitions, documentLinks };
  }

  private shouldProcessUsageInLine(lineType: LineType): boolean {
    return (
      lineType !== LineType.CodeBlockLine &&
      lineType !== LineType.Tag &&
      lineType !== LineType.CodeBlockClosing
    );
  }

  private isCommentLine(lineType: LineType): boolean {
    return (
      lineType === LineType.AttributeZoneComment ||
      lineType === LineType.TextZoneComment
    );
  }

  private createMissingFileValidationCache(): MissingFileValidationCache {
    return {
      fileExists: new Map(),
      localPathExists: new Map(),
      possibleFilePaths: new Map(),
      possibleDirPaths: new Map(),
    };
  }

  private queueMissingFileValidation(
    document: vscode.TextDocument,
    delayMs = 750,
  ): void {
    if (!this.isWriterlyFile(document.uri.fsPath)) return;
    if (!this.isMissingFileWarningEnabled()) {
      this.missingFileDiagnosticCollection.delete(document.uri);
      return;
    }

    this.pendingMissingFileDocuments.set(document.uri.fsPath, document);
    if (this.missingFileValidationTimer) {
      clearTimeout(this.missingFileValidationTimer);
    }
    this.missingFileValidationTimer = setTimeout(() => {
      void this.runPendingMissingFileValidation();
    }, delayMs);
  }

  private async runPendingMissingFileValidation(): Promise<void> {
    const documents = [...this.pendingMissingFileDocuments.values()];
    this.pendingMissingFileDocuments.clear();
    this.missingFileValidationTimer = undefined;

    if (!this.isMissingFileWarningEnabled()) {
      this.missingFileDiagnosticCollection.clear();
      return;
    }

    for (const document of documents) {
      if (!this.isWriterlyFile(document.uri.fsPath)) continue;
      const diagnostics = await this.collectMissingFileDiagnostics(document);
      this.missingFileDiagnosticCollection.set(document.uri, diagnostics);
    }
  }

  private async collectMissingFileDiagnostics(
    document: vscode.TextDocument,
  ): Promise<vscode.Diagnostic[]> {
    const diagnostics: vscode.Diagnostic[] = [];
    const cache = this.createMissingFileValidationCache();
    const attributes: Array<{
      content: string;
      lineNumber: number;
      indent: number;
    }> = [];

    WriterlyDocumentWalker.walk(
      document,
      (
        _stateBeforeLine,
        lineType,
        _stateAfterLine,
        lineNumber,
        indent,
        content,
      ) => {
        if (lineType !== LineType.Attribute) return;
        attributes.push({ content, lineNumber, indent });
      },
    );

    for (const attribute of attributes) {
      await this.addMissingFileAttributeDiagnostic(
        document,
        attribute.content,
        attribute.lineNumber,
        attribute.indent,
        diagnostics,
        cache,
      );
    }

    return diagnostics;
  }

  private async addMissingFileAttributeDiagnostic(
    document: vscode.TextDocument,
    content: string,
    lineNumber: number,
    indent: number,
    diagnostics: vscode.Diagnostic[],
    cache: MissingFileValidationCache,
  ): Promise<void> {
    const attributeMatch = content.match(/^([A-Za-z0-9_.:-]+)=/);
    if (!attributeMatch) return;

    const attributeName = attributeMatch[1];
    if (!this.shouldWarnForMissingFileAttribute(attributeName)) return;

    const valueStartInContent =
      attributeMatch[0].length +
      this.countLeadingWhitespace(content.slice(attributeMatch[0].length));
    const value = content.slice(valueStartInContent).trim();
    if (!this.shouldCheckMissingFileValue(value)) return;

    const message = await this.getMissingFileAttributeDiagnosticMessage(
      document,
      value,
      cache,
    );
    if (!message) return;

    const valueStart = indent + valueStartInContent;
    diagnostics.push(
      new vscode.Diagnostic(
        new vscode.Range(
          lineNumber,
          valueStart,
          lineNumber,
          valueStart + value.length,
        ),
        message,
        vscode.DiagnosticSeverity.Warning,
      ),
    );
  }

  private shouldWarnForMissingFileAttribute(attributeName: string): boolean {
    const normalized = attributeName.toLowerCase();
    return (
      normalized.endsWith("src") ||
      MISSING_FILE_WARNING_ATTRIBUTE_NAMES.has(normalized)
    );
  }

  private shouldCheckMissingFileValue(value: string): boolean {
    return (
      value.length > 0 &&
      !/\s/.test(value) &&
      !value.startsWith("#") &&
      !URI_SCHEME_REGEX.test(value)
    );
  }

  private countLeadingWhitespace(text: string): number {
    const match = text.match(/^\s*/);
    return match ? match[0].length : 0;
  }

  private async getMissingFileAttributeDiagnosticMessage(
    document: vscode.TextDocument,
    filePath: string,
    cache: MissingFileValidationCache,
  ): Promise<string | undefined> {
    const misdirectedWarning =
      await this.getSpokenForDirectoryReferenceWarning(document, filePath, cache);
    if (misdirectedWarning) return misdirectedWarning;

    const exists = await this.localFileReferenceExists(filePath, cache);
    return exists ? undefined : `Local file not found: ${filePath}`;
  }

  private async localFileReferenceExists(
    filePath: string,
    cache: MissingFileValidationCache,
  ): Promise<boolean> {
    if (path.isAbsolute(filePath)) {
      return this.cachedLocalPathExists(filePath, cache);
    }

    let cached = cache.fileExists.get(filePath);
    if (!cached) {
      cached = fileUtils.fileExists(filePath);
      cache.fileExists.set(filePath, cached);
    }
    return cached;
  }

  private async getSpokenForDirectoryReferenceWarning(
    document: vscode.TextDocument,
    filePath: string,
    cache: MissingFileValidationCache,
  ): Promise<string | undefined> {
    if (path.isAbsolute(filePath)) return undefined;

    const { dirPath, fileName } = this.splitReferencePath(filePath);
    if (!dirPath || !fileName) return undefined;

    const matchingFiles = await this.cachedPossibleFilePaths(filePath, cache);
    if (matchingFiles.length !== 1) return undefined;

    const resolvedFile = matchingFiles[0];
    const resolvedDir = path.dirname(resolvedFile);
    const matchingDirs = await this.cachedPossibleDirPaths(
      dirPath,
      document.uri.fsPath,
      cache,
    );
    if (matchingDirs.length <= 1) return undefined;

    const topmostRoots = this.getTopmostWriterlyRoots();
    const originRoot =
      this.getClosestContainingDirectory(document.uri.fsPath, topmostRoots) ??
      path.dirname(document.uri.fsPath);
    if (
      !this.isDirectoryCloserToAnotherTopmostRoot(
        resolvedDir,
        originRoot,
        topmostRoots,
      )
    ) {
      return undefined;
    }

    const resolvedDistance = steinbergerDistance(originRoot, resolvedDir);
    const closerDirs = matchingDirs.filter(
      (dir) =>
        path.resolve(dir) !== path.resolve(resolvedDir) &&
        steinbergerDistance(originRoot, dir) < resolvedDistance,
    );
    const closestDirs = this.getClosestDirectoriesBySteinbergerDistance(
      closerDirs,
      originRoot,
    );
    if (closestDirs.length !== 1) return undefined;

    const closestDir = closestDirs[0];
    if (await this.cachedLocalPathExists(path.join(closestDir, fileName), cache)) {
      return undefined;
    }

    return `File reference resolves to ${this.getRelativeWorkspacePath(
      resolvedFile,
    )}, but ${dirPath} also matches closer directory ${this.getRelativeWorkspacePath(
      closestDir,
    )} in this document tree and that directory does not contain ${fileName}.`;
  }

  private splitReferencePath(filePath: string): {
    dirPath: string;
    fileName: string;
  } {
    const segments = filePath.split("/");
    const fileName = segments.pop() || "";
    return { dirPath: segments.join("/"), fileName };
  }

  private async localPathExists(fsPath: string): Promise<boolean> {
    try {
      await vscode.workspace.fs.stat(vscode.Uri.file(fsPath));
      return true;
    } catch {
      return false;
    }
  }

  private cachedLocalPathExists(
    fsPath: string,
    cache: MissingFileValidationCache,
  ): Promise<boolean> {
    let cached = cache.localPathExists.get(fsPath);
    if (!cached) {
      cached = this.localPathExists(fsPath);
      cache.localPathExists.set(fsPath, cached);
    }
    return cached;
  }

  private cachedPossibleFilePaths(
    filePath: string,
    cache: MissingFileValidationCache,
  ): Promise<string[]> {
    let cached = cache.possibleFilePaths.get(filePath);
    if (!cached) {
      cached = fileUtils.resolvePossibleFilePaths(filePath);
      cache.possibleFilePaths.set(filePath, cached);
    }
    return cached;
  }

  private cachedPossibleDirPaths(
    dirPath: string,
    rootRelativeTo: string,
    cache: MissingFileValidationCache,
  ): Promise<string[]> {
    const cacheKey = `${rootRelativeTo}\n${dirPath}`;
    let cached = cache.possibleDirPaths.get(cacheKey);
    if (!cached) {
      cached = fileUtils.resolvePossibleDirPaths(dirPath, { rootRelativeTo });
      cache.possibleDirPaths.set(cacheKey, cached);
    }
    return cached;
  }

  private getTopmostWriterlyRoots(): string[] {
    return this.writerlyContainers.filter(
      (container) =>
        !this.writerlyContainers.some(
          (candidateParent) =>
            candidateParent !== container &&
            isPathUnderDirectory(container, candidateParent),
        ),
    );
  }

  private getClosestContainingDirectory(
    fsPath: string,
    directories: readonly string[],
  ): string | undefined {
    return directories
      .filter((directory) => isPathUnderDirectory(fsPath, directory))
      .sort((a, b) => b.length - a.length)[0];
  }

  private isDirectoryCloserToAnotherTopmostRoot(
    directory: string,
    originRoot: string,
    topmostRoots: readonly string[],
  ): boolean {
    const originDistance = steinbergerDistance(originRoot, directory);
    return topmostRoots.some(
      (root) =>
        root !== originRoot &&
        steinbergerDistance(root, directory) < originDistance,
    );
  }

  private getClosestDirectoriesBySteinbergerDistance(
    directories: string[],
    originRoot: string,
  ): string[] {
    if (directories.length === 0) return [];

    const ranked = directories.map((directory) => ({
      directory,
      distance: steinbergerDistance(originRoot, directory),
    }));
    const bestDistance = Math.min(
      ...ranked.map((candidate) => candidate.distance),
    );
    return ranked
      .filter((candidate) => candidate.distance === bestDistance)
      .map((candidate) => candidate.directory);
  }

  private extractHandleDefinition(
    content: string,
    lineNumber: number,
    indent: number,
    fsPath: string,
    definitions: Map<HandleName, HandleDefinition[]>,
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

    this.addDefinition(definitions, handleName, { fsPath, range });
  }

  private extractInTextHandleDefinitions(
    content: string,
    lineNumber: number,
    indent: number,
    fsPath: string,
    definitions: Map<HandleName, HandleDefinition[]>,
  ): void {
    IN_TEXT_DEF_REGEX.lastIndex = 0;
    let match;
    while ((match = IN_TEXT_DEF_REGEX.exec(content)) !== null) {
      const handleName = match[1] ?? match[3];
      const handleNameStart = match.index + match[0].indexOf(handleName);
      const range = new vscode.Range(
        lineNumber,
        indent + handleNameStart,
        lineNumber,
        indent + handleNameStart + handleName.length,
      );
      this.addDefinition(definitions, handleName, { fsPath, range });
    }
  }

  private addDefinition(
    definitionsByHandle: Map<HandleName, HandleDefinition[]>,
    handleName: HandleName,
    definition: HandleDefinition,
  ): void {
    const definitions = definitionsByHandle.get(handleName) || [];
    definitions.push(definition);
    definitionsByHandle.set(handleName, definitions);
  }

  private extractHandleUsage(
    content: string,
    lineNumber: number,
    indent: number,
    fsPath: string,
    suppressDiagnostics = false,
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
      link.data = {
        handleName,
        fsPath,
        validated: ValidationState.UNKNOWN,
        suppressDiagnostics,
      };
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
      if (link.data.suppressDiagnostics) {
        link.data.validated = ValidationState.OK;
        continue;
      }

      // if it doesn't match the strict regex, underline it in red immediately.
      if (!strictRegex.test(handleName)) {
        link.data.validated = ValidationState.ERROR;
        diagnostics.push(
          new vscode.Diagnostic(
            link.range,
            `Invalid handle name: '${handleName}'. Handles may contain letters, numbers, marks, dots, underscores, hyphens, colons, apostrophes, and carets, and must end with a letter, number, mark, underscore, apostrophe, or caret.`,
            vscode.DiagnosticSeverity.Error,
          ),
        );
        continue; // Skip tree lookup for invalid names
      }

      const resolution = this.resolveDefinitionForHandle(
        handleName,
        currentFsPath,
      );

      if (resolution.kind === "ok") {
        // exactly one definition found in this logical tree
        link.data.validated = ValidationState.OK;
      } else {
        // zero or multiple definitions found
        link.data.validated = ValidationState.ERROR;
        const diagnostic = this.createDiagnosticForUsage(
          link,
          handleName,
          resolution,
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
    resolution: HandleResolution,
  ): vscode.Diagnostic | null {
    if (resolution.kind === "ok") {
      return null; // No error
    }

    let message: string;
    if (resolution.kind === "notFound") {
      message = `Handle '${handleName}' not found`;
    } else if (resolution.kind === "inaccessible") {
      const locationInfo = this.formatDefinitionLocations(
        resolution.definitions,
      );
      message = `Handle '${handleName}' is defined only in inaccessible commented-out fragments: \n ${locationInfo}`;
    } else {
      const locationInfo = this.formatDefinitionLocations(
        resolution.definitions,
      );
      message = `Handle '${handleName}' has multiple definitions (${resolution.definitions.length} found): \n ${locationInfo}`;
    }

    return new vscode.Diagnostic(
      link.range,
      message,
      vscode.DiagnosticSeverity.Error,
    );
  }

  private formatDefinitionLocations(definitions: HandleDefinition[]): string {
    return definitions
      .map((def) => {
        const relativePath = this.getRelativeWorkspacePath(def.fsPath);
        const lineNumber = def.range.start.line + 1;
        return `${relativePath}:${lineNumber}`;
      })
      .join("\n ");
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

  private getDefinitions(handleName: string): HandleDefinition[] {
    return this.definitions.get(handleName) || [];
  }

  private findDefinitionsInDocumentTree(
    handleName: string,
    currentFsPath: string,
  ): HandleDefinition[] {
    return this.getDefinitions(handleName).filter((def) =>
      this.isInSameDocumentTree(currentFsPath, def.fsPath),
    );
  }

  private findDefinitionsInAccessibleIslands(
    handleName: string,
    currentFsPath: string,
  ): HandleDefinition[] {
    return this.findDefinitionsInDocumentTree(handleName, currentFsPath).filter(
      (def) => isInAccessibleHashIsland(currentFsPath, def.fsPath),
    );
  }

  private findDefinitionsInSameIsland(
    handleName: string,
    currentFsPath: string,
  ): HandleDefinition[] {
    return this.findDefinitionsInDocumentTree(handleName, currentFsPath).filter(
      (def) => isInSameHashIsland(currentFsPath, def.fsPath),
    );
  }

  private findDefinitionsInInaccessibleIslands(
    handleName: string,
    currentFsPath: string,
  ): HandleDefinition[] {
    return this.findDefinitionsInDocumentTree(handleName, currentFsPath).filter(
      (def) => !isInAccessibleHashIsland(currentFsPath, def.fsPath),
    );
  }

  private resolveDefinitionForHandle(
    handleName: string,
    currentFsPath: string,
  ): HandleResolution {
    const accessibleDefinitions = this.findDefinitionsInAccessibleIslands(
      handleName,
      currentFsPath,
    );
    const goodDefinitions = accessibleDefinitions.filter(
      (def) => !this.isDefinitionAmbiguous(handleName, def),
    );
    const nearestGoodDefinitions =
      this.getNearestIslandDefinitions(goodDefinitions);

    if (nearestGoodDefinitions.length === 1) {
      return { kind: "ok", definition: nearestGoodDefinitions[0] };
    }

    if (accessibleDefinitions.length > 0) {
      return {
        kind: "multiple",
        definitions: this.dedupeDefinitions(accessibleDefinitions),
      };
    }

    const inaccessibleDefinitions = this.findDefinitionsInInaccessibleIslands(
      handleName,
      currentFsPath,
    );
    if (inaccessibleDefinitions.length > 0) {
      return {
        kind: "inaccessible",
        definitions: this.dedupeDefinitions(inaccessibleDefinitions),
      };
    }

    return { kind: "notFound" };
  }

  private isDefinitionAmbiguous(
    handleName: string,
    definition: HandleDefinition,
  ): boolean {
    return (
      this.dedupeDefinitions(
        this.findDefinitionsInSameIsland(handleName, definition.fsPath),
      ).length > 1
    );
  }

  private getNearestIslandDefinitions(
    definitions: HandleDefinition[],
  ): HandleDefinition[] {
    if (definitions.length <= 1) return definitions;

    const maxDepth = Math.max(
      ...definitions.map((def) => getHashIslandDepth(def.fsPath)),
    );
    return definitions.filter(
      (def) => getHashIslandDepth(def.fsPath) === maxDepth,
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

    const resolution = this.resolveDefinitionForHandle(
      handleName,
      currentFsPath,
    );

    if (resolution.kind !== "ok") {
      return undefined;
    }

    const definition = resolution.definition;
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
      const validDefinitions = this.findDefinitionsInSameIsland(
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

    const definition = this.getDefinitionAtPosition(document, position);
    if (definition) {
      const usages = this.getUsagesInDocumentTree(
        definition.handleName,
        document.uri.fsPath,
      );
      if (usages.length === 0) {
        void vscode.window.showInformationMessage(
          "no handle usages found in current document tree for this handle",
        );
        return new vscode.Location(document.uri, definition.range);
      }

      return usages.map(
        (handleUsage) =>
          new vscode.Location(
            vscode.Uri.file(handleUsage.fsPath),
            handleUsage.range,
          ),
      );
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
      if (!this.isHandleVisibleFromFile(handleName, defs, currentFsPath)) {
        continue;
      }
      completionItems.push(this.createHandleCompletionItem(handleName));
    }

    return completionItems;
  }

  private async goToHandleUsage(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !this.isWriterlyFile(editor.document.uri.fsPath)) {
      vscode.window.showErrorMessage(
        "Open a Writerly file and place the cursor on a handle.",
      );
      return;
    }

    if (!this.isInitialized) {
      vscode.window.showErrorMessage("Writerly handles are still indexing.");
      return;
    }

    const handle = this.getHandleAtPosition(
      editor.document,
      editor.selection.active,
    );
    if (!handle) {
      vscode.window.showErrorMessage("No handle found under cursor.");
      return;
    }

    const usages = this.getUsagesInDocumentTree(
      handle.handleName,
      editor.document.uri.fsPath,
    );
    if (usages.length === 0) {
      vscode.window.showErrorMessage(
        `Handle '${handle.handleName}' is not used in this document tree.`,
      );
      return;
    }

    if (usages.length === 1) {
      await this.openHandleUsage(usages[0]);
      return;
    }

    const selected = await vscode.window.showQuickPick(
      await Promise.all(usages.map((usage) => this.createUsageQuickPick(usage))),
      {
        placeHolder: `Select usage of '${handle.handleName}'`,
        matchOnDescription: true,
        matchOnDetail: true,
      },
    );
    if (!selected) return;

    await this.openHandleUsage(selected.usage);
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
    handleName: HandleName,
    definitions: HandleDefinition[],
    fsPath: string,
  ): boolean {
    return (
      definitions.length > 0 &&
      this.resolveDefinitionForHandle(handleName, fsPath).kind === "ok"
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

  private getUsagesInDocumentTree(
    handleName: HandleName,
    currentFsPath: FSPath,
  ): HandleUsage[] {
    const usages: HandleUsage[] = [];

    for (const [fsPath, links] of this.documentLinks) {
      if (!this.isInSameDocumentTree(currentFsPath, fsPath)) continue;

      for (const link of links) {
        if (link.data?.handleName !== handleName) continue;
        usages.push({
          fsPath,
          range: link.range,
          handleName,
        });
      }
    }

    return usages.sort(
      (a, b) =>
        this.getRelativeWorkspacePath(a.fsPath).localeCompare(
          this.getRelativeWorkspacePath(b.fsPath),
          undefined,
          { numeric: true, sensitivity: "base" },
        ) ||
        a.range.start.line - b.range.start.line ||
        a.range.start.character - b.range.start.character,
    );
  }

  private async createUsageQuickPick(
    usage: HandleUsage,
  ): Promise<vscode.QuickPickItem & { usage: HandleUsage }> {
    const relativePath = this.getRelativeWorkspacePath(usage.fsPath);
    const lineNumber = usage.range.start.line + 1;
    const linePreview = await this.getUsageLinePreview(usage);

    return {
      label: `${relativePath}:${lineNumber}`,
      description: usage.handleName,
      detail: linePreview,
      usage,
    };
  }

  private async getUsageLinePreview(usage: HandleUsage): Promise<string> {
    try {
      const document = await vscode.workspace.openTextDocument(
        vscode.Uri.file(usage.fsPath),
      );
      return document.lineAt(usage.range.start.line).text.trim();
    } catch {
      return "";
    }
  }

  private async openHandleUsage(usage: HandleUsage): Promise<void> {
    const document = await vscode.workspace.openTextDocument(
      vscode.Uri.file(usage.fsPath),
    );
    const editor = await vscode.window.showTextDocument(document, {
      preview: false,
      selection: usage.range,
    });
    editor.revealRange(usage.range, vscode.TextEditorRevealType.InCenter);
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
      const handleName = match[1] ?? match[3];
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
    const lineType = WriterlyDocumentWalker.onTheFlyLineClassification(
      document,
      position,
    );
    if (!this.shouldProcessUsageInLine(lineType)) return undefined;

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
    return (
      this.getDefinitionAtPosition(document, position) ??
      this.getUsageOnLine(document, position)
    );
  }

  private getDefinitionAtPosition(
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

    return undefined;
  }

  private getDefinitionForHandle(
    handleName: string,
    currentFsPath: string,
  ): vscode.Definition | undefined {
    const resolution = this.resolveDefinitionForHandle(
      handleName,
      currentFsPath,
    );

    // only provide definition for single, unambiguous handles
    if (resolution.kind !== "ok") {
      return undefined;
    }

    const definition = resolution.definition;
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
      this.writerlyContainers,
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
    validateUnusedHandles: boolean,
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

      const treeDefs = this.findDefinitionsInSameIsland(
        handleName,
        currentFsPath,
      );
      const uniqueTreeDefs = this.dedupeDefinitions(treeDefs);
      if (uniqueTreeDefs.length > 1) {
        this.addDuplicateHandleDefinitionDiagnostics(
          handleName,
          localDefs,
          uniqueTreeDefs,
          diagnostics,
        );
        return;
      }

      if (validateUnusedHandles && this.isUnusedWarningEnabled()) {
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
    conflictingDefinitions: HandleDefinition[],
    diagnostics: vscode.Diagnostic[],
  ): void {
    const locationInfo = this.formatDefinitionLocations(
      conflictingDefinitions,
    );
    definitions.forEach((definition) => {
      diagnostics.push(
        new vscode.Diagnostic(
          definition.range,
          `Handle '${handleName}' is defined in multiple places (${conflictingDefinitions.length}) in this document tree:\n ${locationInfo}`,
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
        // 3. only process if it belongs to the same tree
        if (this.isInSameDocumentTree(originFsPath, fsPath)) {
          const openDoc = openDocsMap.get(fsPath);

          // we only update diagnostics for open documents to save UI thread resources.
          // closed documents will be validated when the user opens them.
          if (openDoc) {
            // Re-process the document to gather all current diagnostics (including indentation)
            // but set triggerRevalidation to false to prevent infinite loops
            void this.processDocument(openDoc, false, true);
          }
        }
      }
    }, 300);
  }

  private triggerMissingFileRevalidation(uri: vscode.Uri): void {
    if (this.isWriterlyFile(uri.fsPath)) return;
    if (this.shouldIgnoreAssetWatcherPath(uri.fsPath)) return;
    if (!this.isMissingFileWarningEnabled()) return;

    if (this.missingFileRevalidateTimer) {
      clearTimeout(this.missingFileRevalidateTimer);
    }

    this.missingFileRevalidateTimer = setTimeout(() => {
      for (const doc of vscode.workspace.textDocuments) {
        if (this.isWriterlyFile(doc.uri.fsPath)) {
          this.queueMissingFileValidation(doc, 1000);
        }
      }
    }, 1000);
  }

  private shouldIgnoreAssetWatcherPath(fsPath: string): boolean {
    const parts = path.resolve(fsPath).split(path.sep);
    return parts.some((part) =>
      ["node_modules", ".git", "dist", "build", "out"].includes(part),
    );
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
    return getDocumentTreeKeys(fsPath, this.writerlyContainers);
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

  private rebuildHandleIndexes(): void {
    this.definitions.clear();
    for (const definitionsByHandle of this.definitionsByFile.values()) {
      for (const [handleName, definitions] of definitionsByHandle) {
        const globalDefinitions = this.definitions.get(handleName) ?? [];
        globalDefinitions.push(...definitions);
        this.definitions.set(handleName, globalDefinitions);
      }
    }

    this.usageCounts.clear();
    for (const links of this.documentLinks.values()) {
      for (const link of links) {
        if (link.data.suppressDiagnostics) continue;
        this.addUsageCount(link.data.handleName, link.data.fsPath);
      }
    }
  }

  private addUsageCount(handleName: string, fsPath: string) {
    let countsByTree = this.usageCounts.get(handleName);
    if (!countsByTree) {
      countsByTree = new Map();
      this.usageCounts.set(handleName, countsByTree);
    }

    for (const treeKey of this.getDocumentTreeKeys(fsPath)) {
      const current = countsByTree.get(treeKey) || 0;
      countsByTree.set(treeKey, current + 1);
    }
  }
  private isUnusedWarningEnabled(): boolean {
    return vscode.workspace
      .getConfiguration("writerly")
      .get<boolean>("enableUnusedHandleWarnings", true);
  }

  private isMissingFileWarningEnabled(): boolean {
    return vscode.workspace
      .getConfiguration("writerly")
      .get<boolean>("enableMissingFileWarnings", true);
  }
}
