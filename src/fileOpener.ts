import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { spawn } from "cross-spawn";

export class FileOpener {
  private static readonly IMAGE_EXTENSIONS = [
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".bmp",
    ".svg",
    ".webp",
    ".ico",
  ];
  private static readonly SUPPORTED_EXTENSIONS = [
    ...FileOpener.IMAGE_EXTENSIONS,
    ".pdf",
    ".txt",
    ".md",
    ".html",
    ".css",
    ".js",
    ".ts",
    ".json",
    ".xml",
    ".yml",
    ".yaml",
  ];

  /**
   * Gets the file path under the cursor
   */
  public static getWordAtPosition(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): string | undefined {
    const line = document.lineAt(position);
    const lineText = line.text;
    const character = position.character;

    // Find file path at cursor position
    return FileOpener.findFilePathAtPosition(lineText, character);
  }

  /**
   * Find file path at specific character position in text
   */
  private static findFilePathAtPosition(
    text: string,
    position: number,
  ): string | undefined {
    // Split text into potential file path segments
    const segments = FileOpener.extractFilePathSegments(text);

    // Track current position while iterating through segments
    let currentPos = 0;

    for (const segment of segments) {
      // Find the start position of this segment in the text
      const startPos = text.indexOf(segment.original, currentPos);
      if (startPos === -1) continue;

      // Update current position for next iteration
      currentPos = startPos + segment.original.length;

      // Check if cursor position is within this segment
      if (
        position >= startPos &&
        position <= startPos + segment.original.length
      ) {
        return segment.cleaned;
      }
    }

    return undefined;
  }

  /**
   * Extract potential file path segments from text
   */
  private static extractFilePathSegments(
    text: string,
  ): Array<{ original: string; cleaned: string }> {
    const segments: Array<{ original: string; cleaned: string }> = [];

    // Find quoted strings first
    const quoteChars = ['"', "'", "`"];
    for (const quote of quoteChars) {
      let inQuote = false;
      let start = 0;

      for (let i = 0; i < text.length; i++) {
        if (text[i] === quote && (i === 0 || text[i - 1] !== "\\")) {
          if (inQuote) {
            // End of quoted string
            const quoted = text.substring(start, i + 1);
            const cleaned = text.substring(start + 1, i);
            if (FileOpener.looksLikeFilePath(cleaned)) {
              segments.push({ original: quoted, cleaned });
            }
            inQuote = false;
          } else {
            // Start of quoted string
            start = i;
            inQuote = true;
          }
        }
      }
    }

    // Find unquoted file paths (space-separated words that look like paths)
    const words = text.split(/\s+/);
    for (const word of words) {
      // Skip if already found as quoted
      const alreadyFound = segments.some((s) => s.original.includes(word));
      if (!alreadyFound && FileOpener.looksLikeFilePath(word)) {
        segments.push({ original: word, cleaned: word });
      }
    }

    return segments;
  }

  /**
   * Check if a string looks like a file path
   */
  private static looksLikeFilePath(str: string): boolean {
    if (!str || str.length === 0) return false;

    // Has file extension
    const hasExtension = /\.[a-zA-Z0-9]{1,10}$/.test(str);
    if (hasExtension) return true;

    // Starts with relative path indicators
    if (str.startsWith("../") || str.startsWith("./")) return true;

    // Contains path separators and reasonable length
    if (str.includes("/") && str.length > 2 && !str.startsWith("http"))
      return true;

    // Check against supported extensions
    for (const ext of FileOpener.SUPPORTED_EXTENSIONS) {
      if (str.endsWith(ext)) return true;
    }

    return false;
  }

  /**
   * Resolves a file path relative to the current workspace or document
   */
  public static async resolvePath(
    filePath: string,
    currentDocument: vscode.TextDocument,
  ): Promise<string | undefined> {
    if (!filePath) {
      return undefined;
    }

    // Clean the path
    filePath = filePath.trim();

    // If it's an absolute path, use it directly
    if (path.isAbsolute(filePath)) {
      return fs.existsSync(filePath) ? filePath : undefined;
    }

    // Try relative to current document directory
    const currentDir = path.dirname(currentDocument.uri.fsPath);
    let resolvedPath = path.resolve(currentDir, filePath);
    if (fs.existsSync(resolvedPath)) {
      return resolvedPath;
    }

    // Try relative to workspace root
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders) {
      for (const folder of workspaceFolders) {
        resolvedPath = path.resolve(folder.uri.fsPath, filePath);
        if (fs.existsSync(resolvedPath)) {
          return resolvedPath;
        }
      }
    }

