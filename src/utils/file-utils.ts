import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";

const forbiddenChars = /[\s'"=\[\]\{\}\(\);!<>|]/;
const excludedWorkspacePaths = "{**/node_modules/**,**/.*/**,**/dist/**,**/build/**}";

export type FileResolution =
  | { kind: "notFound" }
  | { kind: "unique"; fsPath: string }
  | { kind: "ambiguous"; fsPaths: string[] };

export const fileUtils = {
  getFileResolutionAtPosition: async (
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<[vscode.Range, string, FileResolution]> => {
    const [range, filePath] = getPossiblePathAtPosition(document, position);
    if (!filePath) return [range, filePath, { kind: "notFound" }];
    const resolution = await resolveUniqueFilePath(filePath);
    return [range, filePath, resolution];
  },

  fileExists: async (filePath: string): Promise<boolean> => {
    const files = await resolvePossibleFilePaths(filePath, 1);
    return files.length > 0;
  },

  resolveUniqueFilePath,

  resolvePossibleFilePaths,

  getResolvedFilePathAtPosition: async (
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<[vscode.Range, string, string]> => {
    const [range, filePath, resolution] =
      await fileUtils.getFileResolutionAtPosition(document, position);
    return [
      range,
      filePath,
      resolution.kind === "unique" ? resolution.fsPath : "",
    ];
  },

  isImageFile: (filePath: string): boolean => {
    for (const ext of [".svg", ".png", ".ico", ".jpeg", ".jpg", ".gif"]) {
      if (filePath.endsWith(ext)) return true;
    }
    return false;
  },

  /**
   * Given a trailing sub-directory path (e.g. "images" or "assets/images"),
   * returns every full directory path in the workspace whose tail segments
   * equal it.
   */
  resolvePossibleDirPaths: async (endSubDirPath: string): Promise<string[]> => {
    const sub = endSubDirPath.replace(/^\/+|\/+$/g, "");
    if (!sub) return [];
    const subParts = sub.split("/").filter((p) => p !== ".");
    if (subParts.length === 0) return [];
    const folders = vscode.workspace.workspaceFolders;
    if (!folders) return [];

    const skipDirs = new Set(["node_modules", "dist", "build"]);
    const matches: string[] = [];

    const walk = async (dirUri: vscode.Uri): Promise<void> => {
      const entries = await vscode.workspace.fs.readDirectory(dirUri);
      for (const [name, type] of entries) {
        if ((type & vscode.FileType.Directory) === 0) continue;
        if (skipDirs.has(name) || name.startsWith(".")) continue;
        const childPath = path.join(dirUri.fsPath, name);
        const childParts = childPath.split(path.sep);
        if (
          childParts.length >= subParts.length &&
          subParts.every(
            (p, j) => childParts[childParts.length - subParts.length + j] === p
          )
        ) {
          matches.push(childPath);
        }
        await walk(vscode.Uri.file(childPath));
      }
    };

    for (const folder of folders) await walk(folder.uri);
    return matches;
  },

  /**
   * Returns the absolute paths of every file contained in `dirPath` and its
   * sub-directories (recursively).
   */
  listFilesRecursively: async (dirPath: string): Promise<string[]> => {
    const result: string[] = [];

    const walk = async (dirUri: vscode.Uri): Promise<void> => {
      const entries = await vscode.workspace.fs.readDirectory(dirUri);
      for (const [name, type] of entries) {
        const childPath = path.join(dirUri.fsPath, name);
        if (type & vscode.FileType.Directory) {
          await walk(vscode.Uri.file(childPath));
        } else if (type & vscode.FileType.File) {
          result.push(childPath);
        }
      }
    };

    await walk(vscode.Uri.file(dirPath));
    return result;
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

const normalizeSearchPath = (filePath: string): string => {
  while (true) {
    if (filePath.startsWith("/")) {
      filePath = filePath.slice(1);
    } else if (filePath.startsWith("../")) {
      filePath = filePath.slice(3);
    } else break;
  }
  return filePath;
};

async function resolvePossibleFilePaths(
  filePath: string,
  maxResults?: number
): Promise<string[]> {
  const normalizedPath = normalizeSearchPath(filePath);
  if (!normalizedPath) return [];

  const files = await vscode.workspace.findFiles(
    `**/${normalizedPath}`,
    excludedWorkspacePaths,
    maxResults
  );
  return files.map((uri) => uri.fsPath);
}

async function resolveUniqueFilePath(
  filePath: string
): Promise<FileResolution> {
  const files = await resolvePossibleFilePaths(filePath, 2);
  if (files.length === 0) return { kind: "notFound" };
  if (files.length === 1) return { kind: "unique", fsPath: files[0] };
  return { kind: "ambiguous", fsPaths: files };
}
