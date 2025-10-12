import * as vscode from "vscode";

export default class WriterlyCodeActionProvider
  implements vscode.CodeActionProvider
{
  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];

    // Find indentation-related diagnostics
    const indentationDiagnostics = context.diagnostics.filter(
      (diagnostic) => diagnostic.source === "writerly-indentation",
    );

    // Find attribute-related diagnostics
    const attributeDiagnostics = context.diagnostics.filter(
      (diagnostic) =>
        diagnostic.message.includes("spaces before the equals sign") ||
        diagnostic.message.includes("Attribute key cannot be empty"),
    );

    // Find tag-related diagnostics
    const tagDiagnostics = context.diagnostics.filter(
      (diagnostic) => diagnostic.source === "writerly-tag-validation",
    );

    if (indentationDiagnostics.length > 0) {
      // Quick fix for individual line
      const fixLineAction = new vscode.CodeAction(
        "Fix indentation on this line",
        vscode.CodeActionKind.QuickFix,
      );
      fixLineAction.edit = this.createIndentationFix(document, range);
      fixLineAction.diagnostics = indentationDiagnostics;
      actions.push(fixLineAction);
    }

    if (attributeDiagnostics.length > 0) {
      // Quick fix for attribute formatting
      const fixAttributeAction = new vscode.CodeAction(
        "Remove spaces before equals sign",
        vscode.CodeActionKind.QuickFix,
      );
      fixAttributeAction.edit = this.createAttributeFix(document, range);
      fixAttributeAction.diagnostics = attributeDiagnostics;
      actions.push(fixAttributeAction);
    }

    if (tagDiagnostics.length > 0) {
      // Quick fix for tag formatting
      const fixTagAction = new vscode.CodeAction(
        "Fix tag format",
        vscode.CodeActionKind.QuickFix,
      );
      fixTagAction.edit = this.createTagFix(document, range);
      fixTagAction.diagnostics = tagDiagnostics;
      actions.push(fixTagAction);
    }

    return actions;
  }

  private createIndentationFix(
    document: vscode.TextDocument,
    range: vscode.Range,
  ): vscode.WorkspaceEdit {
    const edit = new vscode.WorkspaceEdit();
    const line = document.lineAt(range.start.line);
    const lineText = line.text;
    const leadingWhitespace = lineText.match(/^(\s*)/)?.[1] || "";

    // Simple fix: round to nearest multiple of 4
    const currentIndent = leadingWhitespace.length;
    const correctedIndent = Math.round(currentIndent / 4) * 4;
    const newIndentation = " ".repeat(correctedIndent);

    const replaceRange = new vscode.Range(
      range.start.line,
      0,
      range.start.line,
      leadingWhitespace.length,
    );

    edit.replace(document.uri, replaceRange, newIndentation);
    return edit;
  }

  private createAttributeFix(
    document: vscode.TextDocument,
    range: vscode.Range,
  ): vscode.WorkspaceEdit {
    const edit = new vscode.WorkspaceEdit();
    const line = document.lineAt(range.start.line);
    const lineText = line.text;

    // Fix spaces before equals sign only (preserve spaces after)
    const fixedLine = lineText.replace(
      /([a-zA-Z_][-a-zA-Z0-9\._\:]*)\s+=/,
      "$1=",
    );

    const replaceRange = new vscode.Range(
      range.start.line,
      0,
      range.start.line,
      lineText.length,
    );

    edit.replace(document.uri, replaceRange, fixedLine);
    return edit;
  }

  private createTagFix(
    document: vscode.TextDocument,
    range: vscode.Range,
  ): vscode.WorkspaceEdit {
    const edit = new vscode.WorkspaceEdit();
    const line = document.lineAt(range.start.line);
    const lineText = line.text;

    // Fix common tag issues
    let fixedLine = lineText;

    // Fix empty tags by providing a placeholder
    if (/^\s*\|\>\s*$/.test(lineText)) {
      fixedLine = lineText.replace(/(\s*)(\|\>?)\s*$/, "$1$2 tagname");
    } else {
      // Fix extra content or invalid characters
      const tagMatch = lineText.match(/^(\s*)(\|\>?)\s*(.*?)(\s*)$/);
      if (tagMatch) {
        const indent = tagMatch[1];
        const pipe = tagMatch[2];
        const content = tagMatch[3];

        // Clean up tag name to match valid pattern
        const cleanedTag = content.replace(/[^a-zA-Z0-9_\.\:\-]/g, "").trim();
        if (cleanedTag) {
          fixedLine = `${indent}${pipe} ${cleanedTag}`;
        }
      }
    }

    const replaceRange = new vscode.Range(
      range.start.line,
      0,
      range.start.line,
      lineText.length,
    );

    edit.replace(document.uri, replaceRange, fixedLine);
    return edit;
  }
}
