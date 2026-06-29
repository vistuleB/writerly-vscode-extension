import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { spawn } from "cross-spawn";
import { fileUtils } from "./utils/file-utils";

export enum OpeningMethod {
  WITH_DEFAULT,
  WITH_VSCODE,
  AS_IMAGE_WITH_VSCODE,
}

export class WriterlyFileOpener {
  constructor(context: vscode.ExtensionContext) {
    let disposables = [
      vscode.commands.registerCommand(
        "writerly.openUnderCursorWithDefault",
        () => WriterlyFileOpener.openUnderCursor(OpeningMethod.WITH_DEFAULT)
      ),

      vscode.commands.registerCommand(
        "writerly.openUnderCursorWithVSCode",
        () => WriterlyFileOpener.openUnderCursor(OpeningMethod.WITH_VSCODE)
      ),

      vscode.commands.registerCommand(
        "writerly.openUnderCursorAsImageWithVSCode",
        () =>
          WriterlyFileOpener.openUnderCursor(OpeningMethod.AS_IMAGE_WITH_VSCODE)
      ),

      vscode.commands.registerCommand("writerly.openFileWithDefault", () =>
        WriterlyFileOpener.openFileWithDefault()
      ),

      vscode.commands.registerCommand(
        "writerly.openResolvedPath",
        (path, method) => WriterlyFileOpener.openResolvedPath(path, method)
      ),
    ];

    for (const disposable of disposables)
      context.subscriptions.push(disposable);
  }

  /**
   * WriterlyFileOpener is stateless, so reset does nothing.
   * Defined to satisfy the WriterlyController's reset loop.
   */
  public reset(): void {
    // No internal state to clear.
  }

  public static async openFileWithDefault(): Promise<void> {
    const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
    let targetPath: string | undefined;

    // Get the URI from the active tab's input
    if (activeTab?.input && "uri" in (activeTab.input as any)) {
      const uri = (activeTab.input as any).uri as vscode.Uri;
      targetPath = uri.fsPath;
    }

    // Verify it's actually an image before calling the system
    if (targetPath && fileUtils.isImageFile(targetPath)) {
      await this.openResolvedPath(targetPath, OpeningMethod.WITH_DEFAULT);
    } else {
      vscode.window.showWarningMessage("Active file is not a supported image.");
    }
  }

  private static async openWithSystemCommand(filePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let command: string;
      let args: string[];

      switch (process.platform) {
        case "darwin": // macOS
          command = "open";
          args = [filePath];
          break;
        case "win32": // Windows
          command = "powershell.exe";
          args = [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Invoke-Item",
            "-LiteralPath",
            filePath,
          ];
          break;
        default: // Linux and others
          command = "xdg-open";
          args = [filePath];
          break;
      }

      // Execute with options
      const child = spawn(command, args, {
        stdio: "ignore",
        detached: true,
        windowsHide: true,
        shell: false, // Important: disable shell interpretation
      });

      let hasResolved = false;

      // Set timeout to prevent hanging
      const timeout = setTimeout(() => {
        if (!hasResolved) {
          hasResolved = true;
          child.kill();
          reject(new Error("Command execution timeout"));
        }
      }, 10000); // 10 second timeout

      child.on("error", (error: Error) => {
        if (!hasResolved) {
          hasResolved = true;
          clearTimeout(timeout);
          reject(new Error(`Failed to execute command: ${error.message}`));
        }
      });

      child.on("exit", (code: number | null) => {
        if (!hasResolved) {
          hasResolved = true;
          clearTimeout(timeout);
          if (code === 0 || code === null) {
            resolve();
          } else {
            reject(new Error(`Command failed with exit code ${code}`));
          }
        }
      });

      // Detach the child process
      if (process.platform !== "win32") {
        child.unref();
      }
    });
  }

  private static async justOpenItAlready(
    resolvedPath: string,
    method: OpeningMethod
  ): Promise<void> {
    const uri = vscode.Uri.file(resolvedPath);
    switch (method) {
      case OpeningMethod.WITH_DEFAULT: {
        try {
          await vscode.env.openExternal(uri);
        } catch (vscodeError) {
          console.log(
            `VSCode openExternal failed, falling back to system command: ${vscodeError}`
          );
          await WriterlyFileOpener.openWithSystemCommand(resolvedPath);
        }
        vscode.window.showInformationMessage(
          `Opened: ${path.basename(resolvedPath)}`
        );
        break;
      }
      case OpeningMethod.WITH_VSCODE: {
        await vscode.window.showTextDocument(uri);
        break;
      }
      case OpeningMethod.AS_IMAGE_WITH_VSCODE: {
        await vscode.commands.executeCommand("vscode.open", uri);
        break;
      }
    }
  }

  public static async openResolvedPath(
    resolvedPath: string,
    method: OpeningMethod
  ): Promise<void> {
    try {
      if (resolvedPath === undefined) {
        throw new Error("Received 'undefined' as argument");
      }

      if (resolvedPath === "") {
        throw new Error("Received empty string as argument");
      }

      let stats: fs.Stats;
      try {
        stats = fs.statSync(resolvedPath);
      } catch (statError) {
        throw new Error("File does not exist or is not accessible");
      }

      if (!stats.isFile()) {
        throw new Error("Path does not point to a regular file");
      }

      if (stats.size > 100 * 1024 * 1024) {
        // 100MB limit
        const shouldOpen = await vscode.window.showWarningMessage(
          "This file is very large. Opening it may affect performance.",
          "Open Anyway",
          "Cancel"
        );
        if (shouldOpen !== "Open Anyway") {
          return;
        }
      }

      this.justOpenItAlready(resolvedPath, method);
    } catch (error) {
      vscode.window.showErrorMessage("Failed to open file");
      console.error("File opening error:", error);
    }
  }

  public static async openAtPosition(
    document: vscode.TextDocument,
    position: vscode.Position,
    method: OpeningMethod
  ): Promise<void> {
    const [_, filePath, resolvedPath] =
      await fileUtils.getResolvedFilePathAtPosition(document, position);
    if (!filePath) {
      vscode.window.showWarningMessage("No file path found under cursor");
      return;
    }
    if (!resolvedPath) {
      vscode.window.showWarningMessage(`File not found: ${filePath}`);
      return;
    }
    await WriterlyFileOpener.openResolvedPath(resolvedPath, method);
  }

  public static async openUnderCursor(method: OpeningMethod): Promise<void> {
    const editor = vscode.window.activeTextEditor;

    if (!editor) {
      vscode.window.showWarningMessage("No active editor found");
      return;
    }

    this.openAtPosition(editor.document, editor.selection.active, method);
  }
}
