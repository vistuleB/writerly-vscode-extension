import * as vscode from "vscode";

enum Zone {
  Attribute,
  Text,
  CodeBlock,
}

class State {
  zone: Zone;
  indent: number;
  start: number;
  lastNonCodeBlockIndentationDiagnostic: vscode.Diagnostic;
}

export default class WriterlyDocumentValidator {
  constructor(private diagnosticCollection: vscode.DiagnosticCollection) {}

  private d1(lineNumber: number, indent: number): vscode.Diagnostic {
    return new vscode.Diagnostic(
      new vscode.Range(lineNumber, 0, lineNumber, indent),
      "Indentation too large",
      vscode.DiagnosticSeverity.Error,
    );
  }

  private d2(lineNumber: number, indent: number): vscode.Diagnostic {
    return new vscode.Diagnostic(
      new vscode.Range(lineNumber, 0, lineNumber, indent),
      "Indentation not a multiple of 4",
      vscode.DiagnosticSeverity.Error,
    );
  }

  private d3(lineNumber: number, indent: number): vscode.Diagnostic {
    return new vscode.Diagnostic(
      new vscode.Range(lineNumber, 0, lineNumber, indent),
      "Indentation too low",
      vscode.DiagnosticSeverity.Error,
    );
  }

  private d4(lineNumber: number, indent: number, content: string): vscode.Diagnostic {
    return new vscode.Diagnostic(
      new vscode.Range(lineNumber, indent, lineNumber, indent + 3 + content.length),
      "Code block opening inside of code block",
      vscode.DiagnosticSeverity.Error,
    );
  }
  
  private d5(state: State): vscode.Diagnostic {
    let lineNumber = state.start;
    let indent = state.indent;
    return new vscode.Diagnostic(
      new vscode.Range(lineNumber, indent, lineNumber, indent + 3),
      "Unclosed code block",
      vscode.DiagnosticSeverity.Error,
    );    
  }
  
  private d6(document: vscode.TextDocument): vscode.Diagnostic {
    const lastLine = document.lineCount - 1;
    return new vscode.Diagnostic(
      new vscode.Range(lastLine, 0, lastLine, document.lineAt(lastLine).text.length),
      "Unclosed code block",
      vscode.DiagnosticSeverity.Error,
    );
  }

  private resetLine(diagnostic: vscode.Diagnostic, lineNumber: number): vscode.Diagnostic {
    let range = new vscode.Range(
      lineNumber,
      diagnostic.range.start.character,
      lineNumber,
      diagnostic.range.end.character,
    );
    return new vscode.Diagnostic(range, diagnostic.message, diagnostic.severity);
  }

  validateDocument(document: vscode.TextDocument): void {
    const diagnostics: vscode.Diagnostic[] = [];

    let state: State = {
      zone: Zone.Text,
      indent: 0,
      start: -1,
      lastNonCodeBlockIndentationDiagnostic: null,
    };

    for (let lineNumber = 0; lineNumber < document.lineCount; lineNumber++) {
      const line = document.lineAt(lineNumber);
      const trimEnd = line.text.trimEnd();
      const spaces = trimEnd.match(/^( *)/)?.[1] || "";
      const indent = spaces.length;
      const content = trimEnd.trimStart();
      this.validateIndentation(diagnostics, state, lineNumber, indent, content);
      this.updateStateAndValidateContent(diagnostics, state, lineNumber, indent, content);
    }

    if (state.zone === Zone.CodeBlock) {
      diagnostics.push(this.d5(state));
      diagnostics.push(this.d6(document));
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
    let diagnostic = null;
    if (state.zone === Zone.CodeBlock) {
      if (indent < state.indent && content !== "") {
        diagnostic = this.d3(lineNumber, indent);
      } else if (indent === state.indent && content === "```" && state.lastNonCodeBlockIndentationDiagnostic !== null) {
        diagnostic = this.resetLine(state.lastNonCodeBlockIndentationDiagnostic, lineNumber);
      }
    } else {
      if (indent > state.indent) {
        diagnostic = this.d1(lineNumber, indent);
      } else if (indent % 4 !== 0) {
        diagnostic = this.d2(lineNumber, indent);
      } else if (indent === state.indent && state.lastNonCodeBlockIndentationDiagnostic !== null) {
        diagnostic = this.resetLine(state.lastNonCodeBlockIndentationDiagnostic, lineNumber);
      }
      state.lastNonCodeBlockIndentationDiagnostic = diagnostic;
    }
    if (diagnostic !== null) { diagnostics.push(diagnostic); }
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
        this.updateStateAndValidateContentInAttributeZone(diagnostics, state, lineNumber, indent, content);
        break;
      case Zone.Text:
        this.updateStateAndValidateContentInTextZone(diagnostics, state, lineNumber, indent, content);
        break;
      case Zone.CodeBlock:
        this.updateStateAndValidateContentInCodeBlockZone(diagnostics, state, lineNumber, indent, content);
        break;
    }
  }

