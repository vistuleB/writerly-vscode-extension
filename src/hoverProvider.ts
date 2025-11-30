import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { FileOpener, OpeningMethod } from "./fileOpener";

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
      const fileSize = this.formatFileSize(stats.size);
      const lastModified = stats.mtime.toLocaleDateString();

      let hoverContent = new vscode.MarkdownString();
      hoverContent.supportHtml = true;
      hoverContent.isTrusted = true;

      // Opening link
      const openCommand = `command:writerly.openResolvedPath`;

      if (FileOpener.isImageFile(resolvedPath)) {
        const imageUri = vscode.Uri.file(resolvedPath);
        hoverContent.appendMarkdown(
          `[<img src="${imageUri.toString()}">](${openCommand}?${
            encodeURI(JSON.stringify([resolvedPath, OpeningMethod.WITH_DEFAULT]))
          })\n\n`,
        );  
      }
      
      // Add file information
      hoverContent.appendMarkdown(`📁 \`${resolvedPath}\` ${fileSize}, ${lastModified}\n\n`);

      // let separator = "\n\n"
      let separator = "&emsp;|&emsp;"

      hoverContent.appendMarkdown(
        `[← Open with default](${openCommand}?${
          encodeURI(JSON.stringify([resolvedPath, OpeningMethod.WITH_DEFAULT]))
        })${separator}`,
      );
      if (FileOpener.isImageFile(resolvedPath)) {
        hoverContent.appendMarkdown(
          `[📄 Open as text file](${openCommand}?${
            encodeURI(JSON.stringify([resolvedPath, OpeningMethod.WITH_VSCODE]))
          })${separator}`,
        );
        hoverContent.appendMarkdown(
          `[️️️️️️🖼️ Open as image](${openCommand}?${
            encodeURI(JSON.stringify([resolvedPath, OpeningMethod.AS_IMAGE_WITH_VSCODE]))
          })${separator}`,
        );
      } else {
        hoverContent.appendMarkdown(
          `[📄 Open with VSCode](${openCommand}?${
            encodeURI(JSON.stringify([resolvedPath, OpeningMethod.WITH_VSCODE]))
          })`,
        );
      }
            
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
}
