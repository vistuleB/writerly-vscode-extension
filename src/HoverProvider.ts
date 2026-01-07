import * as vscode from "vscode";
import * as fs from "fs";
import { FileOpener, OpeningMethod } from "./FileOpener";

export class HoverProvider implements vscode.HoverProvider {
  constructor(context: vscode.ExtensionContext) {
    let disposables = [
      vscode.languages.registerHoverProvider(
        { scheme: "file", language: "writerly" },
        this,
      ),
    ];

    for (const disposable of disposables)
      context.subscriptions.push(disposable);
  }

  /**
   * HoverProvider is stateless, so reset does nothing.
   * Defined to satisfy the WriterlyController's reset loop.
   */
  public reset(): void {
    // No internal state to clear.
  }

  public async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken,
  ): Promise<vscode.Hover | undefined> {
    const [range, _filePath, resolvedPath] =
      await FileOpener.getResolvedFilePathAtPosition(document, position);

    if (!resolvedPath) return undefined;

    let hoverContent = new vscode.MarkdownString();
    hoverContent.supportHtml = true;
    hoverContent.isTrusted = true;

    let separator = "&emsp;|&emsp;";
    const openCommand = `command:writerly.openResolvedPath`;
    const revealCommand = `command:revealInExplorer`;

    const appendOpeningLinks = () => {
      hoverContent.appendMarkdown(
        `[← Open with default](${openCommand}?${encodeURI(
          JSON.stringify([resolvedPath, OpeningMethod.WITH_DEFAULT]),
        )})${separator}`,
      );
      const fileUri = vscode.Uri.file(resolvedPath);
      if (FileOpener.isImageFile(resolvedPath)) {
        hoverContent.appendMarkdown(
          `[📄 Open as text file](${openCommand}?${encodeURI(
            JSON.stringify([resolvedPath, OpeningMethod.WITH_VSCODE]),
          )})${separator}`,
        );
        hoverContent.appendMarkdown(
          `[️️️️️️🖼️ Open as image](${openCommand}?${encodeURI(
            JSON.stringify([resolvedPath, OpeningMethod.AS_IMAGE_WITH_VSCODE]),
          )})${separator}`,
        );
      } else {
        hoverContent.appendMarkdown(
          `[📄 Open with VSCode](${openCommand}?${encodeURI(
            JSON.stringify([resolvedPath, OpeningMethod.WITH_VSCODE]),
          )})${separator}`,
        );
      }
      hoverContent.appendMarkdown(
        `[🔍 Show in Explorer](${revealCommand}?${encodeURI(
          JSON.stringify([fileUri]),
        )})\n\n`,
      );
    };

    const appendLinkedImage = () => {
      if (FileOpener.isImageFile(resolvedPath)) {
        const imageUri = vscode.Uri.file(resolvedPath);
        hoverContent.appendMarkdown(
          `[<img src="${imageUri.toString()}">](${openCommand}?${encodeURI(
            JSON.stringify([resolvedPath, OpeningMethod.WITH_DEFAULT]),
          )})\n\n`,
        );
      }
    };

    const appendFilePath = () => {
      hoverContent.appendMarkdown(`📁 \`${resolvedPath}\`\n\n`);
    };

    const appendFileSize = () => {
      try {
        const stats = fs.statSync(resolvedPath);
        const kbFileSize = this.kb(stats.size);
        const mbFileSize = this.mb(stats.size);
        if (kbFileSize < 2000) {
          hoverContent.appendMarkdown(`㎅ ${kbFileSize}\n\n`);
        } else {
          hoverContent.appendMarkdown(`㎆ ${mbFileSize}\n\n`);
        }
      } catch (error) {}
    };

    appendOpeningLinks();
    appendFilePath();
    appendLinkedImage();
    appendFileSize();

    return new vscode.Hover(hoverContent, range);
  }

  /**
   * Format file size in human readable format
   */
  // private formatFileSize(bytes: number): string {
  //   const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
  //   if (bytes === 0) return "0 Bytes";
  //   const i = Math.floor(Math.log(bytes) / Math.log(1024));
  //   return Math.round(100 * (bytes / Math.pow(1024, i))) / 100 + " " + sizes[i];
  // }

  private kb(bytes: number): number {
    return Math.round((10 * bytes) / 1024) / 10;
  }

  private mb(bytes: number): number {
    return Math.round((100 * bytes) / 1024 ** 2) / 100;
  }
}
