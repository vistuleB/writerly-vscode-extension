import { assert } from "console";
import * as vscode from "vscode";

interface IndentationResult {
  error: string | null;
  severity: vscode.DiagnosticSeverity;
  code: string | null;
  indentLength: number;
  indentLevel: number;
}

interface AttributeValidationResult {
  isValid: boolean;
  error: string | null;
  invalidLine: number | null;
}

interface CodeBlockState {
  isInside: boolean;
  startLine?: number;
  indentLevel: number;
}

export default class WriterlyIndentationValidator {
  constructor(private diagnosticCollection: vscode.DiagnosticCollection) {}

  validateDocument(document: vscode.TextDocument): void {
    const diagnostics: vscode.Diagnostic[] = [];
    const codeBlockState: CodeBlockState = {
      isInside: false,
      indentLevel: 0,
    };
    let previousIndentLevel = 0;
    let previousLineIsTag = false;
    let inAttributeBlock = false;
    let attributeBlockStart = -1;

    for (let lineNumber = 0; lineNumber < document.lineCount; lineNumber++) {
      const line = document.lineAt(lineNumber);
      const lineText = line.text;

      if (lineText.trim() === "") {
        continue;
      }

      if (
        this.handleCodeBlockBoundaries(
          lineText,
          lineNumber,
          codeBlockState,
          diagnostics,
        )
      )
        continue;

      const indentationResult = this.getIndentationResult(
        lineText,
        codeBlockState,
        previousLineIsTag,
        previousIndentLevel,
      );

      const currentLineIsTag = lineText.trim().startsWith("|>");

      // Check if we're starting a new tag block
      if (currentLineIsTag) {
        inAttributeBlock = true;
        attributeBlockStart = lineNumber;
      } else if (inAttributeBlock && !currentLineIsTag) {
        // We're in an attribute block, validate attributes
        const attributeResult = this.validateAttributeLine(
          lineText,
          lineNumber,
        );
        if (!attributeResult.isValid) {
          // Add error for malformed attribute
          diagnostics.push(
            new vscode.Diagnostic(
              new vscode.Range(lineNumber, 0, lineNumber, lineText.length),
              attributeResult.error!,
              vscode.DiagnosticSeverity.Error,
            ),
          );
          // Stop treating subsequent lines as attributes
          inAttributeBlock = false;
        } else if (
          attributeResult.isValid &&
          this.getLineIndentation(lineText) === 0
        ) {
          // End of attribute block (back to root level)
          inAttributeBlock = false;
        }
      }

      previousLineIsTag = currentLineIsTag;

      if (indentationResult.error) {
        diagnostics.push(
          this.createIndentationDiagnostic(lineNumber, indentationResult),
        );
      }

      if (!indentationResult.error) {
        previousIndentLevel = indentationResult.indentLevel;
      }
    }

    this.handleUnclosedCodeBlock(document, codeBlockState, diagnostics);
    this.diagnosticCollection.set(document.uri, diagnostics);
  }

  private handleCodeBlockBoundaries(
    lineText: string,
    lineNumber: number,
    codeBlockState: CodeBlockState,
    diagnostics: vscode.Diagnostic[],
  ): boolean {
    const isCodeBlockBoundary = lineText.trim().startsWith("```");
    if (!isCodeBlockBoundary) return false;

    if (!codeBlockState.isInside) {
      // Opening code block
      codeBlockState.isInside = true;
      codeBlockState.startLine = lineNumber;
      codeBlockState.indentLevel = this.getLineIndentation(lineText);

      const openingDiagnostic = this.analyzeCodeBlockOpening(
        lineText,
        lineNumber,
      );
      if (openingDiagnostic) {
        diagnostics.push(openingDiagnostic);
      }
    } else {
      // Closing code block
      codeBlockState.isInside = false;
      codeBlockState.startLine = undefined;

      if (codeBlockState.indentLevel != this.getLineIndentation(lineText)) {
        diagnostics.push(
          new vscode.Diagnostic(
            new vscode.Range(lineNumber, 0, lineNumber, lineText.length),
            "Closing code block must have the same indentation as opening",
            vscode.DiagnosticSeverity.Error,
          ),
        );
        return true;
      }
    }
    return false;
  }

