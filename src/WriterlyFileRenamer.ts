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

type FileCommandTarget = {
  filePath: string;
  resolution: FileResolution;
  document: vscode.TextDocument;
  position: vscode.Position;
  ambiguityNotes: string[];
};

type FileCommandOptions = {
  requireExistingFile: boolean;
};

type ReferencePathParts = {
  dirPath: string;
  fileName: string;
};

// VS Code command adapter. It handles editor/cursor preflight and delegates the
// command workflows to focused helpers below.
export class WriterlyFileRenamer {
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

    const { result: fileResolution, error: resolutionError } = await tryCatch(
      fileUtils.getFileResolutionAtPosition(
        editor.document,
        editor.selection.active,
        { rootRelativeTo: editor.document.uri.fsPath },
      ),
    );
    if (!fileResolution || resolutionError) {
      reportFileCommandError(
        "Failed to resolve file path under cursor",
        resolutionError,
      );
      return;
    }

    const [_, filePath, resolution] = fileResolution;
    if (!filePath) {
      reportFileCommandError("No file path found under cursor");
      return;
    }

    if (resolution.kind === "ambiguous") {
      reportFileCommandError(
        `Multiple matching files found for "${filePath}" and closest ancestor directory tie-breaking could not choose one. Matches: ${formatPathList(resolution.fsPaths)}`,
      );
      return;
    }

    if (resolution.kind === "notFound" && options.requireExistingFile) {
      reportFileCommandError(`File not found: ${filePath}`);
      return;
    }

    const ambiguityNotes = getResolvedAmbiguousPathNote(filePath, resolution);

    try {
      await handler({
        filePath,
        resolution,
        document: editor.document,
        position: editor.selection.active,
        ambiguityNotes: ambiguityNotes ? [ambiguityNotes] : [],
      });
    } catch (error) {
      reportFileCommandError("Writerly file command failed unexpectedly", error);
    }
  }

  private async renameFileUnderCursor(
    target: FileCommandTarget,
  ): Promise<void> {
    const resolvedPath = getExistingResolvedPath(target);
    if (!resolvedPath) return;

    const { filePath } = target;
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

    const newResolvedFilePath = path.join(
      path.dirname(resolvedPath),
      newFileName,
    );
    if (await pathExists(newResolvedFilePath)) {
      vscode.window.showErrorMessage(
        "A file with the new name already exists in the same directory",
      );
      return;
    }

    const { error: renameError } = await tryCatch(
      vscode.workspace.fs.rename(
        vscode.Uri.file(resolvedPath),
        vscode.Uri.file(newResolvedFilePath),
      ),
    );

    if (renameError) {
      vscode.window.showErrorMessage("Failed to rename file");
      console.error("Rename error:", renameError);
      return;
    }

    const newFilePath = replaceReferenceFileName(filePath, newFileName);
    await WriterlyPathReferenceUpdater.replacePathInWriterlyFiles(
      filePath,
      newFilePath,
    );

    await reportFileCommandSuccess(
      `Renamed file to "${newFileName}" and updated references in Writerly files accordingly.`,
      target.ambiguityNotes,
    );
  }

  private async moveFileUnderCursor(target: FileCommandTarget): Promise<void> {
    const resolvedPath = getExistingResolvedPath(target);
    if (!resolvedPath) return;

    const { filePath } = target;
    const { fileName, dirPath } = splitReferencePath(filePath);

    const { result: newDirPath, error } = await tryCatch(
      vscode.window.showInputBox({
        prompt: "Enter new file path",
        value: dirPath,
        validateInput(value) {
          if (value.trim() === "") {
            return {
              message: "File path cannot be empty",
              severity: vscode.InputBoxValidationSeverity.Error,
            };
          }
        },
      }),
    );
    if (!newDirPath || error) {
      vscode.window.showErrorMessage("Failed to get new file path");
      console.error("Input box error:", error);
      return;
    }

    const dirResolution = await fileUtils.resolveDirectoryPath(newDirPath, {
      rootRelativeTo: target.document.uri.fsPath,
    });
    const targetDir = getResolvedDirectoryPath(
      newDirPath,
      dirResolution,
      "No matching directory found in workspace for the provided path",
      undefined,
      target.ambiguityNotes,
    );
    if (!targetDir) {
      return;
    }

    const newResolvedFilePath = path.join(targetDir, fileName);
    if (await pathExists(newResolvedFilePath)) {
      vscode.window.showErrorMessage(
        "A file with the same name already exists in the target directory",
      );
      return;
    }

    const { error: moveError } = await tryCatch(
      vscode.workspace.fs.rename(
        vscode.Uri.file(resolvedPath),
        vscode.Uri.file(newResolvedFilePath),
      ),
    );
    if (moveError) {
      vscode.window.showErrorMessage("Failed to move file");
      console.error("Move error:", moveError);
      return;
    }

    const newFilePath = joinReferencePath(newDirPath, fileName);
    await WriterlyPathReferenceUpdater.replacePathInWriterlyFiles(
      filePath,
      newFilePath,
    );

    await reportFileCommandSuccess(
      `Moved file to "${newFilePath}" and updated references in Writerly files accordingly.`,
      target.ambiguityNotes,
    );
  }
}

// One-shot text rewrite used after filesystem rename/move. This intentionally
// scans current workspace files instead of depending on cached link-provider state.
class WriterlyPathReferenceUpdater {
  static async replacePathInWriterlyFiles(
    oldPath: string,
    newPath: string,
  ): Promise<void> {
    if (!vscode.workspace.workspaceFolders) {
      return;
    }

    const fileGlob = getWriterlyFileGlob();
    if (!fileGlob) return;

    const writerlyFiles = await vscode.workspace.findFiles(fileGlob);
    const workspaceEdit = new vscode.WorkspaceEdit();
    const pathRegex = new RegExp(
      `${escapeRegExp(oldPath)}(?=\\s|[})\\]]|$)`,
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
      const newText = text.replace(pathRegex, newPath);
      if (newText === text) continue;

      const fullRange = new vscode.Range(
        document.positionAt(0),
        document.positionAt(text.length),
      );
      workspaceEdit.replace(uri, fullRange, newText);
    }

    if (workspaceEdit.size === 0) return;

    const { error: applyError } = await tryCatch(
      vscode.workspace.applyEdit(workspaceEdit),
    );
    if (applyError) {
      console.error("Error applying workspace edit:", applyError);
    }
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
    notFoundMessage: string,
    ambiguousMessage: string,
    ambiguityNotes: string[],
  ): Promise<string | undefined> {
    const resolution = await fileUtils.resolveDirectoryPath(dirPath, {
      rootRelativeTo,
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
        `Multiple matching directories found for "${referencePath}" and closest ancestor directory tie-breaking could not choose one.`
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

  return `Note: Ambiguous path "${referencePath}" matched multiple locations. Resolved to "${resolution.fsPath}" by closest ancestor directory tie-breaking. Other matches: ${formatPathList(resolution.alternatives)}.`;
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

function reportFileCommandError(message: string, error?: unknown): void {
  vscode.window.showErrorMessage(message);
  if (error) {
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
