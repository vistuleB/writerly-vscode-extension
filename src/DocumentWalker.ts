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
  public static onTheFlyLineClassification(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): State {
    const lines = this.getLinesAbove(document, position);
    return this.walkLines(lines);
  }

  private static getLinesAbove(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): string[] {
    let linesAbove: string[] = [];
    let currentLineNum = position.line;
    let currentLine = document.lineAt(currentLineNum).text;

    linesAbove.push(currentLine);

    // initial x determination
    if (currentLine.trim() === "") {
      // move up to find the first nonempty line
      while (
        currentLineNum > 0 &&
        document.lineAt(currentLineNum).text.trim() === ""
      ) {
        currentLineNum--;
      }

      const foundLine = document.lineAt(currentLineNum).text;
      if (foundLine.trim() !== "") {
        currentLine = foundLine;
        linesAbove.push(currentLine);
      } else {
        // "else linesAbove construction is over"
        // we reached line 0 and it's still empty.
        return linesAbove;
      }
    }

    let x = currentLine.match(/^( *)/)?.[1].length || 0;

    // climb the tree
    let pointer = currentLineNum - 1;
    while (pointer >= 0) {
      const lineText = document.lineAt(pointer).text;
      const indent = lineText.match(/^( *)/)?.[1].length || 0;
      const isEmpty = lineText.trim() === "";

      if (isEmpty || indent === x) {
        linesAbove.push(lineText);
      } else if (indent < x) {
        x = indent;
        linesAbove.push(lineText);
        if (x === 0) break;
      }
      pointer--;
    }

    linesAbove.reverse();

    const nonEmptyLines = linesAbove.filter((l) => l.trim() !== "");
    if (nonEmptyLines.length > 0) {
      const minIndent = Math.min(
        ...nonEmptyLines.map((l) => l.match(/^( *)/)?.[1].length || 0),
      );
      if (minIndent > 0) {
        linesAbove = linesAbove.map((l) => l.substring(minIndent));
      }
    }

    return linesAbove;
  }

  private static walkLines(lines: string[]): State {
    let state: State = {
      zone: Zone.Text,
      maxIndent: 0,
      minIndent: 0,
      codeBlockStartIndent: 0,
      codeBlockStartLineNumber: 0,
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trimEnd();
      const spaces = line.match(/^( *)/)?.[1] || "";
      const indent = spaces.length;
      const content = line.slice(indent);

      // we reuse the existing updateState logic
      this.updateState(state, i, indent, content);
    }

    return state;
  }

  public static isCommentLine(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Boolean {
    return document.lineAt(position.line).text.trimStart().startsWith("!!");
  }

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
      let prevState: State = {
        zone: state.zone,
        maxIndent: state.maxIndent,
        minIndent: state.minIndent,
        codeBlockStartIndent: state.codeBlockStartIndent,
        codeBlockStartLineNumber: state.codeBlockStartLineNumber,
      };
      let lineType = this.updateState(state, lineNumber, indent, content);
      callback(prevState, lineType, state, lineNumber, indent, content);
    }

    // return the final state
    return state;
  }

  private static updateState(
    state: State,
    lineNumber: number,
    indent: number,
    content: string,
  ): LineType {
    switch (state.zone) {
      case Zone.Attribute:
        return this.updateStateInAttributeZone(
          state,
          lineNumber,
          indent,
          content,
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
    content: string,
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
    content: string,
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
    content: string,
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
