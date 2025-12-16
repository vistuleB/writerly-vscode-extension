import * as vscode from "vscode";
import { Zone, LineType, State, WriterlyDocumentWalker } from "./walker";

const lineRange = (
  lineNumber: number,
  start: number,
  end: number
): vscode.Range => new vscode.Range(lineNumber, start, lineNumber, end);

const errorDiagnostic = (
  range: vscode.Range,
  message: string
): vscode.Diagnostic =>
  new vscode.Diagnostic(range, message, vscode.DiagnosticSeverity.Error);

const d1 = (lineNumber: number, indent: number): vscode.Diagnostic => {
  const range = lineRange(lineNumber, 0, indent);
  return errorDiagnostic(range, "Indentation too large");
};

const d2 = (lineNumber: number, indent: number): vscode.Diagnostic => {
  const range = lineRange(lineNumber, 0, indent);
  return errorDiagnostic(range, "Indentation not a multiple of 4");
};

const d3 = (lineNumber: number, indent: number): vscode.Diagnostic => {
  const range = lineRange(lineNumber, 0, indent);
  return errorDiagnostic(range, "Indentation tew low");
};

const d4 = (
  lineNumber: number,
  indent: number,
  content: string
): vscode.Diagnostic => {
  const range = lineRange(lineNumber, indent, indent + content.length);
  return errorDiagnostic(range, "Code block opening inside of code block");
};

const d5 = (state: State): vscode.Diagnostic => {
  let indent = state.codeBlockStartIndent;
  let lineNumber = state.codeBlockStartLineNumber;
  let range = lineRange(lineNumber, indent, indent + 3);
  return errorDiagnostic(range, "Unclosed code block");
};

const d6 = (document: vscode.TextDocument): vscode.Diagnostic => {
  let lastLine = document.lineCount - 1;
  let range = lineRange(lastLine, 0, document.lineAt(lastLine).text.length);
  return errorDiagnostic(range, "Unclosed code block");
};

const d7 = (lineNumber: number, indent: number, content: string) => {
  const range = lineRange(lineNumber, indent + 2, indent + content.length);
  return errorDiagnostic(range, "Empty tag");
};

const d8 = (
  lineNumber: number,
  indent: number,
  content: string,
  numSpaces: number
) => {
  const range = lineRange(
    lineNumber,
    indent + 2 + numSpaces,
    indent + content.length
  );
  return errorDiagnostic(
    range,
    "Invalid tag. Tag names must start with a letter, underscore, or colon, followed by letters, numbers, hyphens, underscores, dots, or colons."
  );
};

const d9 = (lineNumber: number, indent: number, content: string) => {
  const range = lineRange(lineNumber, indent + 3, indent + content.length);
  return errorDiagnostic(range, "Spaces in code block info annotation");
};

const d10 = (lineNumber: number, indent: number, numTabs: number) => {
  const range = lineRange(lineNumber, indent, indent + numTabs);
  return errorDiagnostic(range, "Tabs in initial whitespace");
};

export default class StaticDocumentValidator {
  static validTagPattern = /^[a-zA-Z_\:][-a-zA-Z0-9\._\:]*$/;
  static tagIsolatingPattern = /^\|\>(\s*)(.*)$/;
  static tabIsolatingPattern = /^[\t]*/;
  static diagnosticCollection: vscode.DiagnosticCollection;
  static our_walker: WriterlyDocumentWalker;

  public static validateFinalState(
    document: vscode.TextDocument,
    finalState: State,
    diagnostics: vscode.Diagnostic[],
  ): void {
    if (finalState.zone === Zone.CodeBlock) {
      diagnostics.push(d5(finalState));
      diagnostics.push(d6(document));
    }
  }

