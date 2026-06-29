import * as vscode from "vscode";
import * as path from "path";
import { fileUtils } from "./utils/file-utils";

type ActionParams = {
  filePath: string;
  resolvedPath: string;
  document: vscode.TextDocument;
  position: vscode.Position;
};

export class WriterlyFileRenamer {
  constructor(context: vscode.ExtensionContext) {
    const disposables = [
      vscode.commands.registerCommand("writerly.renameFileUnderCursor", () =>
        this.handleFileUnderCursor(this.renameFileUnderCursor),
      ),
      vscode.commands.registerCommand("writerly.moveFileUnderCursor", () =>
        this.handleFileUnderCursor(this.moveFileUnderCursor),
      ),
      vscode.commands.registerCommand(
        "writerly.createFileUnderCursorFromTemplate",
        () =>
          this.handleFileUnderCursor(this.createFileUnderCursorFromTemplate),
      ),
    ];

    for (const disposable of disposables)
      context.subscriptions.push(disposable);
  }

  async handleFileUnderCursor(
    handler: (params: ActionParams) => Promise<void>,
  ): Promise<void> {
    const editor = vscode.window.activeTextEditor;

    if (!editor) {
      vscode.window.showWarningMessage("No active editor found");
      return;
    }

    const [_, filePath, resolvedPath] =
      await fileUtils.getResolvedFilePathAtPosition(
        editor.document,
        editor.selection.active,
      );
    if (!filePath) {
      vscode.window.showWarningMessage("No file path found under cursor");
      return;
    }

    await handler({
      filePath,
      resolvedPath,
      document: editor.document,
      position: editor.selection.active,
    });
  }