    // Try with different extensions if no extension provided
    if (!path.extname(filePath)) {
      for (const ext of FileOpener.SUPPORTED_EXTENSIONS) {
        const pathWithExt = filePath + ext;

        // Try relative to current document
        resolvedPath = path.resolve(currentDir, pathWithExt);
        if (fs.existsSync(resolvedPath)) {
          return resolvedPath;
        }

        // Try relative to workspace root
        if (workspaceFolders) {
          for (const folder of workspaceFolders) {
            resolvedPath = path.resolve(folder.uri.fsPath, pathWithExt);
            if (fs.existsSync(resolvedPath)) {
              return resolvedPath;
            }
          }
        }
      }
    }

    return undefined;
  }

  /**
   * Opens a file with the system's default application
   */
  public static async openWithDefaultApp(filePath: string): Promise<void> {
    try {
      // First try using VSCode's built-in openExternal
      const uri = vscode.Uri.file(filePath);
      await vscode.env.openExternal(uri);
    } catch (error) {
      // If VSCode method fails, fallback to spawn approach
      console.log(`VSCode openExternal failed, trying spawn: ${error}`);

      return new Promise((resolve, reject) => {
        let command: string;
        let args: string[] = [];

        // Determine the command based on the platform
        switch (process.platform) {
          case "darwin": // macOS
            command = "open";
            args = [filePath];
            break;
          case "win32": // Windows
            command = "cmd";
            args = ["/c", "start", '""', `"${filePath}"`];
            break;
          default: // Linux and others
            command = "xdg-open";
            args = [filePath];
            break;
        }

        const child = spawn(command, args, {
          stdio: "ignore",
          detached: true,
          windowsHide: true,
        });

        child.on("error", (error: Error) => {
          reject(new Error(`Failed to open file: ${error.message}`));
        });

        child.on("exit", (code: number | null) => {
          if (code === 0 || code === null) {
            resolve();
          } else {
            reject(new Error(`Process exited with code ${code}`));
          }
        });

        // Detach the child process so it can continue running after VS Code closes
        if (process.platform !== "win32") {
          child.unref();
        }
      });
    }
  }

  /**
   * Fallback method to open file in VSCode when system opening fails
   */
  private static async openWithVSCode(filePath: string): Promise<void> {
    try {
      const uri = vscode.Uri.file(filePath);

      // For images and binary files, try to open with system viewer first
      if (FileOpener.isImageFile(filePath)) {
        // Try to show in VSCode preview
        await vscode.commands.executeCommand("vscode.open", uri);
      } else {
        // For text files, open as document in VSCode
        const document = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(document);
      }
    } catch (error) {
      throw new Error(
        `VSCode failed to open file: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  /**
   * Main function to open file under cursor
   */
  public static async openFileUnderCursor(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage("No active editor found");
      return;
    }

    const document = editor.document;
    const position = editor.selection.active;

    // Get the word/path under cursor
    const filePath = FileOpener.getWordAtPosition(document, position);
    if (!filePath) {
      vscode.window.showWarningMessage("No file path found under cursor");
      return;
    }

    try {
      // Resolve the file path
      const resolvedPath = await FileOpener.resolvePath(filePath, document);
      if (!resolvedPath) {
        vscode.window.showWarningMessage(`File not found: ${filePath}`);
        return;
      }

      // Try to open with system default app, fallback to VSCode
      try {
        await FileOpener.openWithDefaultApp(resolvedPath);
        vscode.window.showInformationMessage(
          `Opened: ${path.basename(resolvedPath)}`,
        );
      } catch (systemError) {
        console.log(
          `System open failed, trying VSCode fallback: ${systemError}`,
        );
        try {
          await FileOpener.openWithVSCode(resolvedPath);
          vscode.window.showInformationMessage(
            `Opened in VSCode: ${path.basename(resolvedPath)}`,
          );
        } catch (vscodeError) {
          throw new Error(
            `Both system and VSCode opening failed. System: ${systemError}. VSCode: ${vscodeError}`,
          );
        }
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      vscode.window.showErrorMessage(`Failed to open file: ${errorMessage}`);
    }
  }

  /**
   * Check if a file extension is supported for opening
   */
  public static isSupportedFile(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return FileOpener.SUPPORTED_EXTENSIONS.includes(ext);
  }

  /**
   * Check if a file is an image
   */
  public static isImageFile(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return FileOpener.IMAGE_EXTENSIONS.includes(ext);
  }
}
