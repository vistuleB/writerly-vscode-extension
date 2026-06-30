import * as vscode from "vscode";
import * as path from "path";
import {
  getWriterlyFileGlob,
  isWriterlyFilePath,
} from "./WriterlyFileExtensions";

export async function discoverWriterlyDocumentRoots(
  maxFiles?: number,
): Promise<string[]> {
  const fileGlob = getWriterlyFileGlob();
  if (!fileGlob) return [];

  const uris = await vscode.workspace.findFiles(fileGlob, null, maxFiles);
  const roots = new Set<string>();

  for (const uri of uris) {
    if (isWriterlyFilePath(uri.fsPath)) {
      roots.add(path.dirname(uri.fsPath));
    }
  }

  return [...roots];
}

export function getDocumentTreeKeys(
  fsPath: string,
  documentRoots: readonly string[],
): string[] {
  if (!isWriterlyFilePath(fsPath)) return [];

  return [
    fsPath,
    ...documentRoots.filter((rootPath) =>
      isPathUnderDirectory(fsPath, rootPath),
    ),
  ];
}

export function isInSameWriterlyDocumentTree(
  firstFsPath: string,
  secondFsPath: string,
  documentRoots: readonly string[],
): boolean {
  if (
    !isWriterlyFilePath(firstFsPath) ||
    !isWriterlyFilePath(secondFsPath)
  ) {
    return false;
  }
  if (firstFsPath === secondFsPath) return true;

  return documentRoots.some(
    (rootPath) =>
      isPathUnderDirectory(firstFsPath, rootPath) &&
      isPathUnderDirectory(secondFsPath, rootPath),
  );
}

export function isInAccessibleHashIsland(
  usageFsPath: string,
  definitionFsPath: string,
): boolean {
  return isHashIslandPrefix(
    getHashIslandKey(definitionFsPath),
    getHashIslandKey(usageFsPath),
  );
}

export function isInComparableHashIsland(
  firstFsPath: string,
  secondFsPath: string,
): boolean {
  const firstKey = getHashIslandKey(firstFsPath);
  const secondKey = getHashIslandKey(secondFsPath);
  return (
    isHashIslandPrefix(firstKey, secondKey) ||
    isHashIslandPrefix(secondKey, firstKey)
  );
}

export function getHashIslandDepth(fsPath: string): number {
  return getHashIslandKey(fsPath).length;
}

export async function getNearestWriterlyDocumentRoot(
  fsPath: string,
): Promise<string | undefined> {
  if (!isWriterlyFilePath(fsPath)) return undefined;

  const roots = await discoverWriterlyDocumentRoots();
  return roots
    .filter((rootPath) => isPathUnderDirectory(fsPath, rootPath))
    .sort((a, b) => b.length - a.length)[0];
}

export function isPathUnderDirectory(fsPath: string, dirPath: string): boolean {
  const relativePath = path.relative(dirPath, fsPath);
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
  );
}

function getHashIslandKey(fsPath: string): string[] {
  const resolvedPath = path.resolve(fsPath);
  const parsedPath = path.parse(resolvedPath);
  const relativeParts = path
    .relative(parsedPath.root, resolvedPath)
    .split(path.sep)
    .filter((part) => part.length > 0);

  const hashSegments: string[] = [];
  let currentPath = parsedPath.root;

  for (const part of relativeParts) {
    currentPath = path.join(currentPath, part);
    if (part.startsWith("#")) {
      hashSegments.push(currentPath);
    }
  }

  return hashSegments;
}

function isHashIslandPrefix(
  possiblePrefix: readonly string[],
  fullKey: readonly string[],
): boolean {
  return (
    possiblePrefix.length <= fullKey.length &&
    possiblePrefix.every((part, index) => part === fullKey[index])
  );
}
