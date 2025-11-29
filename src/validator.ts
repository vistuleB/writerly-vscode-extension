import * as vscode from "vscode";

enum Zone {
  Attribute,
  Text,
  CodeBlock,
}

class State {
  zone: Zone = Zone.Text;
  maxIndent: number = 0;
  minIndent: number = 0;
  codeBlockStartIndent: number = 0;
  codeBlockStartLineNumber: number = 0;
}

const lineRange = (
  lineNumber: number,
  start: number,
  end: number,
): vscode.Range => new vscode.Range(lineNumber, start, lineNumber, end);

const errorDiagnostic = (
  range: vscode.Range,
  message: string,
): vscode.Diagnostic =>
  new vscode.Diagnostic(range, message, vscode.DiagnosticSeverity.Error);

const d1 = (lineNumber: number, indent: number): vscode.Diagnostic =>
  errorDiagnostic(lineRange(lineNumber, 0, indent), "Indentation too large");

const d2 = (lineNumber: number, indent: number): vscode.Diagnostic =>
  errorDiagnostic(
    lineRange(lineNumber, 0, indent),
    "Indentation not a multiple of 4",
  );

const d3 = (lineNumber: number, indent: number): vscode.Diagnostic =>
  errorDiagnostic(lineRange(lineNumber, 0, indent), "Indentation too low");

const d4 = (
  lineNumber: number,
  indent: number,
  content: string,
): vscode.Diagnostic =>
  errorDiagnostic(
    lineRange(lineNumber, indent, indent + content.length),
    "Code block opening inside of code block",
  );

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

const d7 = (lineNumber: number, indent: number, content: string) =>
  errorDiagnostic(
    lineRange(lineNumber, indent + 2, indent + content.length),
    "Empty tag",
  );

const d8 = (
  lineNumber: number,
  indent: number,
  content: string,
  numSpaces: number,
) =>
  errorDiagnostic(
    lineRange(lineNumber, indent + 2 + numSpaces, indent + content.length),
    "Invalid tag. Tag names must start with a letter, underscore, or colon, followed by letters, numbers, hyphens, underscores, dots, or colons.",
  );

export default class WriterlyDocumentValidator {
  constructor(private diagnosticCollection: vscode.DiagnosticCollection) {}

  public validateDocument(document: vscode.TextDocument): void {
    const diagnostics: vscode.Diagnostic[] = [];

    let state: State = {
      zone: Zone.Text,
      maxIndent: 0,
      minIndent: 0,
      codeBlockStartIndent: 0,
      codeBlockStartLineNumber: 0,
    };

    for (let lineNumber = 0; lineNumber < document.lineCount; lineNumber++) {
      const line = document.lineAt(lineNumber).text.trimEnd();
      const spaces = line.match(/^( *)/)?.[1] || "";
      const indent = spaces.length;
      const content = line.trimStart();
      this.validateIndentation(diagnostics, state, lineNumber, indent, content);
      this.updateStateAndValidateContent(
        diagnostics,
        state,
        lineNumber,
        indent,
        content,
      );
    }

    if (state.zone === Zone.CodeBlock) {
      diagnostics.push(d5(state));
      diagnostics.push(d6(document));
    }

    this.diagnosticCollection.set(document.uri, diagnostics);
  }

  private validateIndentation(
    diagnostics: vscode.Diagnostic[],
    state: State,
    lineNumber: number,
    indent: number,
    content: string,
  ): void {
    if (content === "") return;
    // the following special case is for when we are inside a code block zone, but
    // really it's a text zone because the code block is about to be closed; the
    // state.maxIndent is about to be reverted to the current state.minIndent, and
    // so we're checking for a leftover indent > state.maxIndent violation:
    if (
      state.zone === Zone.CodeBlock &&
      content === "```" &&
      indent === state.codeBlockStartIndent &&
      state.codeBlockStartIndent > state.minIndent
    ) {
      diagnostics.push(d1(lineNumber, indent));
    } else if (indent < state.minIndent) {
      diagnostics.push(d3(lineNumber, indent));
    } else if (indent > state.maxIndent) {
      diagnostics.push(d1(lineNumber, indent));
    } else if (indent % 4 !== 0) {
      diagnostics.push(d2(lineNumber, indent));
    }
  }

