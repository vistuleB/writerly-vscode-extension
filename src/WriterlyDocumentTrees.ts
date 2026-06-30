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
    if (isUncommentedWriterlyPath(uri.fsPath)) {
      roots.add(path.dirname(uri.fsPath));
    }
  }

  return [...roots];
}

export function getDocumentTreeKeys(
  fsPath: string,
  documentRoots: readonly string[],
): string[] {
  const keys = [fsPath];
  if (!isUncommentedWriterlyPath(fsPath)) return keys;

  keys.push(
    ...documentRoots.filter((rootPath) =>
      isPathUnderDirectory(fsPath, rootPath),
    ),
  );
  return keys;
}

export function isInSameWriterlyDocumentTree(
  firstFsPath: string,
  secondFsPath: string,
  documentRoots: readonly string[],
): boolean {
  if (firstFsPath === secondFsPath) return true;
  if (
    !isUncommentedWriterlyPath(firstFsPath) ||
    !isUncommentedWriterlyPath(secondFsPath)
  ) {
    return false;
  }

  return documentRoots.some(
    (rootPath) =>
      isPathUnderDirectory(firstFsPath, rootPath) &&
      isPathUnderDirectory(secondFsPath, rootPath),
  );
}

export async function getNearestWriterlyDocumentRoot(
  fsPath: string,
): Promise<string | undefined> {
  const roots = await discoverWriterlyDocumentRoots();
  return roots
    .filter((rootPath) => isPathUnderDirectory(fsPath, rootPath))
    .sort((a, b) => b.length - a.length)[0];
}

export function isUncommentedWriterlyPath(fsPath: string): boolean {
  return isWriterlyFilePath(fsPath) && !hasCommentedPathSegment(fsPath);
}

export function isPathUnderDirectory(fsPath: string, dirPath: string): boolean {
  const relativePath = path.relative(dirPath, fsPath);
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
  );
}

function hasCommentedPathSegment(fsPath: string): boolean {
  const workspaceFolder = getClosestWorkspaceFolder(fsPath);
  const relativePath = workspaceFolder
    ? path.relative(workspaceFolder.uri.fsPath, fsPath)
    : fsPath;

  return relativePath
    .split(path.sep)
    .some((segment) => segment.startsWith("#"));
}

function getClosestWorkspaceFolder(
  fsPath: string,
): vscode.WorkspaceFolder | undefined {
  const folders = vscode.workspace.workspaceFolders ?? [];
  return folders
    .filter((folder) => isPathUnderDirectory(fsPath, folder.uri.fsPath))
    .sort((a, b) => b.uri.fsPath.length - a.uri.fsPath.length)[0];
}
