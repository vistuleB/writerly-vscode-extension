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
  thisParagraphIndentationDiagnostic: vscode.Diagnostic;
}

export default class WriterlyIndentationValidator2 {
  constructor(private diagnosticCollection: vscode.DiagnosticCollection) {}

  validateDocument(document: vscode.TextDocument): void {
    const diagnostics: vscode.Diagnostic[] = [];

    let state: State = {
      zone: Zone.Text,
      indent: 0,
      start: -1,
      thisParagraphIndentationDiagnostic: null,
    };

    for (let lineNumber = 0; lineNumber < document.lineCount; lineNumber++) {
      const line = document.lineAt(lineNumber);
      const trimEnd = line.text.trimEnd();
      const spaces = trimEnd.match(/^( *)/)?.[1] || "";
      const indent = spaces.length;
      const content = trimEnd.trimStart();
      this.indentationValidation(diagnostics, state, lineNumber, indent, content);
      this.contentValidationAndStateUpdate(diagnostics, state, lineNumber, indent, content);
    }

    if (state.zone === Zone.CodeBlock) {
      diagnostics.push(this.d5(state));
      diagnostics.push(this.d6(document));
    }

    this.diagnosticCollection.set(document.uri, diagnostics);
  }

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

  private translate(diagnostic: vscode.Diagnostic, lineNumber: number): vscode.Diagnostic {
    let range = new vscode.Range(
      lineNumber,
      diagnostic.range.start.character,
      lineNumber,
      diagnostic.range.end.character,
    );
    return new vscode.Diagnostic(range, diagnostic.message, diagnostic.severity);
  }

  private indentationValidation(
    diagnostics: vscode.Diagnostic[],
    state: State,
    lineNumber: number,
    indent: number,
    content: string,
  ): void {
    if (state.zone === Zone.CodeBlock) {
      if (indent < state.indent && content !== "") {
        diagnostics.push(this.d3(lineNumber, indent));
      }
    } else {
      let isText = (
        !content.startsWith("|>") &&
        !content.startsWith("```")
      );

      if (indent > state.indent) {
        let diagnostic = this.d1(lineNumber, indent)
        diagnostics.push(diagnostic);
        if (isText) { state.thisParagraphIndentationDiagnostic = diagnostic; }
      }
      
      else if (indent % 4 !== 0) {
        let diagnostic = this.d2(lineNumber, indent);
        diagnostics.push(diagnostic);
        if (isText) { state.thisParagraphIndentationDiagnostic = diagnostic; }
      }

      else if (
        state.thisParagraphIndentationDiagnostic !== null &&
        isText &&
        indent === state.indent
      ) {
        diagnostics.push(this.translate(state.thisParagraphIndentationDiagnostic, lineNumber));
      }
    }
  }

  private contentValidationAndStateUpdate(
    diagnostics: vscode.Diagnostic[],
    state: State,
    lineNumber: number,
    indent: number,
    content: string,
  ): void {
    switch (state.zone) {
      case Zone.Attribute:
        this.contentValidationAndStateUpdateInAttributeZone(diagnostics, state, lineNumber, indent, content);
        break;
      case Zone.Text:
        this.contentValidationAndStateUpdateInTextZone(diagnostics, state, lineNumber, indent, content);
        break;
      case Zone.CodeBlock:
        this.contentValidationAndStateUpdateInCodeBlockZone(diagnostics, state, lineNumber, indent, content);
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

  private contentValidationAndStateUpdateInTextZone(
    diagnostics: vscode.Diagnostic[],
    state: State,
    lineNumber: number,
    indent: number,
    content: string,
  ): void {
    if (
      content.startsWith("|>")
    ) {
      this.validateTag(diagnostics, lineNumber, indent, content)
      state.zone = Zone.Attribute;
      state.indent = indent + 4;
      state.thisParagraphIndentationDiagnostic = null;
    } else if (
      content.startsWith("```")
    ) {
      this.validateCodeBlockOpening(diagnostics, lineNumber, indent, content);
      state.zone = Zone.CodeBlock;
      state.start = lineNumber;
      state.indent = indent;
      state.thisParagraphIndentationDiagnostic = null;
    } else if (
      content !== ""
    ) {
      state.zone = Zone.Text;
      state.indent = indent;
    } else {
      state.zone = Zone.Text;
      state.thisParagraphIndentationDiagnostic = null;
    }
  }

  private contentDoesNotBumpUsOutOfAttributeZone(content: string): boolean {
    return (
      content.startsWith("!!") ||
      /([a-zA-Z_][-a-zA-Z0-9\._\:]*=)/.test(content)
    );
  }

  private contentValidationAndStateUpdateInAttributeZone(
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
      this.contentValidationAndStateUpdateInTextZone(diagnostics, state, lineNumber, indent, content);
    }
  }

  private contentValidationAndStateUpdateInCodeBlockZone(
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
