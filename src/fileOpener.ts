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

    // Validate line length to prevent excessive processing
    if (lineText.length > 10000) {
      return undefined;
    }

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

    // Reject extremely long strings to prevent memory issues
    if (str.length > 1000) return false;

    // Reject strings with suspicious patterns
    if (str.includes("\0") || str.match(/[<>:"|?*\x00-\x1f]/)) return false;

    // Has file extension
    const hasExtension = /\.[a-zA-Z0-9]{1,10}$/.test(str);
    if (hasExtension) return true;

    // Starts with relative path indicators
    if (str.startsWith("../") || str.startsWith("./")) return true;

    // Contains path separators and reasonable length
    if (
      str.includes("/") &&
      str.length > 2 &&
      str.length < 500 &&
      !str.startsWith("http")
    )
      return true;

    // Check against supported extensions
    for (const ext of FileOpener.SUPPORTED_EXTENSIONS) {
      if (str.endsWith(ext)) return true;
    }

    return false;
  }

  /**
   * Checks if a file path is within any workspace folder
   */
  private static isPathInWorkspace(filePath: string): boolean {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
      return false;
    }

    try {
      // Resolve real path to handle symbolic links
      const realPath = fs.realpathSync(filePath);
      const normalizedPath = path.normalize(realPath);

      return workspaceFolders.some((folder) => {
        const workspacePath = path.normalize(folder.uri.fsPath);
        return (
          normalizedPath.startsWith(workspacePath + path.sep) ||
          normalizedPath === workspacePath
        );
      });
    } catch {
      // If real path resolution fails, fall back to basic check
      const normalizedPath = path.normalize(filePath);
      return workspaceFolders.some((folder) => {
        const workspacePath = path.normalize(folder.uri.fsPath);
        return (
          normalizedPath.startsWith(workspacePath + path.sep) ||
          normalizedPath === workspacePath
        );
      });
    }
  }

  /**
   * Asks user for confirmation before opening files outside workspace
   */
  private static async confirmExternalFileAccess(
    filePath: string,
  ): Promise<boolean> {
    const fileName = path.basename(filePath);
    const result = await vscode.window.showWarningMessage(
      `The file "${fileName}" is outside your workspace. Do you want to open it?`,
      {
        modal: true,
        detail: `Path: ${filePath}\n\nOpening files outside your workspace may pose risks.`,
      },
      "Open Anyway",
      "Cancel",
    );

    return result === "Open Anyway";
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

    // If it's an absolute path, check workspace boundaries
    if (path.isAbsolute(filePath)) {
      if (fs.existsSync(filePath)) {
        // Check if path is within workspace
        if (!FileOpener.isPathInWorkspace(filePath)) {
          const confirmed =
            await FileOpener.confirmExternalFileAccess(filePath);
          if (!confirmed) {
            return undefined;
          }
        }
        return filePath;
      }
      return undefined;
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
          // File is within workspace
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
              // File is within workspace
              return resolvedPath;
            }
          }
        }
      }
    }

    return undefined;
  }

  /**
   * Validates and sanitizes file path to prevent command injection
   */
  private static validateAndSanitizeFilePath(filePath: string): string {
    if (!filePath || typeof filePath !== "string") {
      throw new Error("Invalid file path: must be a non-empty string");
    }

    // Remove null bytes and other dangerous characters
    const sanitized = filePath.replace(/\0/g, "").trim();

    // Normalize path first to handle encoded traversal attempts
    const normalized = path.normalize(sanitized);

    // Check for path traversal attempts after normalization
    if (normalized.includes("..") || sanitized.match(/[<>:"|?*\x00-\x1f]/)) {
      throw new Error("Invalid file path: contains dangerous characters");
    }

    // Additional check for various traversal patterns
    if (
      normalized.match(/\.\.[\\/]/) ||
      normalized.startsWith("../") ||
      normalized.startsWith("..\\")
    ) {
      throw new Error("Invalid file path: path traversal detected");
    }

    // Check path length to prevent buffer overflow
    if (normalized.length > 260) {
      // Windows MAX_PATH limit
      throw new Error("Invalid file path: path too long");
    }

    return normalized;
  }

  /**
   * Escapes file path for system command execution
   */
  private static escapeFilePath(filePath: string, platform: string): string {
    switch (platform) {
      case "win32":
        // Escape quotes and special characters for Windows
        return `"${filePath.replace(/"/g, '""')}"`;
      case "darwin":
      case "linux":
      default:
        // Escape shell special characters for Unix-like systems
        return filePath.replace(/'/g, "'\"'\"'");
    }
  }

  /**
   * Opens a file with system's default application
   */
  public static async openWithDefaultApp(filePath: string): Promise<void> {
    try {
      // First, validate and sanitize the file path
      const sanitizedPath = FileOpener.validateAndSanitizeFilePath(filePath);

      // Use atomic file operation to avoid TOCTOU issues
      let stats: fs.Stats;
      try {
        stats = fs.statSync(sanitizedPath);
      } catch (statError) {
        throw new Error("File does not exist or is not accessible");
      }

      // Check if it's a regular file (not directory, symlink, etc.)
      if (!stats.isFile()) {
        throw new Error("Path does not point to a regular file");
      }

      // Additional check for file size to prevent issues with very large files
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

      // Try VSCode's built-in openExternal first
      const uri = vscode.Uri.file(sanitizedPath);

      try {
        await vscode.env.openExternal(uri);
        return;
      } catch (vscodeError) {
        console.log(
          `VSCode openExternal failed, falling back to system command: ${vscodeError}`,
        );
      }

      // Fallback to system command execution
      await FileOpener.openWithSystemCommand(sanitizedPath);
    } catch (error) {
      throw new Error(
        `Failed to open file: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  /**
   * Opens file using system command execution as fallback
   */
  private static async openWithSystemCommand(filePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let command: string;
      let args: string[];

      // Use command construction based on platform
      switch (process.platform) {
        case "darwin": // macOS
          command = "open";
          args = [filePath]; // macOS open command handles paths
          break;
        case "win32": // Windows
          // Use PowerShell's Invoke-Item with proper argument separation
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

  /**
   * Check if a file is a text file that should be opened in VSCode editor
   */
  private static isTextFile(filePath: string): boolean {
    const textExtensions = [
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
      ".writerly",
      ".wly",
    ];
    const ext = path.extname(filePath).toLowerCase();
    return textExtensions.includes(ext);
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

      // Open file using only VSCode APIs
      try {
        await FileOpener.openWithDefaultApp(resolvedPath);
        vscode.window.showInformationMessage(
          `Opened: ${path.basename(resolvedPath)}`,
        );
      } catch (error) {
        throw new Error(
          `Failed to open file: ${error instanceof Error ? error.message : "Unknown error"}`,
        );
      }
    } catch (error) {
      // Generic error message to avoid information disclosure
      vscode.window.showErrorMessage("Failed to open file");
      console.error("File opening error:", error);
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
