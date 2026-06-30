export const WRITERLY_FILE_EXTENSION = ".wly";
export const ALL_WRITERLY_FILE_GLOB = "**/*.wly";

export function getWriterlyFileGlob(): string | undefined {
  return ALL_WRITERLY_FILE_GLOB;
}

export function isWriterlyFilePath(fsPath: string): boolean {
  return fsPath.endsWith(WRITERLY_FILE_EXTENSION);
}
