import * as vscode from "vscode";
import * as path from "path";
import {
  fileUtils,
  type DirectoryResolution,
  type FileResolution,
} from "./utils/file-utils";
import {
  getWriterlyFileGlob,
  isWriterlyFilePath,
} from "./WriterlyFileExtensions";
import {
  getNearestWriterlyDocumentRoot,
  isPathUnderDirectory,
} from "./WriterlyDocumentTrees";

type FileCommandTarget = {
  filePath: string;
  resolution: FileResolution;
  pathRange: vscode.Range;
  resolutionRoot: string;
  document: vscode.TextDocument;
  position: vscode.Position;
  ambiguityNotes: string[];
};

type FileCommandOptions = {
  requireExistingFile: boolean;
  reportErrors?: boolean;
  throwOnAmbiguousPath?: boolean;
};

type ReferencePathParts = {
  dirPath: string;
  fileName: string;
};

type FileReferenceRenameMode = "fileName" | "directoryPath";

type FileReferenceRenameTarget = {
  mode: FileReferenceRenameMode;
  range: vscode.Range;
  placeholder: string;
};

type FileOperationEdit = {
  edit: vscode.WorkspaceEdit;
  successMessage: string;
};

const PATH_TOKEN_FORBIDDEN_CHARS = /[\s'"=\[\]\{\}\(\);!<>|]/;

class UserReportedFileOperationError extends Error {}

/*
 * WriterlyFileRenamer owns file-reference mutation workflows. It is mostly
 * stateless: each command or RenameProvider call resolves the path under the
 * active cursor, builds a one-shot WorkspaceEdit, applies or returns that edit,
 * and then discards all per-call data.
 *
 * Entry points:
 * - Commands:
 *   - writerly.renameFileUnderCursor prompts for a new basename.
 *   - writerly.moveFileUnderCursor prompts for a new directory path.
 *   - writerly.createFileUnderCursorFromTemplate creates a missing file path
 *     from the configured template directory.
 * - RenameProvider:
 *   - F2 over a filename builds the same file-rename edit as the command route.
 *   - F2 over a directory path builds the same file-move edit as the command route.
 *
 * Behaviors:
 * - Path resolution:
 *   - file references are resolved across the active Writerly workspace
 *   - each active document resolves paths relative to its nearest assemblable
 *     document root, falling back to the closest containing workspace folder
 *     when no such root contains it
 *   - ambiguous matches are resolved only when exactly one match has the
 *     shortest distance from that root to the candidate file directory
 *   - unresolved ambiguity stops the command and reports all tied matches
 * - Reference rewriting:
 *   - reference updates scan all active Writerly files in the workspace
 *   - candidate text matches are literal matches of the old reference string
 *   - each candidate's full path token is resolved from that document's root
 *   - only candidates resolving to the original physical file are rewritten
 *   - unresolved ambiguity in any candidate token aborts the whole operation
 *   - each changed document is replaced with a full-document text edit
 * - File operations:
 *   - rename/move edits use WorkspaceEdit.renameFile
 *   - command routes apply the WorkspaceEdit directly
 *   - RenameProvider routes return the WorkspaceEdit to VS Code
 * - User reporting:
 *   - command routes show success/error messages and modal disambiguation notes
 *   - RenameProvider routes rely on VS Code's rename UI for applying/reporting
 */
export class WriterlyFileRenamer implements vscode.RenameProvider {
  private readonly templateCreator = new WriterlyTemplateFileCreator();

  constructor(context: vscode.ExtensionContext) {
    const disposables = [
      vscode.commands.registerCommand("writerly.renameFileUnderCursor", () =>
        this.handleFileUnderCursor(
          (target) => this.renameFileUnderCursor(target),
          { requireExistingFile: true },
        ),
      ),
      vscode.commands.registerCommand("writerly.moveFileUnderCursor", () =>
        this.handleFileUnderCursor((target) => this.moveFileUnderCursor(target), {
          requireExistingFile: true,
        }),
      ),
      vscode.commands.registerCommand(
        "writerly.createFileUnderCursorFromTemplate",
        () =>
          this.handleFileUnderCursor(
            (target) =>
              this.templateCreator.createFileUnderCursorFromTemplate(target),
            { requireExistingFile: false },
          ),
      ),
      vscode.languages.registerRenameProvider(
        { scheme: "file", language: "writerly" },
        this,
      ),
    ];

    for (const disposable of disposables)
      context.subscriptions.push(disposable);
  }

  private async handleFileUnderCursor(
    handler: (target: FileCommandTarget) => Promise<void>,
    options: FileCommandOptions,
  ): Promise<void> {
    const editor = vscode.window.activeTextEditor;

    if (!editor) {
      reportFileCommandError("No active editor found");
      return;
    }

    if (!isWriterlyFilePath(editor.document.uri.fsPath)) {
      reportFileCommandError(
        "Writerly file commands are disabled for this file extension",
      );
      return;
    }

    const target = await this.getFileCommandTarget(
      editor.document,
      editor.selection.active,
      { ...options, reportErrors: true },
    );
    if (!target) return;

    try {
      await handler(target);
    } catch (error) {
      if (error instanceof UserReportedFileOperationError) return;
      reportFileCommandError("Writerly file command failed unexpectedly", error);
    }
  }

  private async getFileCommandTarget(
    document: vscode.TextDocument,
    position: vscode.Position,
    options: FileCommandOptions,
  ): Promise<FileCommandTarget | undefined> {
    const resolutionRoot = await getDocumentResolutionRoot(document.uri.fsPath);
    const { result: fileResolution, error: resolutionError } = await tryCatch(
      fileUtils.getFileResolutionAtPosition(
        document,
        position,
        { rootRelativeTo: document.uri.fsPath, resolutionRoot },
      ),
    );
    if (!fileResolution || resolutionError) {
      reportFileCommandIssue(
        "Failed to resolve file path under cursor",
        options,
        resolutionError,
      );
      return;
    }

    const [pathRange, filePath, resolution] = fileResolution;
    if (!filePath) {
      reportFileCommandIssue("No file path found under cursor", options);
      return;
    }

    if (resolution.kind === "ambiguous") {
      const message = `Multiple matching files found for "${filePath}" and document-root distance could not choose one. Matches: ${formatPathList(resolution.fsPaths)}`;
      if (options.throwOnAmbiguousPath) throw new Error(message);
      reportFileCommandIssue(message, options);
      return;
    }

    if (resolution.kind === "notFound" && options.requireExistingFile) {
      reportFileCommandIssue(`File not found: ${filePath}`, options);
      return;
    }

    const ambiguityNotes = getResolvedAmbiguousPathNote(filePath, resolution);

    return {
      filePath,
      resolution,
      pathRange,
      resolutionRoot,
      document,
      position,
      ambiguityNotes: ambiguityNotes ? [ambiguityNotes] : [],
    };
  }

  public async prepareRename(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<{ range: vscode.Range; placeholder: string } | undefined> {
    if (!isWriterlyFilePath(document.uri.fsPath)) return undefined;

    const target = await this.getFileCommandTarget(document, position, {
      requireExistingFile: true,
      reportErrors: false,
      throwOnAmbiguousPath: true,
    });
    if (!target) return undefined;

    const renameTarget = getFileReferenceRenameTarget(target);
    if (!renameTarget) return undefined;

    return {
      range: renameTarget.range,
      placeholder: renameTarget.placeholder,
    };
  }

  public async provideRenameEdits(
    document: vscode.TextDocument,
    position: vscode.Position,
    newName: string,
    _token: vscode.CancellationToken,
  ): Promise<vscode.WorkspaceEdit | undefined> {
    if (!isWriterlyFilePath(document.uri.fsPath)) return undefined;

    const target = await this.getFileCommandTarget(document, position, {
      requireExistingFile: true,
      reportErrors: false,
      throwOnAmbiguousPath: true,
    });
    if (!target) return undefined;

    const renameTarget = getFileReferenceRenameTarget(target);
    if (!renameTarget) return undefined;

    const operation =
      renameTarget.mode === "fileName"
        ? await buildRenameFileEdit(target, newName)
        : await buildMoveFileEdit(target, newName);

    return operation?.edit;
  }

  private async renameFileUnderCursor(
    target: FileCommandTarget,
  ): Promise<void> {
    const resolvedPath = getExistingResolvedPath(target);
    if (!resolvedPath) return;
    const { result: newFileName, error } = await tryCatch(
      vscode.window.showInputBox({
        prompt: "Enter new file name",
        value: path.basename(resolvedPath),
        validateInput(value) {
          if (value.trim() === "") {
            return {
              message: "File name cannot be empty",
              severity: vscode.InputBoxValidationSeverity.Error,
            };
          }
          if (value.includes("/") || value.includes("\\")) {
            return {
              message: "File name cannot contain slashes",
              severity: vscode.InputBoxValidationSeverity.Error,
            };
          }
        },
      }),
    );
    if (!newFileName || error) {
      vscode.window.showErrorMessage("Failed to get new file name");
      console.error("Input box error:", error);
      return;
    }

    const operation = await buildRenameFileEdit(target, newFileName);
    if (!operation) return;

    await applyFileOperationEdit(operation, target.ambiguityNotes);
  }

  private async moveFileUnderCursor(target: FileCommandTarget): Promise<void> {
    const { filePath } = target;
    const { fileName, dirPath } = splitReferencePath(filePath);

    const { result: newDirPath, error } = await tryCatch(
      vscode.window.showInputBox({
        prompt: `Enter new directory path for "${fileName}"`,
        value: dirPath,
        validateInput(value) {
          if (value.trim() === "") {
            return {
              message: "Directory path cannot be empty",
              severity: vscode.InputBoxValidationSeverity.Error,
            };
          }
        },
      }),
    );
    if (!newDirPath || error) {
      vscode.window.showErrorMessage("Failed to get new directory path");
      console.error("Input box error:", error);
      return;
    }

    const operation = await buildMoveFileEdit(target, newDirPath);
    if (!operation) return;

    await applyFileOperationEdit(operation, target.ambiguityNotes);
  }
}

async function buildRenameFileEdit(
  target: FileCommandTarget,
  newFileName: string,
): Promise<FileOperationEdit | undefined> {
  const resolvedPath = getExistingResolvedPath(target);
  if (!resolvedPath) return undefined;

  const validationError = validateNewFileName(newFileName);
  if (validationError) {
    reportFileCommandError(validationError);
    return undefined;
  }

  const newResolvedFilePath = path.join(path.dirname(resolvedPath), newFileName);
  if (await pathExists(newResolvedFilePath)) {
    reportFileCommandError(
      "A file with the new name already exists in the same directory",
    );
    return undefined;
  }

  const newFilePath = replaceReferenceFileName(target.filePath, newFileName);
  const edit = await buildFileReferenceOperationEdit(
    resolvedPath,
    newResolvedFilePath,
    target.filePath,
    newFilePath,
  );

  return {
    edit,
    successMessage: `Renamed file to "${newFileName}" and updated references in Writerly files accordingly.`,
  };
}

async function buildMoveFileEdit(
  target: FileCommandTarget,
  newDirPath: string,
): Promise<FileOperationEdit | undefined> {
  const resolvedPath = getExistingResolvedPath(target);
  if (!resolvedPath) return undefined;

  if (newDirPath.trim() === "") {
    reportFileCommandError("Directory path cannot be empty");
    return undefined;
  }

  const { fileName } = splitReferencePath(target.filePath);
  const dirResolution = await fileUtils.resolveDirectoryPath(newDirPath, {
    rootRelativeTo: target.document.uri.fsPath,
    resolutionRoot: target.resolutionRoot,
  });
  const targetDir = getResolvedDirectoryPath(
    newDirPath,
    dirResolution,
    "No matching directory found in workspace for the provided path",
    undefined,
    target.ambiguityNotes,
  );
  if (!targetDir) return undefined;

  const newResolvedFilePath = path.join(targetDir, fileName);
  if (await pathExists(newResolvedFilePath)) {
    reportFileCommandError(
      "A file with the same name already exists in the target directory",
    );
    return undefined;
  }

  const newFilePath = joinReferencePath(newDirPath, fileName);
  const edit = await buildFileReferenceOperationEdit(
    resolvedPath,
    newResolvedFilePath,
    target.filePath,
    newFilePath,
  );

  return {
    edit,
    successMessage: `Moved file to "${newFilePath}" and updated references in Writerly files accordingly.`,
  };
}

async function buildFileReferenceOperationEdit(
  oldResolvedPath: string,
  newResolvedPath: string,
  oldReferencePath: string,
  newReferencePath: string,
): Promise<vscode.WorkspaceEdit> {
  const edit = new vscode.WorkspaceEdit();
  edit.renameFile(
    vscode.Uri.file(oldResolvedPath),
    vscode.Uri.file(newResolvedPath),
    { overwrite: false },
  );
  await WriterlyPathReferenceUpdater.addPathReplacementEdits(
    edit,
    oldResolvedPath,
    oldReferencePath,
    newReferencePath,
  );
  return edit;
}

// One-shot text rewrite used after filesystem rename/move. This intentionally
// scans current workspace files instead of depending on cached link-provider state.
class WriterlyPathReferenceUpdater {
  static async addPathReplacementEdits(
    workspaceEdit: vscode.WorkspaceEdit,
    oldResolvedPath: string,
    oldPath: string,
    newPath: string,
  ): Promise<void> {
    if (!vscode.workspace.workspaceFolders) {
      return;
    }

    const fileGlob = getWriterlyFileGlob();
    if (!fileGlob) return;

    const writerlyFiles = await vscode.workspace.findFiles(fileGlob);
    const pathRegex = new RegExp(
      `(^|[=\\(\\[\\{/ ])(${escapeRegExp(oldPath)})(?=\\s|[})\\]]|$)`,
      "g",
    );

    for (const uri of writerlyFiles) {
      const { result: document, error } = await tryCatch(
        vscode.workspace.openTextDocument(uri),
      );
      if (!document || error) {
        console.error("Error opening text document:", error);
        continue;
      }

      const text = document.getText();
      const newText = await this.replaceMatchingPathReferences(
        document,
        text,
        pathRegex,
        oldPath,
        newPath,
        oldResolvedPath,
      );
      if (newText === text) continue;

      const fullRange = new vscode.Range(
        document.positionAt(0),
        document.positionAt(text.length),
      );
      workspaceEdit.replace(uri, fullRange, newText);
    }
  }

  private static async replaceMatchingPathReferences(
    document: vscode.TextDocument,
    text: string,
    pathRegex: RegExp,
    oldPath: string,
    newPath: string,
    oldResolvedPath: string,
  ): Promise<string> {
    const resolutionRoot = await getDocumentResolutionRoot(document.uri.fsPath);
    let nextText = "";
    let lastIndex = 0;
    let changed = false;

    for (const match of text.matchAll(pathRegex)) {
      const prefix = match[1];
      const oldPathStart = match.index! + prefix.length;
      const oldPathEnd = oldPathStart + oldPath.length;
      const tokenText = getPathTokenAtOffset(text, oldPathStart);
      if (!tokenText) continue;

      const resolution = await fileUtils.resolveUniqueFilePath(tokenText, {
        rootRelativeTo: document.uri.fsPath,
        resolutionRoot,
      });

      if (resolution.kind === "ambiguous") {
        reportFileCommandError(
          `Ambiguous path "${tokenText}" in "${document.uri.fsPath}" could not be resolved during reference updates. Matches: ${formatPathList(resolution.fsPaths)}`,
        );
        throw new UserReportedFileOperationError(
          "Ambiguous path during reference updates",
        );
      }

      if (
        (resolution.kind === "unique" ||
          resolution.kind === "resolvedAmbiguous") &&
        path.resolve(resolution.fsPath) === path.resolve(oldResolvedPath)
      ) {
        nextText += text.slice(lastIndex, oldPathStart);
        nextText += newPath;
        lastIndex = oldPathEnd;
        changed = true;
      }
    }

    if (!changed) return text;
    return nextText + text.slice(lastIndex);
  }
}

// Template workflow for creating a missing file path from a matching template.
class WriterlyTemplateFileCreator {
  async createFileUnderCursorFromTemplate(
    target: FileCommandTarget,
  ): Promise<void> {
    const { filePath } = target;
    const { fileName, dirPath } = splitReferencePath(filePath);
    const targetDir = await this.resolveUniqueDirectory(
      dirPath,
      target.document.uri.fsPath,
      target.resolutionRoot,
      `No matching directory found in workspace for "${dirPath}"`,
      `Multiple matching directories found in workspace for "${dirPath}". Cannot determine where to create the file.`,
      target.ambiguityNotes,
    );
    if (!targetDir) return;

    const targetPath = path.join(targetDir, fileName);
    if (await pathExists(targetPath)) {
      vscode.window.showErrorMessage(
        `A file named "${fileName}" already exists in the target directory`,
      );
      return;
    }

    const templateDirSetting = vscode.workspace
      .getConfiguration("writerly")
      .get<string>("templateFilesDirectory");

    if (!templateDirSetting || templateDirSetting.trim() === "") {
      vscode.window.showErrorMessage(
        'No template files directory configured. Set "writerly.templateFilesDirectory" in your workspace settings.',
      );
      return;
    }

    const templateDir = await this.resolveUniqueDirectory(
      templateDirSetting,
      target.document.uri.fsPath,
      target.resolutionRoot,
      `Template files directory "${templateDirSetting}" matches no directory in the workspace`,
      `Template files directory "${templateDirSetting}" matches multiple directories in the workspace. Please make it more specific.`,
      target.ambiguityNotes,
    );
    if (!templateDir) return;

    const selectedTemplate = await this.selectTemplateFile(
      templateDir,
      templateDirSetting,
      fileName,
    );
    if (!selectedTemplate) return;

    const { error: copyError } = await tryCatch(
      vscode.workspace.fs.copy(
        vscode.Uri.file(selectedTemplate),
        vscode.Uri.file(targetPath),
        { overwrite: false },
      ),
    );
    if (copyError) {
      vscode.window.showErrorMessage("Failed to create file from template");
      console.error("Copy error:", copyError);
      return;
    }

    await reportFileCommandSuccess(
      `Created "${fileName}" from template "${path.basename(selectedTemplate)}"`,
      target.ambiguityNotes,
    );
  }

  private async resolveUniqueDirectory(
    dirPath: string,
    rootRelativeTo: string,
    resolutionRoot: string,
    notFoundMessage: string,
    ambiguousMessage: string,
    ambiguityNotes: string[],
  ): Promise<string | undefined> {
    const resolution = await fileUtils.resolveDirectoryPath(dirPath, {
      rootRelativeTo,
      resolutionRoot,
    });
    return getResolvedDirectoryPath(
      dirPath,
      resolution,
      notFoundMessage,
      ambiguousMessage,
      ambiguityNotes,
    );
  }

  private async selectTemplateFile(
    templateDir: string,
    templateDirSetting: string,
    fileName: string,
  ): Promise<string | undefined> {
    const ext = path.extname(fileName);
    if (!ext) {
      vscode.window.showErrorMessage(`New file "${fileName}" has no extension`);
      return undefined;
    }

    const templateFiles = (
      await fileUtils.listFilesRecursively(templateDir)
    ).filter((filePath) => filePath.endsWith(ext));
    if (templateFiles.length === 0) {
      vscode.window.showErrorMessage(
        `No template files with extension "${ext}" found in "${templateDirSetting}"`,
      );
      return undefined;
    }

    return templateFiles.reduce((best, candidate) => {
      const bestLength = longestCommonSuffixLength(path.basename(best), fileName);
      const candidateLength = longestCommonSuffixLength(
        path.basename(candidate),
        fileName,
      );
      return candidateLength > bestLength ? candidate : best;
    });
  }
}

async function getDocumentResolutionRoot(fsPath: string): Promise<string> {
  const documentRoot = await getNearestWriterlyDocumentRoot(fsPath);
  if (documentRoot) return documentRoot;

  const workspaceFolder = getClosestWorkspaceFolder(fsPath);
  return workspaceFolder?.uri.fsPath ?? path.dirname(fsPath);
}

function getClosestWorkspaceFolder(
  fsPath: string,
): vscode.WorkspaceFolder | undefined {
  const folders = vscode.workspace.workspaceFolders ?? [];
  return folders
    .filter((folder) => isPathUnderDirectory(fsPath, folder.uri.fsPath))
    .sort((a, b) => b.uri.fsPath.length - a.uri.fsPath.length)[0];
}

function getPathTokenAtOffset(text: string, offset: number): string | undefined {
  if (offset < 0 || offset >= text.length) return undefined;

  let start = offset;
  while (start > 0 && !PATH_TOKEN_FORBIDDEN_CHARS.test(text[start - 1])) {
    start--;
  }

  let end = offset;
  while (end < text.length && !PATH_TOKEN_FORBIDDEN_CHARS.test(text[end])) {
    end++;
  }

  if (start === end) return undefined;
  return text.slice(start, end);
}

function getExistingResolvedPath(
  target: FileCommandTarget,
): string | undefined {
  if (
    target.resolution.kind === "unique" ||
    target.resolution.kind === "resolvedAmbiguous"
  ) {
    return target.resolution.fsPath;
  }

  reportFileCommandError(`File not found: ${target.filePath}`);
  return undefined;
}

function getFileReferenceRenameTarget(
  target: FileCommandTarget,
): FileReferenceRenameTarget | undefined {
  const { dirPath, fileName } = splitReferencePath(target.filePath);
  const pathStart = target.pathRange.start.character;
  const cursor = target.position.character;

  if (!dirPath) {
    return {
      mode: "fileName",
      range: target.pathRange,
      placeholder: fileName,
    };
  }

  const dirStart = pathStart;
  const dirEnd = pathStart + dirPath.length;
  const fileStart = dirEnd + 1;
  const fileEnd = fileStart + fileName.length;

  if (cursor >= dirStart && cursor <= dirEnd) {
    return {
      mode: "directoryPath",
      range: new vscode.Range(
        target.pathRange.start.line,
        dirStart,
        target.pathRange.start.line,
        dirEnd,
      ),
      placeholder: dirPath.includes("/") ? dirPath : "<dirpath>",
    };
  }

  if (cursor >= fileStart && cursor <= fileEnd) {
    return {
      mode: "fileName",
      range: new vscode.Range(
        target.pathRange.start.line,
        fileStart,
        target.pathRange.start.line,
        fileEnd,
      ),
      placeholder: fileName,
    };
  }

  return undefined;
}

function getResolvedDirectoryPath(
  referencePath: string,
  resolution: DirectoryResolution,
  notFoundMessage: string,
  ambiguousMessage?: string,
  ambiguityNotes?: string[],
): string | undefined {
  if (
    resolution.kind === "unique" ||
    resolution.kind === "resolvedAmbiguous"
  ) {
    const note = getResolvedAmbiguousPathNote(referencePath, resolution);
    if (note) ambiguityNotes?.push(note);
    return resolution.fsPath;
  }

  if (resolution.kind === "ambiguous") {
    reportFileCommandError(
      `${
        ambiguousMessage ??
        `Multiple matching directories found for "${referencePath}" and document-root distance could not choose one.`
      } Matches: ${formatPathList(resolution.fsPaths)}`,
    );
    return undefined;
  }

  reportFileCommandError(notFoundMessage);
  return undefined;
}

function splitReferencePath(filePath: string): ReferencePathParts {
  const segments = filePath.split("/");
  const fileName = segments.pop() || "";
  return { dirPath: segments.join("/"), fileName };
}

function replaceReferenceFileName(filePath: string, newFileName: string): string {
  const { dirPath } = splitReferencePath(filePath);
  return joinReferencePath(dirPath, newFileName);
}

function joinReferencePath(dirPath: string, fileName: string): string {
  return dirPath ? `${dirPath}/${fileName}` : fileName;
}

async function pathExists(filePath: string): Promise<boolean> {
  const { error } = await tryCatch(
    vscode.workspace.fs.stat(vscode.Uri.file(filePath)),
  );
  return !error;
}

function validateNewFileName(fileName: string): string | undefined {
  if (fileName.trim() === "") return "File name cannot be empty";
  if (fileName.includes("/") || fileName.includes("\\")) {
    return "File name cannot contain slashes";
  }
  return undefined;
}

function longestCommonSuffixLength(a: string, b: string): number {
  let i = 0;
  while (
    i < a.length &&
    i < b.length &&
    a[a.length - 1 - i] === b[b.length - 1 - i]
  ) {
    i++;
  }
  return i;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getResolvedAmbiguousPathNote(
  referencePath: string,
  resolution: FileResolution | DirectoryResolution,
): string | undefined {
  if (resolution.kind !== "resolvedAmbiguous") return undefined;

  const reason =
    resolution.reason === "documentRootDistance"
      ? "document-root distance"
      : "closest ancestor directory tie-breaking";
  return `Note: Ambiguous path "${referencePath}" matched multiple locations. Resolved to "${resolution.fsPath}" by ${reason}. Other matches: ${formatPathList(resolution.alternatives)}.`;
}

async function reportFileCommandSuccess(
  message: string,
  ambiguityNotes: string[],
): Promise<void> {
  vscode.window.showInformationMessage(message);

  for (const note of ambiguityNotes) {
    console.info(note);
    await vscode.window.showWarningMessage(note, { modal: true });
  }
}

async function applyFileOperationEdit(
  operation: FileOperationEdit,
  ambiguityNotes: string[],
): Promise<void> {
  const { result: applied, error } = await tryCatch(
    vscode.workspace.applyEdit(operation.edit),
  );
  if (error || !applied) {
    reportFileCommandError("Failed to apply file operation", error);
    return;
  }

  await reportFileCommandSuccess(operation.successMessage, ambiguityNotes);
}

function reportFileCommandError(message: string, error?: unknown): void {
  vscode.window.showErrorMessage(message);
  if (error) {
    console.error(message, error);
  }
}

function reportFileCommandIssue(
  message: string,
  options: FileCommandOptions,
  error?: unknown,
): void {
  if (options.reportErrors) {
    reportFileCommandError(message, error);
  } else if (error) {
    console.error(message, error);
  }
}

function formatPathList(paths: string[]): string {
  return paths.map((fsPath) => `"${fsPath}"`).join(", ");
}

function tryCatch<T, Error>(
  thenable: Thenable<T>,
): Promise<{ result?: T; error?: Error }> {
  return new Promise((resolve) => {
    thenable.then(
      (result) => {
        resolve({ result });
      },
      (error) => {
        resolve({ error });
      },
    );
  });
}