  async renameFileUnderCursor(params: ActionParams): Promise<void> {
    const { filePath, resolvedPath } = params;

    if (!resolvedPath) {
      vscode.window.showWarningMessage(`File not found: ${filePath}`);
      return;
    }

    const { result: newFileName, error } = await tryCatch(
      vscode.window.showInputBox({
        prompt: "Enter new file name",
        value: resolvedPath.split("/").pop() || "",
        validateInput(value) {
          if (value.trim() === "") {
            return {
              message: "File name cannot be empty",
              severity: vscode.InputBoxValidationSeverity.Error,
            };
          }
          if (value.includes("/")) {
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
    const newResolvedFilePath = resolvedPath.replace(/[^\/]+$/, newFileName);
    const { error: statError } = await tryCatch(
      vscode.workspace.fs.stat(vscode.Uri.file(newResolvedFilePath)),
    );

    if (!statError) {
      vscode.window.showErrorMessage(
        "A file with the new name already exists in the same directory",
      );
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
    }

    const newFilePath = filePath.replace(/[^\/]+$/, newFileName);
    await replacePathInWlyFiles(filePath, newFilePath);

    vscode.window.showInformationMessage(
      `Renamed file to "${newFileName}" and updated references in .wly files accordingly.`,
    );
  }

  async moveFileUnderCursor(params: ActionParams): Promise<void> {
    const { filePath, resolvedPath } = params;

    if (!resolvedPath) {
      vscode.window.showWarningMessage(`File not found: ${filePath}`);
      return;
    }
    const segments = filePath.split("/");
    const fileName = segments.pop()!;
    const dirPart = segments.join("/");

    const { result: newDirPath, error } = await tryCatch(
      vscode.window.showInputBox({
        prompt: "Enter new file path",
        value: dirPart,
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
    const foundDirs = await fileUtils.resolvePossibleDirPaths(newDirPath);
    if (foundDirs.length === 0) {
      vscode.window.showErrorMessage(
        "No matching directory found in workspace for the provided path",
      );
      return;
    }
    if (foundDirs.length > 1) {
      vscode.window.showErrorMessage(
        "Multiple matching directories found in workspace. Please provide a more specific path.",
      );
      return;
    }
    const newResolvedFilePath = path.join(
      foundDirs[0],
      path.basename(filePath),
    );
    const { error: statError } = await tryCatch(
      vscode.workspace.fs.stat(vscode.Uri.file(newResolvedFilePath)),
    );

    if (!statError) {
      vscode.window.showErrorMessage(
        "A file with the same name already exists in the target directory",
      );
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
    }

    const newFilePath = path.join(newDirPath, fileName);
    await replacePathInWlyFiles(filePath, newFilePath);

    vscode.window.showInformationMessage(
      `Moved file to "${newFilePath}" and updated references in .wly files accordingly.`,
    );
  }

  async createFileUnderCursorFromTemplate(params: ActionParams): Promise<void> {
    const { filePath } = params;

    // --- identify a unique target directory that doesn't already contain the
    //     file we're about to create ---
    const segments = filePath.split("/");
    const fileName = segments.pop()!;
    const dirPart = segments.join("/");
    const targetDirs = await fileUtils.resolvePossibleDirPaths(dirPart);

    if (targetDirs.length === 0) {
      vscode.window.showErrorMessage(
        `No matching directory found in workspace for "${dirPart}"`,
      );
      return;
    }

    if (targetDirs.length > 1) {
      vscode.window.showErrorMessage(
        `Multiple matching directories found in workspace for "${dirPart}". Cannot determine where to create the file.`,
      );
      return;
    }

    const targetPath = path.join(targetDirs[0], fileName);
    const { error: targetStatError } = await tryCatch(
      vscode.workspace.fs.stat(vscode.Uri.file(targetPath)),
    );

    if (!targetStatError) {
      vscode.window.showErrorMessage(
        `A file named "${fileName}" already exists in the target directory`,
      );
      return;
    }

    // --- locate the workspace template files directory ---
    const templateDirSetting = vscode.workspace
      .getConfiguration("writerly")
      .get<string>("templateFilesDirectory");

      if (!templateDirSetting || templateDirSetting.trim() === "") {
      vscode.window.showErrorMessage(
        'No template files directory configured. Set "writerly.templateFilesDirectory" in your workspace settings.',
      );
      return;
    }

    const templateDirs =
      await fileUtils.resolvePossibleDirPaths(templateDirSetting);

      if (templateDirs.length === 0) {
      vscode.window.showErrorMessage(
        `Template files directory "${templateDirSetting}" matches no directory in the workspace`,
      );
      return;
    }

    if (templateDirs.length > 1) {
      vscode.window.showErrorMessage(
        `Template files directory "${templateDirSetting}" matches multiple directories in the workspace. Please make it more specific.`,
      );
      return;
    }

    const templateDir = templateDirs[0];

    // --- get the extension of the new file ---
    const ext = path.extname(fileName);
    if (!ext) {
      vscode.window.showErrorMessage(`New file "${fileName}" has no extension`);
      return;
    }

    // --- collect template files (recursively) sharing the same extension ---
    const templateFiles = (
      await fileUtils.listFilesRecursively(templateDir)
    ).filter((f) => f.endsWith(ext));
    if (templateFiles.length === 0) {
      vscode.window.showErrorMessage(
        `No template files with extension "${ext}" found in "${templateDirSetting}"`,
      );
      return;
    }

    // --- pick the template whose name shares the longest suffix ---
    let selectedTemplate = templateFiles[0];
    let bestSuffixLength = -1;
    for (const f of templateFiles) {
      const len = longestCommonSuffixLength(path.basename(f), fileName);
      if (len > bestSuffixLength) {
        bestSuffixLength = len;
        selectedTemplate = f;
      }
    }

    // --- copy the template to its new location ---
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

    vscode.window.showInformationMessage(
      `Created "${fileName}" from template "${path.basename(selectedTemplate)}"`,
    );
  }
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

async function replacePathInWlyFiles(
  oldPath: string,
  newPath: string,
): Promise<void> {
  if (!vscode.workspace.workspaceFolders) {
    return;
  }

  const pattern = new vscode.RelativePattern(
    vscode.workspace.workspaceFolders[0],
    "**/*.wly",
  );

  const wlyFiles = await vscode.workspace.findFiles(pattern);

  await Promise.all(
    wlyFiles.map(async (uri) => {
      const { result: content, error } = await tryCatch(
        vscode.workspace.openTextDocument(uri),
      );
      if (!content || error) {
        console.error("Error opening text document:", error);
        return;
      }
      const text = content.getText();
      const newText = text.replace(
        new RegExp(`${escapeRegExp(oldPath)}(?=\\s|[})\\]]|$)`, "g"),
        newPath,
      );
      if (newText !== text) {
        const edit = new vscode.WorkspaceEdit();
        const fullRange = new vscode.Range(
          content.positionAt(0),
          content.positionAt(text.length),
        );
        edit.replace(uri, fullRange, newText);
        const { error: applyError } = await tryCatch(
          vscode.workspace.applyEdit(edit),
        );
        if (applyError) {
          console.error("Error applying workspace edit:", applyError);
        }
      }
    }),
  );
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
