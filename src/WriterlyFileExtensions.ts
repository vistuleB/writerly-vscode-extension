import * as vscode from "vscode";

export const WRITERLY_FILE_EXTENSIONS = [".wly", ".writerly"] as const;
export const DEFAULT_ENABLED_WRITERLY_FILE_EXTENSIONS = [
  ...WRITERLY_FILE_EXTENSIONS,
];

const WRITERLY_FILE_EXTENSION_NAMES = WRITERLY_FILE_EXTENSIONS.map((ext) =>
  ext.slice(1),
);

const ENABLED_EXTENSIONS_SETTING = "enabledFileExtensions";

export const WRITERLY_PARENT_FILE_NAMES = WRITERLY_FILE_EXTENSIONS.map(
  (ext) => `__parent${ext}`,
);

export const ALL_WRITERLY_FILE_GLOB = `**/*.{${WRITERLY_FILE_EXTENSION_NAMES.join(
  ",",
)}}`;

export const ALL_WRITERLY_PARENT_FILE_GLOB = `**/__parent.{${WRITERLY_FILE_EXTENSION_NAMES.join(
  ",",
)}}`;

export function getEnabledWriterlyFileExtensions(): readonly string[] {
  const configured = vscode.workspace
    .getConfiguration("writerly")
    .get<string[]>(ENABLED_EXTENSIONS_SETTING, [
      ...DEFAULT_ENABLED_WRITERLY_FILE_EXTENSIONS,
    ]);

  const supported = new Set<string>(WRITERLY_FILE_EXTENSIONS);
  const enabled: string[] = [];
  for (const ext of configured) {
    if (supported.has(ext) && !enabled.includes(ext)) {
      enabled.push(ext);
    }
  }
  return enabled;
}

export function getWriterlyFileGlob(): string | undefined {
  return toExtensionGlob("**/*", getEnabledWriterlyFileExtensions());
}

export function getWriterlyParentFileGlob(): string | undefined {
  return toExtensionGlob("**/__parent", getEnabledWriterlyFileExtensions());
}

export function isWriterlyFilePath(fsPath: string): boolean {
  return getEnabledWriterlyFileExtensions().some((ext) =>
    fsPath.endsWith(ext),
  );
}

export function isWriterlyParentPath(fsPath: string): boolean {
  return getEnabledWriterlyParentFileNames().some((fileName) =>
    fsPath.endsWith(fileName),
  );
}

export function getWriterlyParentDir(fsPath: string): string | undefined {
  const parentFileName = getEnabledWriterlyParentFileNames().find((fileName) =>
    fsPath.endsWith(fileName),
  );

  if (!parentFileName) return undefined;
  return fsPath.slice(0, -parentFileName.length);
}

function getEnabledWriterlyParentFileNames(): readonly string[] {
  return getEnabledWriterlyFileExtensions().map((ext) => `__parent${ext}`);
}

function toExtensionGlob(
  prefix: string,
  extensions: readonly string[],
): string | undefined {
  if (extensions.length === 0) return undefined;
  const extensionNames = extensions.map((ext) => ext.slice(1));
  if (extensionNames.length === 1) return `${prefix}.${extensionNames[0]}`;
  return `${prefix}.{${extensionNames.join(",")}}`;
}
