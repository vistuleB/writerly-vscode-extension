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

    for (let lineNumber = 0; lineNumber < document.lineCount; lineNumber++) {
      const line = document.lineAt(lineNumber);
      const lineText = line.text;

      // Skip empty lines
      if (lineText.trim() === "") {
        continue;
      }

      const indentationResult = this.analyzeIndentation(
        lineText,
        lineNumber,
        previousIndentLevel
      );

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

  private analyzeIndentation(
    lineText: string,
    lineNumber: number,
    previousIndentLevel: number
  ): IndentationResult {
    const leadingWhitespace = lineText.match(/^(\s*)/)?.[1] || "";
    const indentLength = leadingWhitespace.length;

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
