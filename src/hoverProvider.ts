import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { FileOpener } from "./fileOpener";

export class WriterlyHoverProvider implements vscode.HoverProvider {
  public async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.Hover | undefined> {
    // Get the word/path under cursor
    const filePath = FileOpener.getPossiblePathAtPosition(document, position);
    if (!filePath) {
      return undefined;
    }

    // Try to resolve the file path
    const resolvedPath = await FileOpener.resolvePath(filePath);
    if (!resolvedPath) {
      return undefined;
    }

    try {
      const stats = fs.statSync(resolvedPath);
      const fileName = path.basename(resolvedPath);
      const fileExt = path.extname(resolvedPath).toLowerCase();
      const fileSize = this.formatFileSize(stats.size);
      const lastModified = stats.mtime.toLocaleDateString();

      let hoverContent = new vscode.MarkdownString();
      hoverContent.supportHtml = true;
      hoverContent.isTrusted = true;

      // Add file icon based on type
      const icon = this.getFileIcon(fileExt);
      hoverContent.appendMarkdown(`${icon} **${fileName}**\n\n`);

      // Add file information
      hoverContent.appendMarkdown(`📁 **Path:** \`${resolvedPath}\`\n\n`);
      hoverContent.appendMarkdown(`📏 **Size:** ${fileSize}\n\n`);
      hoverContent.appendMarkdown(`📅 **Modified:** ${lastModified}\n\n`);

      // Add special handling for images
      if (FileOpener.isImageFile(resolvedPath)) {
        const imageUri = vscode.Uri.file(resolvedPath);
        hoverContent.appendMarkdown(
          `![Image Preview](${imageUri.toString()})\n\n`,
        );
      }

      // Add action buttons
      const openCommand = `command:writerly.openFileUnderCursor`;
      hoverContent.appendMarkdown(
        `[🔗 Open with default app](${openCommand} "Open ${fileName}")`,
      );

      return new vscode.Hover(hoverContent);
    } catch (error) {
      // If there's an error reading file stats, just return basic hover
      let hoverContent = new vscode.MarkdownString();
      hoverContent.appendMarkdown(
        `📄 **File:** ${path.basename(resolvedPath)}\n\n`,
      );
      hoverContent.appendMarkdown(`📁 **Path:** \`${resolvedPath}\`\n\n`);

      const openCommand = `command:writerly.openFileUnderCursor`;
      hoverContent.appendMarkdown(`[🔗 Open with default app](${openCommand})`);

      return new vscode.Hover(hoverContent);
    }
  }

  /**
   * Format file size in human readable format
   */
  private formatFileSize(bytes: number): string {
    const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
    if (bytes === 0) return "0 Bytes";
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return Math.round((bytes / Math.pow(1024, i)) * 100) / 100 + " " + sizes[i];
  }

  /**
   * Get appropriate icon for file type
   */
  private getFileIcon(extension: string): string {
    const iconMap: { [key: string]: string } = {
      ".png": "🖼️",
      ".jpg": "🖼️",
      ".jpeg": "🖼️",
      ".gif": "🖼️",
      ".bmp": "🖼️",
      ".svg": "🎨",
      ".webp": "🖼️",
      ".ico": "🖼️",
      ".pdf": "📄",
      ".txt": "📝",
      ".md": "📝",
      ".html": "🌐",
      ".css": "🎨",
      ".js": "📜",
      ".ts": "📜",
      ".json": "🔧",
      ".xml": "🔧",
      ".yml": "🔧",
      ".yaml": "🔧",
    };

    return iconMap[extension] || "📄";
  }
}
