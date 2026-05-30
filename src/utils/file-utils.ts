import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";

const forbiddenChars = /[\s'"=\[\]\{\}\(\);!<>|]/;

export const fileUtils = {
  getResolvedFilePathAtPosition: async (
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<[vscode.Range, string, string]> => {
    const [range, filePath] = getPossiblePathAtPosition(document, position);
    if (!filePath) return [range, filePath, ""];
    const resolvedPath = await resolvePath(filePath);
    return [range, filePath, resolvedPath];
  },

  isImageFile: (filePath: string): boolean => {
    for (const ext of [".svg", ".png", ".ico", ".jpeg", ".jpg", ".gif"]) {
      if (filePath.endsWith(ext)) return true;
    }
    return false;
  },
};

const getPossiblePathAtPosition = (
  document: vscode.TextDocument,
  position: vscode.Position
): [vscode.Range, string] => {
  const line = document.lineAt(position);
  const text = line.text;
  const end = moveCursorForwardWhileNotForbidden(text, position.character);
  const start = moveCursorBackwardWhileNotForbidden(text, position.character);
  const path = text.substring(start, end);
  const positionStart = new vscode.Position(position.line, start);
  const positionEnd = new vscode.Position(position.line, end);
  return [new vscode.Range(positionStart, positionEnd), path];
};

const moveCursorForwardWhileNotForbidden = (
  text: string,
  from: number
): number => {
  let length = text.length;
  let end = from;
  while (end < length) {
    let c = text.charAt(end);
    if (forbiddenChars.test(c)) break;
    end++;
  }
  return end;
};

const moveCursorBackwardWhileNotForbidden = (
  text: string,
  from: number
): number => {
  let start = from - 1;
  while (start >= 0) {
    let c = text.charAt(start);
    if (forbiddenChars.test(c)) break;
    start--;
  }
  return start + 1;
};

const resolvePath = async (filePath: string): Promise<string> => {
  while (true) {
    if (filePath.startsWith("/")) {
      filePath = filePath.slice(1);
    } else if (filePath.startsWith("../")) {
      filePath = filePath.slice(3);
    } else break;
  }
  let files = await vscode.workspace.findFiles(
    `**/${filePath}`,
    "{**/node_modules/**,**/.*/**,**/dist/**,**/build/**}"
  );
  return files.length > 0 ? files[0].fsPath : "";
};
