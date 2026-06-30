export const WRITERLY_FILE_EXTENSION = ".wly";
export const WRITERLY_PARENT_FILE_NAME = "__parent.wly";
export const ALL_WRITERLY_FILE_GLOB = "**/*.wly";
export const ALL_WRITERLY_PARENT_FILE_GLOB = "**/__parent.wly";

export function getWriterlyFileGlob(): string | undefined {
  return ALL_WRITERLY_FILE_GLOB;
}

export function getWriterlyParentFileGlob(): string | undefined {
  return ALL_WRITERLY_PARENT_FILE_GLOB;
}

export function isWriterlyFilePath(fsPath: string): boolean {
  return fsPath.endsWith(WRITERLY_FILE_EXTENSION);
}

export function isWriterlyParentPath(fsPath: string): boolean {
  return fsPath.endsWith(WRITERLY_PARENT_FILE_NAME);
}

export function getWriterlyParentDir(fsPath: string): string | undefined {
  if (!isWriterlyParentPath(fsPath)) return undefined;
  return fsPath.slice(0, -WRITERLY_PARENT_FILE_NAME.length);
}