  public static validateLine(
    stateBeforeLine: State,
    lineType: LineType,
    stateAfterLine: State,
    lineNumber: number,
    indent: number,
    content: string,
    diagnostics: vscode.Diagnostic[],
  ): void {
    StaticDocumentValidator.validateIndentation(
      stateBeforeLine,
      lineType,
      stateAfterLine,
      lineNumber,
      indent,
      content,
      diagnostics,
    );
    StaticDocumentValidator.validateContent(
      stateBeforeLine,
      lineType,
      lineNumber,
      indent,
      content,
      diagnostics,
    );
  }

  private static validateIndentation(
    stateBeforeLine: State,
    lineType: LineType,
    stateAfterLine: State,
    lineNumber: number,
    indent: number,
    content: string,
    diagnostics: vscode.Diagnostic[],
  ): void {
    if (content === "") return;
    if (
      lineType === LineType.CodeBlockClosing &&
      indent > stateAfterLine.maxIndent // stateAfterLine.maxIndent === maxIndent at code block opening
    ) {
      diagnostics.push(d1(lineNumber, indent));
    } else if (indent < stateBeforeLine.minIndent) {
      diagnostics.push(d3(lineNumber, stateBeforeLine.minIndent));
    } else if (indent > stateBeforeLine.maxIndent) {
      diagnostics.push(d1(lineNumber, indent));
    } else if (indent % 4 !== 0) {
      diagnostics.push(d2(lineNumber, indent));
    }
  }

  private static validateContent(
    stateBeforeLine: State,
    lineType: LineType,
    lineNumber: number,
    indent: number,
    content: string,
    diagnostics: vscode.Diagnostic[],
  ): void {
    switch (lineType) {
      case LineType.Tag:
        StaticDocumentValidator.validateTag(lineNumber, indent, content, diagnostics);
        break;
      case LineType.CodeBlockOpening:
        StaticDocumentValidator.validateCodeBlockInfoAnnotation(lineNumber, indent, content, diagnostics);
        break;
      case LineType.CodeBlockLine:
        StaticDocumentValidator.validateCodeBlockLine(
          stateBeforeLine,
          lineNumber,
          indent,
          content,
          diagnostics,
        );
        break;
      case LineType.Text:
        StaticDocumentValidator.validateText(lineNumber, indent, content, diagnostics);
        break;
    }
  }

  private static validateText(
    lineNumber: number,
    indent: number,
    content: string,
    diagnostics: vscode.Diagnostic[],
  ): void {
    if (!content.startsWith("\t")) return;
    const isolatingMatch = content.match(this.tabIsolatingPattern);
    if (!isolatingMatch) {
      console.error("bug error: tabIsolatingPattern should match string");
      return;
    }
    diagnostics.push(d10(lineNumber, indent, isolatingMatch[0].length));
  }

  private static validateTag(
    lineNumber: number,
    indent: number,
    content: string,
    diagnostics: vscode.Diagnostic[],
  ): void {
    if (content === "|>") {
      diagnostics.push(d7(lineNumber, indent, content));
      return;
    }

    const isolatingMatch = content.match(this.tagIsolatingPattern);
    if (!isolatingMatch) return;
    const numSpaces = isolatingMatch[1].length;
    const tagName = isolatingMatch[2];

    if (!this.validTagPattern.test(tagName)) {
      diagnostics.push(d8(lineNumber, indent, content, numSpaces));
    }
  }

  private static validateCodeBlockInfoAnnotation(
    lineNumber: number,
    indent: number,
    content: string,
    diagnostics: vscode.Diagnostic[],
  ): void {
    if (content.indexOf(" ") > 0) {
      diagnostics.push(d9(lineNumber, indent, content));
    }
  }

  private static validateCodeBlockLine(
    stateBeforeLine: State,
    lineNumber: number,
    indent: number,
    content: string,
    diagnostics: vscode.Diagnostic[],
  ): void {
    if (
      content.startsWith("```") &&
      indent === stateBeforeLine.codeBlockStartIndent
    ) {
      diagnostics.push(d4(lineNumber, indent, content));
    }
  }
}