  private validateTag(
    diagnostics: vscode.Diagnostic[],
    lineNumber: number,
    indent: number,
    content: string,
  ): void {
    if (content === "|>") {
      diagnostics.push(new vscode.Diagnostic(
        new vscode.Range(lineNumber, indent + 2, lineNumber, indent + content.length),
        "Empty tag",
        vscode.DiagnosticSeverity.Error,
      ));
      return;
    }

    const isolatingPattern = content.match(/^\|\>( *)(.*)$/);
    const numSpaces = isolatingPattern[1].length;
    const tag = isolatingPattern[2];
    const validTagPattern = /^[a-zA-Z_\:][-a-zA-Z0-9\._\:]*$/;

    if (!validTagPattern.test(tag)) {
      diagnostics.push(new vscode.Diagnostic(
        new vscode.Range(lineNumber, indent + 2 + numSpaces, lineNumber, indent + 2 + numSpaces + content.length),
        `Invalid tag. Tag names must start with a letter, underscore, or colon, followed by letters, numbers, hyphens, underscores, dots, or colons.`,
        vscode.DiagnosticSeverity.Error,
      ));
    }
  }

  private validateCodeBlockOpening(
    diagnostics: vscode.Diagnostic[],
    lineNumber: number,
    indent: number,
    content: string,
  ): void {
    if (content.indexOf(" ") > 0) {
     diagnostics.push(new vscode.Diagnostic(
        new vscode.Range(lineNumber, indent + 3, lineNumber, indent + content.length),
        "Spaces in code block info annotation",
        vscode.DiagnosticSeverity.Error,
      ));
    }
  }

  private updateStateAndValidateContentInTextZone(
    diagnostics: vscode.Diagnostic[],
    state: State,
    lineNumber: number,
    indent: number,
    content: string,
  ): void {
    if (
      content.startsWith("|>")
    ) {
      state.zone = Zone.Attribute;
      state.indent = indent + 4;
      this.validateTag(diagnostics, lineNumber, indent, content)
    } else if (
      content.startsWith("```")
    ) {
      state.zone = Zone.CodeBlock;
      state.start = lineNumber;
      state.indent = indent;
      this.validateCodeBlockOpening(diagnostics, lineNumber, indent, content);
    } else if (
      content === ""
    ) {
      state.zone = Zone.Text;
    } else {
      state.zone = Zone.Text;
      state.indent = indent;
    }
  }

  private contentDoesNotBumpUsOutOfAttributeZone(content: string): boolean {
    return (
      content.startsWith("!!") ||
      /([a-zA-Z_][-a-zA-Z0-9\._\:]*=)/.test(content)
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
      indent === state.indent &&
      this.contentDoesNotBumpUsOutOfAttributeZone(content)
    ) {
      state.zone = Zone.Attribute;
    } else {
      state.zone = Zone.Text;
      this.updateStateAndValidateContentInTextZone(diagnostics, state, lineNumber, indent, content);
    }
  }

  private updateStateAndValidateContentInCodeBlockZone(
    diagnostics: vscode.Diagnostic[],
    state: State,
    lineNumber: number,
    indent: number,
    content: string,
  ): void {
    if (
      indent !== state.indent
    ) {
    } else if (
      content === "```"
    ) {
      state.zone = Zone.Text;
    } else if (
      content.startsWith("```")
    ) {
      diagnostics.push(this.d4(lineNumber, indent, content));
    }
  }
}
