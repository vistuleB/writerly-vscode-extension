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
    // let inAttributeBlock = false;
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
        // Validate tag format
        const tagValidationResult = this.validateTagLine(lineText, lineNumber);
        if (tagValidationResult.error) {
          diagnostics.push(tagValidationResult.diagnostic);
        }
        // inAttributeBlock = true;
        attributeBlockStart = lineNumber;
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
    let body = lineText.trim();
    let startChar = lineText.indexOf("```");
    assert(startChar >= 0);
    let containsSpaces = body.indexOf(" ") >= 0;
    if (containsSpaces) {
      const diagnostic = new vscode.Diagnostic(
        new vscode.Range(lineNumber, startChar + 3, lineNumber, lineText.length),
        "Language annotation should not contain spaces.",
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

    // Check if there is indentation increase between text lines
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

  private validateTagLine(
    lineText: string,
    lineNumber: number,
  ): { error: string | null; diagnostic: vscode.Diagnostic | null } {
    const trimmed = lineText.trim();

    // Check for empty tag (just |> with no name)
    if (trimmed === "|>" || trimmed === "|>>" || /^\|\>\s*$/.test(trimmed)) {
      const diagnostic = new vscode.Diagnostic(
        new vscode.Range(lineNumber, 0, lineNumber, lineText.length),
        "Tag name cannot be empty. Valid tag format: |> tagname",
        vscode.DiagnosticSeverity.Error,
      );
      diagnostic.code = "empty-tag-name";
      diagnostic.source = "writerly-tag-validation";
      return { error: "Empty tag name", diagnostic };
    }

    // Use strict pattern: ^(\\s*)(\\|\\>?)\\s*([a-zA-Z_\\:][-a-zA-Z0-9\\._\\:]*)(\\s*)$
    const tagPattern = /^(\s*)(\|\>?)\s*([a-zA-Z_\:][-a-zA-Z0-9\._\:]*)\s*$/;
    const tagMatch = trimmed.match(/^(\|\>?)\s*(.*)$/);

    if (tagMatch) {
      const pipeSymbol = tagMatch[1];
      const tagContent = tagMatch[2].trim();

      // Check if tag content is empty
      if (!tagContent) {
        const diagnostic = new vscode.Diagnostic(
          new vscode.Range(lineNumber, 0, lineNumber, lineText.length),
          "Tag name cannot be empty. Valid tag format: |> tagname",
          vscode.DiagnosticSeverity.Error,
        );
        diagnostic.code = "empty-tag-name";
        diagnostic.source = "writerly-tag-validation";
        return { error: "Empty tag name", diagnostic };
      }

      // Check if tag name matches valid pattern
      const validTagPattern = /^[a-zA-Z_\:][-a-zA-Z0-9\._\:]*$/;
      if (!validTagPattern.test(tagContent)) {
        const diagnostic = new vscode.Diagnostic(
          new vscode.Range(lineNumber, 0, lineNumber, lineText.length),
          `Invalid tag name "${tagContent}". Tag names must start with a letter, underscore, or colon, followed by letters, numbers, hyphens, underscores, dots, or colons.`,
          vscode.DiagnosticSeverity.Error,
        );
        diagnostic.code = "invalid-tag-name";
        diagnostic.source = "writerly-tag-validation";
        return { error: "Invalid tag name", diagnostic };
      }

      // Check for extra content after tag name (using strict pattern)
      if (
        !/^(\s*)(\|\>?)\s*([a-zA-Z_\:][-a-zA-Z0-9\._\:]*)\s*$/.test(lineText)
      ) {
        const diagnostic = new vscode.Diagnostic(
          new vscode.Range(lineNumber, 0, lineNumber, lineText.length),
          `Invalid tag format. Tag lines must contain only the tag name with optional whitespace. Valid format: |> tagname`,
          vscode.DiagnosticSeverity.Error,
        );
        diagnostic.code = "invalid-tag-format";
        diagnostic.source = "writerly-tag-validation";
        return { error: "Invalid tag format", diagnostic };
      }
    }

    return { error: null, diagnostic: null };
  }
}
