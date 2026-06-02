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
        this.handleFileUnderCursor(this.renameFileUnderCursor)
      ),
      vscode.commands.registerCommand("writerly.moveFileUnderCursor", () =>
        this.handleFileUnderCursor(this.moveFileUnderCursor)
      ),
    ];

    for (const disposable of disposables)
      context.subscriptions.push(disposable);
  }

  async handleFileUnderCursor(
    handler: (params: ActionParams) => Promise<void>
  ): Promise<void> {
    const editor = vscode.window.activeTextEditor;

    if (!editor) {
      vscode.window.showWarningMessage("No active editor found");
      return;
    }

    const [_, filePath, resolvedPath] =
      await fileUtils.getResolvedFilePathAtPosition(
        editor.document,
        editor.selection.active
      );
    if (!filePath) {
      vscode.window.showWarningMessage("No file path found under cursor");
      return;
    }
    if (!resolvedPath) {
      vscode.window.showWarningMessage(`File not found: ${filePath}`);
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
      })
    );
    if (!newFileName || error) {
      vscode.window.showErrorMessage("Failed to get new file name");
      console.error("Input box error:", error);
      return;
    }
    const newResolvedFilePath = resolvedPath.replace(/[^\/]+$/, newFileName);
    const { error: statError } = await tryCatch(
      vscode.workspace.fs.stat(vscode.Uri.file(newResolvedFilePath))
    );

    if (!statError) {
      vscode.window.showErrorMessage(
        "A file with the new name already exists in the same directory"
      );
    }

    const { error: renameError } = await tryCatch(
      vscode.workspace.fs.rename(
        vscode.Uri.file(resolvedPath),
        vscode.Uri.file(newResolvedFilePath)
      )
    );

    if (renameError) {
      vscode.window.showErrorMessage("Failed to rename file");
      console.error("Rename error:", renameError);
    }

    const newFilePath = filePath.replace(/[^\/]+$/, newFileName);
    await replacePathInWlyFiles(filePath, newFilePath);
  }

  async moveFileUnderCursor(params: ActionParams): Promise<void> {
    const { filePath, resolvedPath } = params;
    const { result: newDirPath, error } = await tryCatch(
      vscode.window.showInputBox({
        prompt: "Enter new file path",
        value: filePath.split("/").slice(0, -1).join("/"),
        validateInput(value) {
          if (value.trim() === "") {
            return {
              message: "File path cannot be empty",
              severity: vscode.InputBoxValidationSeverity.Error,
            };
          }
        },
      })
    );
    if (!newDirPath || error) {
      vscode.window.showErrorMessage("Failed to get new file path");
      console.error("Input box error:", error);
      return;
    }
    const foundDirs = await fileUtils.resolvePossibleDirPaths(newDirPath);
    if (foundDirs.length === 0) {
      vscode.window.showErrorMessage(
        "No matching directory found in workspace for the provided path"
      );
      return;
    }
    if (foundDirs.length > 1) {
      vscode.window.showErrorMessage(
        "Multiple matching directories found in workspace. Please provide a more specific path."
      );
      return;
    }
    const newResolvedFilePath = path.join(
      foundDirs[0],
      path.basename(filePath)
    );
    const { error: statError } = await tryCatch(
      vscode.workspace.fs.stat(vscode.Uri.file(newResolvedFilePath))
    );

    if (!statError) {
      vscode.window.showErrorMessage(
        "A file with the same name already exists in the target directory"
      );
    }

    const { error: moveError } = await tryCatch(
      vscode.workspace.fs.rename(
        vscode.Uri.file(resolvedPath),
        vscode.Uri.file(newResolvedFilePath)
      )
    );
    if (moveError) {
      vscode.window.showErrorMessage("Failed to move file");
      console.error("Move error:", moveError);
    }

    const newFilePath = path.join(newDirPath, filePath.split("/").pop()!);
    await replacePathInWlyFiles(filePath, newFilePath);
  }
}

async function replacePathInWlyFiles(
  oldPath: string,
  newPath: string
): Promise<void> {
  if (!vscode.workspace.workspaceFolders) {
    return;
  }

  const pattern = new vscode.RelativePattern(
    vscode.workspace.workspaceFolders[0],
    "**/*.wly"
  );

  const wlyFiles = await vscode.workspace.findFiles(pattern);

  await Promise.all(
    wlyFiles.map(async (uri) => {
      const { result: content, error } = await tryCatch(
        vscode.workspace.openTextDocument(uri)
      );
      if (!content || error) {
        console.error("Error opening text document:", error);
        return;
      }
      const text = content.getText();
      const newText = text.replace(
        new RegExp(`${escapeRegExp(oldPath)}(?=\\s|[})\\]]|$)`, "g"),
        newPath
      );
      if (newText !== text) {
        const edit = new vscode.WorkspaceEdit();
        const fullRange = new vscode.Range(
          content.positionAt(0),
          content.positionAt(text.length)
        );
        edit.replace(uri, fullRange, newText);
        const { error: applyError } = await tryCatch(
          vscode.workspace.applyEdit(edit)
        );
        if (applyError) {
          console.error("Error applying workspace edit:", applyError);
        }
      }
    })
  );
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tryCatch<T, Error>(
  thenable: Thenable<T>
): Promise<{ result?: T; error?: Error }> {
  return new Promise((resolve) => {
    thenable.then(
      (result) => {
        resolve({ result });
      },
      (error) => {
        resolve({ error });
      }
    );
  });
}
