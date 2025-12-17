import * as vscode from "vscode";
import { Zone, LineType, State, WriterlyDocumentWalker } from "./DocumentWalker";

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

export default class DocumentValidator {
  diagnostics: vscode.Diagnostic[] = [];
  validTagPattern = /^[a-zA-Z_\:][-a-zA-Z0-9\._\:]*$/;
  tagIsolatingPattern = /^\|\>(\s*)(.*)$/;
  tabIsolatingPattern = /^[\t]*/;
  diagnosticCollection: vscode.DiagnosticCollection;
  our_walker: WriterlyDocumentWalker;

  constructor(
    context: vscode.ExtensionContext,
    walker: WriterlyDocumentWalker, 
  ) {
    this.our_walker = walker;

    this.diagnosticCollection =
      vscode.languages.createDiagnosticCollection("writerly-validator");

    let disposables: Array<vscode.Disposable> = [
      this.diagnosticCollection,

      vscode.workspace.onDidOpenTextDocument(
        (document: vscode.TextDocument) => this.validateDocument(document)
      ),

      vscode.workspace.onDidChangeTextDocument(
        (event: vscode.TextDocumentChangeEvent) => this.validateDocument(event.document)
      ),
    ];

    for (const disposable of disposables) {
      context.subscriptions.push(disposable);
    }

    vscode.workspace.textDocuments.forEach(
      (document: vscode.TextDocument) => this.validateDocument(document)
    );
  }

  public validateDocument(document: vscode.TextDocument): void {
    if (document.languageId !== "writerly") return;
    this.diagnostics = [];
    let state = WriterlyDocumentWalker.walk(document, (s1, l, s2, lN, i, c) =>
      this.callback(s1, l, s2, lN, i, c)
    );
    if (state.zone === Zone.CodeBlock) {
      this.diagnostics.push(d5(state));
      this.diagnostics.push(d6(document));
    }
    if (this.diagnosticCollection === null || this.diagnosticCollection === undefined) {
      console.log("yeah was undefined");
    }
    this.diagnosticCollection.set(document.uri, this.diagnostics);
  }

  private callback(
    stateBeforeLine: State,
    lineType: LineType,
    stateAfterLine: State,
    lineNumber: number,
    indent: number,
    content: string
  ): void {
    this.validateIndentation(
      stateBeforeLine,
      lineType,
      stateAfterLine,
      lineNumber,
      indent,
      content
    );
    this.validateContent(
      stateBeforeLine,
      lineType,
      lineNumber,
      indent,
      content
    );
  }

  private validateIndentation(
    stateBeforeLine: State,
    lineType: LineType,
    stateAfterLine: State,
    lineNumber: number,
    indent: number,
    content: string,
  ): void {
    if (content === "") return;
    if (
      lineType === LineType.CodeBlockClosing &&
      indent > stateAfterLine.maxIndent // stateAfterLine.maxIndent === maxIndent at code block opening
    ) {
      this.diagnostics.push(d1(lineNumber, indent));
    } else if (indent < stateBeforeLine.minIndent) {
      this.diagnostics.push(d3(lineNumber, stateBeforeLine.minIndent));
    } else if (indent > stateBeforeLine.maxIndent) {
      this.diagnostics.push(d1(lineNumber, indent));
    } else if (indent % 4 !== 0) {
      this.diagnostics.push(d2(lineNumber, indent));
    }
  }

  private validateContent(
    stateBeforeLine: State,
    lineType: LineType,
    lineNumber: number,
    indent: number,
    content: string
  ): void {
    switch (lineType) {
      case LineType.Tag:
        this.validateTag(lineNumber, indent, content);
        break;
      case LineType.CodeBlockOpening:
        this.validateCodeBlockInfoAnnotation(lineNumber, indent, content);
        break;
      case LineType.CodeBlockLine:
        this.validateCodeBlockLine(
          stateBeforeLine,
          lineNumber,
          indent,
          content
        );
        break;
      case LineType.Text:
        this.validateText(lineNumber, indent, content);
        break;
    }
  }

  private validateText(
    lineNumber: number,
    indent: number,
    content: string,
  ): void {
    if (!content.startsWith("\t")) return;
    const isolatingMatch = content.match(this.tabIsolatingPattern);
    if (!isolatingMatch) {
      console.error("bug error: tabIsolatingPattern should match string");
      return;
    }
    this.diagnostics.push(d10(lineNumber, indent, isolatingMatch[0].length));
  }

  private validateTag(
    lineNumber: number,
    indent: number,
    content: string
  ): void {
    if (content === "|>") {
      this.diagnostics.push(d7(lineNumber, indent, content));
      return;
    }

    const isolatingMatch = content.match(this.tagIsolatingPattern);
    if (!isolatingMatch) return;
    const numSpaces = isolatingMatch[1].length;
    const tagName = isolatingMatch[2];

    if (!this.validTagPattern.test(tagName)) {
      this.diagnostics.push(d8(lineNumber, indent, content, numSpaces));
    }
  }

  private validateCodeBlockInfoAnnotation(
    lineNumber: number,
    indent: number,
    content: string
  ): void {
    if (content.indexOf(" ") > 0) {
      this.diagnostics.push(d9(lineNumber, indent, content));
    }
  }

  private validateCodeBlockLine(
    stateBeforeLine: State,
    lineNumber: number,
    indent: number,
    content: string
  ): void {
    if (
      content.startsWith("```") &&
      indent === stateBeforeLine.codeBlockStartIndent
    ) {
      this.diagnostics.push(d4(lineNumber, indent, content));
    }
  }
}
