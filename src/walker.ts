import * as vscode from "vscode";

export enum Zone {
  Attribute,
  Text,
  CodeBlock,
}

export type State = {
  zone: Zone;
  maxIndent: number;
  minIndent: number;
  codeBlockStartIndent: number;
  codeBlockStartLineNumber: number;
};

export enum LineType {
  Tag,
  CodeBlockOpening,
  CodeBlockClosing,
  Attribute,
  AttributeZoneComment,
  Text,
  TextZoneComment,
  TextZoneEmptyLine,
  CodeBlockLine,
}

export class WriterlyDocumentWalker {  
  public static walk(
    document: vscode.TextDocument,
    callback: (
      stateBeforeLine: State,
      lineType: LineType,
      stateAfterLine: State,
      lineNumber: number,
      indent: number,
      content: string,
    ) => void,
  ): State {
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
      const content = line.slice(indent);

      // copy the previous state over:
      let prevState: State = {
        zone: state.zone,
        maxIndent: state.maxIndent,
        minIndent: state.minIndent,
        codeBlockStartIndent: state.codeBlockStartIndent,
        codeBlockStartLineNumber: state.codeBlockStartLineNumber,
      };

      // update state
      let lineType = this.updateState(state, lineNumber, indent, content);

      // we're not here for fun:
      callback(prevState, lineType, state, lineNumber, indent, content);
    }

    // return the final state
    return state;
  }

  private static updateState(
    state: State,
    lineNumber: number,
    indent: number,
    content: string
  ): LineType {
    switch (state.zone) {
      case Zone.Attribute:
        return this.updateStateInAttributeZone(
          state,
          lineNumber,
          indent,
          content
        );
      case Zone.Text:
        return this.updateStateInTextZone(state, lineNumber, indent, content);
      case Zone.CodeBlock:
        return this.updateStateInCodeBlockZone(state, indent, content);
    }
  }

  private static updateStateInAttributeZone(
    state: State,
    lineNumber: number,
    indent: number,
    content: string
  ): LineType {
    if (indent === state.maxIndent && content.startsWith("!!"))
      return LineType.AttributeZoneComment;

    if (
      indent === state.maxIndent &&
      /([a-zA-Z_][-a-zA-Z0-9\._\:]*=)/.test(content)
    )
      return LineType.Attribute;

    state.zone = Zone.Text;
    return this.updateStateInTextZone(state, lineNumber, indent, content);
  }

  private static updateStateInTextZone(
    state: State,
    lineNumber: number,
    indent: number,
    content: string
  ): LineType {
    if (content.startsWith("|>")) {
      state.zone = Zone.Attribute;
      state.maxIndent = Math.min(state.maxIndent, indent) + 4;
      return LineType.Tag;
    }

    if (content.startsWith("```")) {
      state.zone = Zone.CodeBlock;
      state.codeBlockStartIndent = indent;
      state.codeBlockStartLineNumber = lineNumber;
      state.minIndent = Math.min(state.maxIndent, indent);
      state.maxIndent = Number.MAX_VALUE;
      return LineType.CodeBlockOpening;
    }

    if (content === "") {
      return LineType.TextZoneEmptyLine;
    }

    state.maxIndent = Math.min(state.maxIndent, indent);
    return content.startsWith("!!") ? LineType.TextZoneComment : LineType.Text;
  }

  private static updateStateInCodeBlockZone(
    state: State,
    indent: number,
    content: string
  ): LineType {
    if (content === "```" && indent === state.codeBlockStartIndent) {
      state.zone = Zone.Text;
      state.maxIndent = state.minIndent;
      state.minIndent = 0;
      return LineType.CodeBlockClosing;
    }

    return LineType.CodeBlockLine;
  }
}