  private getIndentationResult(
    lineText: string,
    codeBlockState: CodeBlockState,
    previousLineIsTag: boolean,
    previousIndentLevel: number,
  ): IndentationResult {
    return codeBlockState.isInside
      ? this.analyzeCodeBlockIndentation(codeBlockState.indentLevel, lineText)
      : this.analyzeIndentation(
          lineText,
          previousLineIsTag,
          previousIndentLevel,
        );
  }

  private createIndentationDiagnostic(
    lineNumber: number,
    result: IndentationResult,
  ): vscode.Diagnostic {
    const diagnostic = new vscode.Diagnostic(
      new vscode.Range(lineNumber, 0, lineNumber, result.indentLength),
      result.error!,
      result.severity,
    );
    diagnostic.code = result.code;
    diagnostic.source = "writerly-indentation";
    return diagnostic;
  }

  private handleUnclosedCodeBlock(
    document: vscode.TextDocument,
    codeBlockState: CodeBlockState,
    diagnostics: vscode.Diagnostic[],
  ): void {
    if (!codeBlockState.isInside) return;

    if (codeBlockState.startLine !== undefined) {
      diagnostics.push(
        new vscode.Diagnostic(
          new vscode.Range(
            codeBlockState.startLine,
            0,
            codeBlockState.startLine,
            document.lineAt(codeBlockState.startLine).text.length,
          ),
          "Unclosed code block opening",
          vscode.DiagnosticSeverity.Error,
        ),
      );
    }

    const lastLine = document.lineCount - 1;
    diagnostics.push(
      new vscode.Diagnostic(
        new vscode.Range(
          lastLine,
          0,
          lastLine,
          document.lineAt(lastLine).text.length,
        ),
        "Unclosed code block",
        vscode.DiagnosticSeverity.Error,
      ),
    );
  }

  private getLineIndentation(line: string): number {
    const leadingWhitespace = line.match(/^(\s*)/)?.[1] || "";
    return leadingWhitespace.length;
  }

  private analyzeCodeBlockIndentation(
    codeBlockIndentation: number,
    lineText: string,
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

  private analyzeCodeBlockOpening(
    lineText: string,
    lineNumber: number,
  ): vscode.Diagnostic | undefined {
    assert(lineText.trim().startsWith("```"));

    let thereIsSpaceAfterOpening = lineText.trim().slice(3)?.[0] === " ";
    if (thereIsSpaceAfterOpening) {
      let startChar = lineText.length - lineText.trim().slice(3).length - 1;
      const diagnostic = new vscode.Diagnostic(
        new vscode.Range(lineNumber, startChar, lineNumber, lineText.length),
        "Language name must be written directly after the opening backticks",
        vscode.DiagnosticSeverity.Error,
      );
      diagnostic.code = "code-block-opening-language-name";
      diagnostic.source = "writerly-indentation";
      return diagnostic;
    }
  }

  private analyzeIndentation(
    lineText: string,
    previousLineIsTag: boolean,
    previousIndentLevel: number,
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

  private validateAttributeLine(
    lineText: string,
    lineNumber: number,
  ): AttributeValidationResult {
    const trimmed = lineText.trim();

    // Skip empty lines and non-indented lines
    if (trimmed === "" || !lineText.startsWith(" ")) {
      return { isValid: true, error: null, invalidLine: null };
    }

    // Skip commented attributes (!! prefix)
    if (trimmed.startsWith("!!")) {
      return { isValid: true, error: null, invalidLine: null };
    }

    // Check if this looks like an attribute (has an equals sign)
    if (trimmed.includes("=")) {
      // Check for spaces around equals sign
      const equalsMatch = trimmed.match(/([a-zA-Z_][a-zA-Z0-9_-]*)\s*=\s*(.+)/);
      if (equalsMatch) {
        const beforeEquals = equalsMatch[1];
        const fullMatch = equalsMatch[0];
        const expectedFormat = `${beforeEquals}=${equalsMatch[2].trim()}`;

        // Check if there are spaces around the equals sign
        if (fullMatch.includes(" =") || fullMatch.includes("= ")) {
          return {
            isValid: false,
            error:
              "Attribute assignments must not have spaces around the equals sign (=). Use 'key=value' format.",
            invalidLine: lineNumber,
          };
        }
      }
    }

    return { isValid: true, error: null, invalidLine: null };
  }
}