  private updateStateAndValidateContent(
    diagnostics: vscode.Diagnostic[],
    state: State,
    lineNumber: number,
    indent: number,
    content: string,
  ): void {
    switch (state.zone) {
      case Zone.Attribute:
        this.updateStateAndValidateContentInAttributeZone(
          diagnostics,
          state,
          lineNumber,
          indent,
          content,
        );
        break;
      case Zone.Text:
        this.updateStateAndValidateContentInTextZone(
          diagnostics,
          state,
          lineNumber,
          indent,
          content,
        );
        break;
      case Zone.CodeBlock:
        this.updateStateAndValidateContentInCodeBlockZone(
          diagnostics,
          state,
          lineNumber,
          indent,
          content,
        );
        break;
    }
  }

  private validateTagName(
    diagnostics: vscode.Diagnostic[],
    lineNumber: number,
    indent: number,
    content: string,
  ): void {
    if (content === "|>") {
      diagnostics.push(d7(lineNumber, indent, content));
      return;
    }

    const isolatingPattern = content.match(/^\|\>( *)(.*)$/);
    if (!isolatingPattern) {
      return;
    }
    const numSpaces = isolatingPattern[1].length;
    const tagName = isolatingPattern[2];
    const validTagPattern = /^[a-zA-Z_\:][-a-zA-Z0-9\._\:]*$/;

    if (!validTagPattern.test(tagName)) {
      diagnostics.push(d8(lineNumber, indent, content, numSpaces));
    }
  }

  private validateCodeBlockInfoAnnotation(
    diagnostics: vscode.Diagnostic[],
    lineNumber: number,
    indent: number,
    content: string,
  ): void {
    if (content.indexOf(" ") > 0) {
      diagnostics.push(
        errorDiagnostic(
          lineRange(lineNumber, indent + 3, indent + content.length),
          "Spaces in code block info annotation",
        ),
      );
    }
  }

  private updateStateAndValidateContentInTextZone(
    diagnostics: vscode.Diagnostic[],
    state: State,
    lineNumber: number,
    indent: number,
    content: string,
  ): void {
    if (content.startsWith("|>")) {
      state.zone = Zone.Attribute;
      state.maxIndent = Math.min(state.maxIndent, indent) + 4;
      this.validateTagName(diagnostics, lineNumber, indent, content);
    } else if (content.startsWith("```")) {
      state.zone = Zone.CodeBlock;
      state.codeBlockStartIndent = indent;
      state.codeBlockStartLineNumber = lineNumber;
      state.minIndent = Math.min(state.maxIndent, indent);
      state.maxIndent = Number.MAX_VALUE;
      this.validateCodeBlockInfoAnnotation(
        diagnostics,
        lineNumber,
        indent,
        content,
      );
    } else if (content === "") {
      state.zone = Zone.Text;
    } else {
      state.zone = Zone.Text;
      state.maxIndent = Math.min(state.maxIndent, indent);
    }
  }

  private contentDoesNotBumpUsOutOfAttributeZone(content: string): boolean {
    return (
      content.startsWith("!!") || /([a-zA-Z_][-a-zA-Z0-9\._\:]*=)/.test(content)
    );
  }

  private updateStateAndValidateContentInAttributeZone(
    diagnostics: vscode.Diagnostic[],
    state: State,
    lineNumber: number,
    indent: number,
    content: string,
  ): void {
    if (
      indent === state.maxIndent &&
      this.contentDoesNotBumpUsOutOfAttributeZone(content)
    ) {
      state.zone = Zone.Attribute;
    } else {
      state.zone = Zone.Text;
      this.updateStateAndValidateContentInTextZone(
        diagnostics,
        state,
        lineNumber,
        indent,
        content,
      );
    }
  }

  private updateStateAndValidateContentInCodeBlockZone(
    diagnostics: vscode.Diagnostic[],
    state: State,
    lineNumber: number,
    indent: number,
    content: string,
  ): void {
    if (indent !== state.codeBlockStartIndent) {
    } else if (content === "```") {
      state.zone = Zone.Text;
      state.maxIndent = state.minIndent;
      state.minIndent = 0;
    } else if (content.startsWith("```")) {
      diagnostics.push(d4(lineNumber, indent, content));
    }
  }
}
