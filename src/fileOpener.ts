import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { spawn } from "cross-spawn";

const forbiddenChars = /[\s'"=\[\]\{\}\(\);]/;

export enum OpeningMethod {
  WITH_DEFAULT,
  WITH_VSCODE,
  AS_IMAGE_WITH_VSCODE,
}

export class FileOpener {
  private static getPossiblePathAtPosition(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): [vscode.Range, string] {
    const line = document.lineAt(position);
    const text = line.text;
    const end = this.moveCursorForwardWhileNotForbidden(text, position.character);
    const start = this.moveCursorBackwardWhileNotForbidden(text, position.character);
    const path = text.substring(start, end);
    const positionStart = new vscode.Position(position.line, start);
    const positionEnd = new vscode.Position(position.line, end);
    return [new vscode.Range(positionStart, positionEnd), path];
  }
  
  private static moveCursorForwardWhileNotForbidden(
    text: string,
    from: number,
  ): number {
    let length = text.length;
    let end = from;
    while (end < length) {
      let c = text.charAt(end);
      if (forbiddenChars.test(c)) break;
      end++;
    }
    return end;
  }

  private static moveCursorBackwardWhileNotForbidden(
    text: string,
    from: number,
  ): number {
    let start = from - 1;
    while (start >= 0) {
      let c = text.charAt(start);
      if (forbiddenChars.test(c)) break;
      start--;
    }
    return start + 1;
  }

  // public static getPossiblePathAtPosition(
  //   document: vscode.TextDocument,
  //   position: vscode.Position,
  // ): string {
  //   const line = document.lineAt(position);
  //   const text = line.text;
  //   return (
  //     this.grabCharsBackwardWhileNotForbidden(text, position.character) + 
  //     this.grabCharsForwardWhileNotForbidden(text, position.character)
  //   );
  // }
  
  // private static grabCharsForwardWhileNotForbidden(
  //   text: string,
  //   from: number,
  // ): string {
  //   let length = text.length;
  //   let end = from;
  //   while (end < length) {
  //     let c = text.charAt(end);
  //     if (forbiddenChars.test(c)) break;
  //     end++;
  //   }
  //   return text.substring(from, end);
  // }

  // private static grabCharsBackwardWhileNotForbidden(
  //   text: string,
  //   from: number,
  // ): string {
  //   let start = from - 1;
  //   while (start >= 0) {
  //     let c = text.charAt(start);
  //     if (forbiddenChars.test(c)) break;
  //     start--;
  //   }
  //   return text.substring(start + 1, from);
  // }

  public static isImageFile(filePath: string): boolean {
    for (const ext of [
      ".svg",
      ".png",
      ".ico",
      ".jpeg",
      ".jpg",
      ".gif",
    ]) {
      if (filePath.endsWith(ext)) return true;
    }
    return false;
  }

  public static async resolvePath(
    filePath: string,
  ): Promise<string> {
    while (true) {
      if (filePath.startsWith("/")) { filePath = filePath.slice(1); }
      else if (filePath.startsWith("../")) { filePath = filePath.slice(3); }
      else break;
    }
    let files = await vscode.workspace.findFiles(`**/${filePath}`, '{node_modules, .git}');
    return (files.length > 0) ? files[0].fsPath : "";
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
        case "win32":  // Windows
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
        default:        // Linux and others
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
    method: OpeningMethod,
  ): Promise<void> {
    const uri = vscode.Uri.file(resolvedPath);
    switch (method) {
      case OpeningMethod.WITH_DEFAULT: {
        try {
          await vscode.env.openExternal(uri)
        } catch(vscodeError) {
          console.log(
            `VSCode openExternal failed, falling back to system command: ${vscodeError}`,
          );
          await FileOpener.openWithSystemCommand(resolvedPath);
        }
        vscode.window.showInformationMessage(
          `Opened: ${path.basename(resolvedPath)}`,
        );
        break;
      }
      case OpeningMethod.WITH_VSCODE: {
        await vscode.window.showTextDocument(uri);
        break;
      }
      case OpeningMethod.AS_IMAGE_WITH_VSCODE: {
        await vscode.commands.executeCommand('vscode.open', uri);
        break;
      }
    }
  }

  public static async openResolvedPath(
    resolvedPath: string,
    method: OpeningMethod,
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
          "Cancel",
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

  public static async getResolvedFilePathAtPosition(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<[vscode.Range, string, string]> {
    const [range, filePath] = FileOpener.getPossiblePathAtPosition(document, position);
    if (!filePath) return [range, filePath, ""];
    const resolvedPath = await FileOpener.resolvePath(filePath);
    return [range, filePath, resolvedPath];
  }

  public static async openAtPosition(
    document: vscode.TextDocument,
    position: vscode.Position,
    method: OpeningMethod,
  ): Promise<void> {
    const [_, filePath, resolvedPath] = await FileOpener.getResolvedFilePathAtPosition(document, position);
    if (!filePath) {
      vscode.window.showWarningMessage("No file path found under cursor");
      return;
    }
    if (!resolvedPath) {
      vscode.window.showWarningMessage(`File not found: ${filePath}`);
      return;
    }
    await FileOpener.openResolvedPath(resolvedPath, method);
  }

  public static async openUnderCursor(method: OpeningMethod): Promise<void> {
    const editor = vscode.window.activeTextEditor;

    if (!editor) {
      vscode.window.showWarningMessage("No active editor found");
      return;
    }

    this.openAtPosition(
      editor.document,
      editor.selection.active,
      method,
    );
  }
}
