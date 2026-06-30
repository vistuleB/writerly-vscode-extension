import * as vscode from "vscode";
import * as path from "path";

const forbiddenChars = /[\s'"=\[\]\{\}\(\);!<>|]/;
const excludedWorkspacePaths =
  "{**/node_modules/**,**/.*/**,**/dist/**,**/build/**}";
const skippedDirectoryNames = new Set(["node_modules", "dist", "build"]);
export const SUPPORTED_IMAGE_FILE_EXTENSIONS = [
  "png",
  "jpg",
  "jpeg",
  "gif",
  "svg",
  "webp",
  "avif",
  "heic",
  "heif",
  "bmp",
  "ipe",
  "psd",
  "tif",
  "tiff",
] as const;
const supportedImageFileExtensions = new Set(
  SUPPORTED_IMAGE_FILE_EXTENSIONS.map((ext) => `.${ext}`),
);

export type FileResolution =
  | { kind: "notFound" }
  | { kind: "unique"; fsPath: string }
  | {
      kind: "resolvedAmbiguous";
      fsPath: string;
      alternatives: string[];
      reason: "closestAncestor" | "documentRootDistance";
    }
  | { kind: "ambiguous"; fsPaths: string[] };

export type DirectoryResolution = FileResolution;

type DirectoryResolutionOptions = {
  rootRelativeTo?: string;
  resolutionRoot?: string;
};

export const fileUtils = {
  getFileResolutionAtPosition: async (
    document: vscode.TextDocument,
    position: vscode.Position,
    options: DirectoryResolutionOptions = {}
  ): Promise<[vscode.Range, string, FileResolution]> => {
    const [range, filePath] = getPossiblePathAtPosition(document, position);
    if (!filePath) return [range, filePath, { kind: "notFound" }];
    const resolution = await resolveUniqueFilePath(filePath, options);
    return [range, filePath, resolution];
  },

  fileExists: async (filePath: string): Promise<boolean> => {
    const files = await findMatchingFilePaths(filePath, 1);
    return files.length > 0;
  },

  resolveUniqueFilePath,

  resolveDirectoryPath,

  resolvePossibleFilePaths,

  isImageFile: (filePath: string): boolean => {
    return supportedImageFileExtensions.has(
      path.extname(filePath).toLowerCase()
    );
  },

  /**
   * Bare paths are matched by trailing path segments anywhere in the workspace.
   * Paths beginning with "./" are matched relative to workspace folders
   * containing `rootRelativeTo`.
   */
  resolvePossibleDirPaths: async (
    dirPath: string,
    options: DirectoryResolutionOptions = {}
  ): Promise<string[]> => {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders) return [];

    if (isWorkspaceRootRelativePath(dirPath)) {
      return resolveWorkspaceRootRelativeDirPaths(dirPath, options);
    }

    const sub = dirPath.replace(/^\/+|\/+$/g, "");
    if (!sub) return [];
    const subParts = sub.split("/").filter((p) => p !== ".");
    if (subParts.length === 0) return [];

    const matches: string[] = [];

    const walk = async (dirUri: vscode.Uri): Promise<void> => {
      const entries = await vscode.workspace.fs.readDirectory(dirUri);
      for (const [name, type] of entries) {
        if ((type & vscode.FileType.Directory) === 0) continue;
        if (skippedDirectoryNames.has(name) || name.startsWith(".")) continue;
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

async function resolvePossibleFilePaths(filePath: string): Promise<string[]> {
  return findMatchingFilePaths(filePath);
}

async function findMatchingFilePaths(
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
  filePath: string,
  options: DirectoryResolutionOptions = {}
): Promise<FileResolution> {
  const files = await findMatchingFilePaths(
    filePath,
    options.rootRelativeTo || options.resolutionRoot ? undefined : 2
  );
  return resolveBestPath(files, options, true);
}

async function resolveDirectoryPath(
  dirPath: string,
  options: DirectoryResolutionOptions = {}
): Promise<DirectoryResolution> {
  const dirs = await fileUtils.resolvePossibleDirPaths(dirPath, options);
  return resolveBestPath(dirs, options, false);
}

function resolveBestPath(
  paths: string[],
  options: DirectoryResolutionOptions,
  compareParentDirectories: boolean
): FileResolution {
  if (paths.length === 0) return { kind: "notFound" };
  if (paths.length === 1) return { kind: "unique", fsPath: paths[0] };
  if (!options.rootRelativeTo && !options.resolutionRoot) {
    return { kind: "ambiguous", fsPaths: paths };
  }

  const ranked = paths
    .map((fsPath) => ({
      fsPath,
      score: options.resolutionRoot
        ? steinbergerDistance(
            options.resolutionRoot,
            compareParentDirectories ? path.dirname(fsPath) : fsPath
          )
        : commonAncestorDepth(
            compareParentDirectories ? path.dirname(fsPath) : fsPath,
            path.dirname(options.rootRelativeTo!)
          ),
    }))
    .sort((a, b) =>
      options.resolutionRoot ? a.score - b.score : b.score - a.score
    );
  const best = ranked[0];
  const tiedBest = ranked.filter((candidate) => candidate.score === best.score);

  if (tiedBest.length > 1) return { kind: "ambiguous", fsPaths: paths };

  return {
    kind: "resolvedAmbiguous",
    fsPath: best.fsPath,
    alternatives: paths.filter((fsPath) => fsPath !== best.fsPath),
    reason: options.resolutionRoot
      ? "documentRootDistance"
      : "closestAncestor",
  };
}

function isWorkspaceRootRelativePath(dirPath: string): boolean {
  return dirPath === "." || dirPath.startsWith("./");
}

async function resolveWorkspaceRootRelativeDirPaths(
  dirPath: string,
  options: DirectoryResolutionOptions
): Promise<string[]> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders) return [];

  const roots = options.rootRelativeTo
    ? folders.filter((folder) =>
        isPathUnderDirectory(options.rootRelativeTo!, folder.uri.fsPath)
      )
    : [...folders];
  const relativePath = dirPath.replace(/^\.\/*/, "");
  const matches: string[] = [];

  for (const folder of roots) {
    const candidate = path.join(folder.uri.fsPath, relativePath);
    try {
      const stat = await vscode.workspace.fs.stat(vscode.Uri.file(candidate));
      if (stat.type & vscode.FileType.Directory) {
        matches.push(candidate);
      }
    } catch (error) {}
  }

  return matches;
}

function isPathUnderDirectory(filePath: string, dirPath: string): boolean {
  const relativePath = path.relative(dirPath, filePath);
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
  );
}

function commonAncestorDepth(a: string, b: string): number {
  const aParts = path.resolve(a).split(path.sep);
  const bParts = path.resolve(b).split(path.sep);
  let depth = 0;

  while (
    depth < aParts.length &&
    depth < bParts.length &&
    aParts[depth] === bParts[depth]
  ) {
    depth++;
  }

  return depth;
}

function steinbergerDistance(rootDir: string, targetDir: string): number {
  const relativePath = path.relative(rootDir, targetDir);
  if (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
  ) {
    return 0;
  }

  return relativePath
    .split(path.sep)
    .filter((segment) => segment === "..").length;
}
