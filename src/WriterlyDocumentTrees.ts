import * as vscode from "vscode";
import * as path from "path";
import {
  getWriterlyFileGlob,
  isWriterlyFilePath,
} from "./WriterlyFileExtensions";

// A Writerly container is any directory that directly contains at least one
// Writerly file. Containers are not necessarily topmost document roots.
export async function discoverWriterlyContainers(
  maxFiles?: number,
): Promise<string[]> {
  const fileGlob = getWriterlyFileGlob();
  if (!fileGlob) return [];

  const uris = await vscode.workspace.findFiles(fileGlob, null, maxFiles);
  const containers = new Set<string>();

  for (const uri of uris) {
    if (isWriterlyFilePath(uri.fsPath)) {
      containers.add(path.dirname(uri.fsPath));
    }
  }

  return [...containers];
}

export async function discoverTopmostWriterlyDocumentRoots(): Promise<string[]> {
  const containers = await discoverWriterlyContainers();
  return containers.filter(
    (container) =>
      !containers.some(
        (candidateParent) =>
          candidateParent !== container &&
          isPathUnderDirectory(container, candidateParent),
      ),
  );
}

export function getDocumentTreeKeys(
  fsPath: string,
  writerlyContainers: readonly string[],
): string[] {
  if (!isWriterlyFilePath(fsPath)) return [];

  return [
    fsPath,
    ...writerlyContainers.filter((containerPath) =>
      isPathUnderDirectory(fsPath, containerPath),
    ),
  ];
}

export function isInSameWriterlyDocumentTree(
  firstFsPath: string,
  secondFsPath: string,
  writerlyContainers: readonly string[],
): boolean {
  if (
    !isWriterlyFilePath(firstFsPath) ||
    !isWriterlyFilePath(secondFsPath)
  ) {
    return false;
  }
  if (firstFsPath === secondFsPath) return true;

  return writerlyContainers.some(
    (containerPath) =>
      isPathUnderDirectory(firstFsPath, containerPath) &&
      isPathUnderDirectory(secondFsPath, containerPath),
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

export function isInSameHashIsland(
  firstFsPath: string,
  secondFsPath: string,
): boolean {
  const firstKey = getHashIslandKey(firstFsPath);
  const secondKey = getHashIslandKey(secondFsPath);
  return (
    firstKey.length === secondKey.length &&
    firstKey.every((part, index) => part === secondKey[index])
  );
}

export function getHashIslandDepth(fsPath: string): number {
  return getHashIslandKey(fsPath).length;
}

export async function getNearestWriterlyContainer(
  fsPath: string,
): Promise<string | undefined> {
  if (!isWriterlyFilePath(fsPath)) return undefined;

  const containers = await discoverWriterlyContainers();
  return containers
    .filter((containerPath) => isPathUnderDirectory(fsPath, containerPath))
    .sort((a, b) => b.length - a.length)[0];
}

export function isPathUnderDirectory(fsPath: string, dirPath: string): boolean {
  const relativePath = path.relative(dirPath, fsPath);
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
  );
}

export function steinbergerDistance(rootDir: string, targetDir: string): number {
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
