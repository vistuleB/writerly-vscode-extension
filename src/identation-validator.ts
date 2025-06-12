import * as vscode from "vscode";

interface IndentationResult {
  error: string | null;
  severity: vscode.DiagnosticSeverity;
  code: string | null;
  indentLength: number;
  indentLevel: number;
}

export default class WriterlyIndentationValidator {
  constructor(private diagnosticCollection: vscode.DiagnosticCollection) {}

  validateDocument(document: vscode.TextDocument) {
    const diagnostics: vscode.Diagnostic[] = [];
    let previousIndentLevel = 0;
    let insideCodeBlock = false;
    let codeBlockIndentLevel = 0;
    let previousLineIsTag = false;

    for (let lineNumber = 0; lineNumber < document.lineCount; lineNumber++) {
      const line = document.lineAt(lineNumber);
      const lineText = line.text;

      if (lineText.trim() === "") {
        continue;
      }

      if (lineText.trim().startsWith("```") && !insideCodeBlock) {
        insideCodeBlock = true;
        codeBlockIndentLevel = this.getLineIndentation(lineText);
      } else if (lineText.trim().startsWith("```") && insideCodeBlock) {
        insideCodeBlock = false;
      }

      let indentationResult = insideCodeBlock
        ? this.analyzeCodeBlockIndentation(codeBlockIndentLevel, lineText)
        : this.analyzeIndentation(
            lineText,
            previousLineIsTag,
            previousIndentLevel
          );

      previousLineIsTag = lineText.trim().startsWith("|>");

      if (indentationResult.error) {
        const diagnostic = new vscode.Diagnostic(
          new vscode.Range(
            lineNumber,
            0,
            lineNumber,
            indentationResult.indentLength
          ),
          indentationResult.error,
          indentationResult.severity
        );
        diagnostic.code = indentationResult.code;
        diagnostic.source = "writerly-indentation";
        diagnostics.push(diagnostic);
      }

      // Update previous indent level only if current line is valid
      if (!indentationResult.error) {
        previousIndentLevel = indentationResult.indentLevel;
      }
    }

    this.diagnosticCollection.set(document.uri, diagnostics);
  }

  private getLineIndentation(line: string): number {
    const leadingWhitespace = line.match(/^(\s*)/)?.[1] || "";
    return leadingWhitespace.length;
  }

  private analyzeCodeBlockIndentation(
    codeBlockIndentation: number,
    lineText: string
  ): IndentationResult {
    const lineIndent = this.getLineIndentation(lineText);
    if (codeBlockIndentation > lineIndent) {
      return {
        error: `Code block indentation must be at least same as it's opening`,
        severity: vscode.DiagnosticSeverity.Error,
        code: "code-block-indentation-too-low",
        indentLength: lineIndent,
        indentLevel: Math.floor(lineIndent / 4),
      };
    }
    return {
      error: null,
      severity: vscode.DiagnosticSeverity.Information,
      code: null,
      indentLength: lineIndent,
      indentLevel: Math.floor(lineIndent / 4),
    };
  }

  private analyzeIndentation(
    lineText: string,
    previousLineIsTag: boolean,
    previousIndentLevel: number
  ): IndentationResult {
    const indentLength = this.getLineIndentation(lineText);
    const leadingWhitespace = lineText.match(/^(\s*)/)?.[1] || "";

    // Check for tabs
    if (leadingWhitespace.includes("\t")) {
      return {
        error: "Indentation must use spaces only, not tabs",
        severity: vscode.DiagnosticSeverity.Error,
        code: "tabs-not-allowed",
        indentLength,
        indentLevel: 0,
      };
    }

    // Check if indentation is multiple of 4
    if (indentLength % 4 !== 0) {
      return {
        error: `Indentation must be a multiple of 4 spaces. Current: ${indentLength} spaces`,
        severity: vscode.DiagnosticSeverity.Error,
        code: "invalid-indentation-level",
        indentLength,
        indentLevel: Math.floor(indentLength / 4),
      };
    }

    const currentIndentLevel = indentLength / 4;

    // Check if indentation increase is too large (more than 1 level)
    if (currentIndentLevel > previousIndentLevel + 1) {
      return {
        error: `Indentation increased by ${
          currentIndentLevel - previousIndentLevel
        } levels. Maximum increase is 1 level (4 spaces)`,
        severity: vscode.DiagnosticSeverity.Error,
        code: "excessive-indentation-increase",
        indentLength,
        indentLevel: currentIndentLevel,
      };
    }

    // Check if there is identation increase between text lines
    if (currentIndentLevel > previousIndentLevel && !previousLineIsTag) {
      return {
        error: `Indentation can't be increased between text lines`,
        severity: vscode.DiagnosticSeverity.Error,
        code: "indentation-increase-text-lines",
        indentLength,
        indentLevel: currentIndentLevel,
      };
    }

    // Valid indentation
    return {
      error: null,
      severity: vscode.DiagnosticSeverity.Information,
      code: null,
      indentLength,
      indentLevel: currentIndentLevel,
    };
  }
}
