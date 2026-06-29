export const WRITERLY_FILE_EXTENSIONS = [".wly", ".writerly"] as const;

const WRITERLY_FILE_EXTENSION_NAMES = WRITERLY_FILE_EXTENSIONS.map((ext) =>
  ext.slice(1),
);

export const WRITERLY_PARENT_FILE_NAMES = WRITERLY_FILE_EXTENSIONS.map(
  (ext) => `__parent${ext}`,
);

export const WRITERLY_FILE_GLOB = `**/*.{${WRITERLY_FILE_EXTENSION_NAMES.join(
  ",",
)}}`;

export const WRITERLY_PARENT_FILE_GLOB = `**/__parent.{${WRITERLY_FILE_EXTENSION_NAMES.join(
  ",",
)}}`;

export function isWriterlyFilePath(fsPath: string): boolean {
  return WRITERLY_FILE_EXTENSIONS.some((ext) => fsPath.endsWith(ext));
}

export function isWriterlyParentPath(fsPath: string): boolean {
  return WRITERLY_PARENT_FILE_NAMES.some((fileName) =>
    fsPath.endsWith(fileName),
  );
}

export function getWriterlyParentDir(fsPath: string): string | undefined {
  const parentFileName = WRITERLY_PARENT_FILE_NAMES.find((fileName) =>
    fsPath.endsWith(fileName),
  );

  if (!parentFileName) return undefined;
  return fsPath.slice(0, -parentFileName.length);
}
