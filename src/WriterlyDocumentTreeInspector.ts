import * as vscode from "vscode";
import * as path from "path";
import {
  getWriterlyFileGlob,
  isWriterlyFilePath,
  WRITERLY_FILE_EXTENSION,
} from "./WriterlyFileExtensions";
import {
  discoverWriterlyContainers,
  isInSameWriterlyDocumentTree,
  isPathUnderDirectory,
} from "./WriterlyDocumentTrees";

type DocumentTreeItem = vscode.QuickPickItem & {
  uri?: vscode.Uri;
};

type RootDisplay = {
  fsPath: string;
  description: string;
  rootDir: string;
  uri?: vscode.Uri;
};

export class WriterlyDocumentTreeInspector {
  private readonly statusBarItem: vscode.StatusBarItem;

  constructor(context: vscode.ExtensionContext) {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      20,
    );
    this.statusBarItem.command = "writerly.inspectDocumentTree";
    this.statusBarItem.text = "$(list-tree) Writerly Tree";
    this.statusBarItem.tooltip = "Inspect Writerly document tree";

    context.subscriptions.push(
      this.statusBarItem,
      vscode.commands.registerCommand("writerly.inspectDocumentTree", () =>
        this.inspectActiveDocumentTree(),
      ),
      vscode.window.onDidChangeActiveTextEditor(() =>
        this.updateStatusBarVisibility(),
      ),
      vscode.workspace.onDidOpenTextDocument(() =>
        this.updateStatusBarVisibility(),
      ),
    );

    this.updateStatusBarVisibility();
  }

  public reset(): void {
    this.updateStatusBarVisibility();
  }

  private updateStatusBarVisibility(): void {
    const editor = vscode.window.activeTextEditor;
    if (editor && isWriterlyFilePath(editor.document.uri.fsPath)) {
      this.statusBarItem.show();
    } else {
      this.statusBarItem.hide();
    }
  }

  private async inspectActiveDocumentTree(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !isWriterlyFilePath(editor.document.uri.fsPath)) {
      void vscode.window.showInformationMessage(
        "Open a Writerly file to inspect its document tree.",
      );
      return;
    }

    const currentFsPath = editor.document.uri.fsPath;
    const containers = await discoverWriterlyContainers();
    const files = await this.getDocumentTreeFiles(currentFsPath, containers);
    const root = this.getDocumentTreeRoot(currentFsPath, containers);
    const rootDisplay = root
      ? await this.getRootDisplay(root)
      : undefined;

    const items = this.createQuickPickItems(
      currentFsPath,
      files,
      rootDisplay,
    );
    const picked = await vscode.window.showQuickPick(items, {
      title: `Writerly Document Tree: ${files.length} file${
        files.length === 1 ? "" : "s"
      }`,
      placeHolder: "Select a file to open",
      matchOnDescription: true,
      matchOnDetail: true,
    });

    if (picked?.uri) {
      const document = await vscode.workspace.openTextDocument(picked.uri);
      await vscode.window.showTextDocument(document);
    }
  }

  private async getDocumentTreeFiles(
    currentFsPath: string,
    containers: readonly string[],
  ): Promise<vscode.Uri[]> {
    const fileGlob = getWriterlyFileGlob();
    if (!fileGlob) return [];

    const uris = await vscode.workspace.findFiles(fileGlob);
    return uris
      .filter(
        (uri) =>
          isWriterlyFilePath(uri.fsPath) &&
          isInSameWriterlyDocumentTree(
            currentFsPath,
            uri.fsPath,
            containers,
          ),
      )
      .sort((a, b) =>
        this.getRelativeWorkspacePath(a.fsPath).localeCompare(
          this.getRelativeWorkspacePath(b.fsPath),
        ),
      );
  }

  private createQuickPickItems(
    currentFsPath: string,
    files: readonly vscode.Uri[],
    root: RootDisplay | undefined,
  ): DocumentTreeItem[] {
    const items: DocumentTreeItem[] = [];

    items.push({
      label: "Root",
      kind: vscode.QuickPickItemKind.Separator,
    });

    if (!root) {
      items.push({
        label: "Current file only",
        description: "No containing Writerly root was found",
      });
    } else {
      items.push({
        label: this.getRelativeWorkspacePath(root.fsPath),
        description: root.description,
        detail: root.fsPath,
        uri: root.uri,
      });
    }

    items.push({
      label: "Files",
      kind: vscode.QuickPickItemKind.Separator,
    });

    for (const uri of files) {
      items.push(...this.createTreeFileItems(uri, currentFsPath, root));
    }

    return items;
  }

  private createTreeFileItems(
    uri: vscode.Uri,
    currentFsPath: string,
    root: RootDisplay | undefined,
  ): DocumentTreeItem[] {
    const isCurrentFile = uri.fsPath === currentFsPath;
    if (!root) {
      return [
        {
          label: path.basename(uri.fsPath),
          description: isCurrentFile ? "current file" : undefined,
          detail: uri.fsPath,
          uri,
        },
      ];
    }

    const relativePath = path.relative(root.rootDir, uri.fsPath);
    const parts = relativePath.split(path.sep).filter((part) => part.length > 0);
    const fileName = parts[parts.length - 1] || path.basename(uri.fsPath);
    const dirParts = parts.slice(0, -1);
    const items: DocumentTreeItem[] = [];

    if (dirParts.length > 0) {
      items.push({
        label: `${this.getIndent(dirParts.length - 1)}${dirParts[dirParts.length - 1]}/`,
        description: dirParts.join("/"),
        kind: vscode.QuickPickItemKind.Separator,
      });
    }

    items.push({
      label: `${this.getIndent(dirParts.length)}${fileName}`,
      description: isCurrentFile ? "current file" : undefined,
      detail: uri.fsPath,
      uri,
    });

    return items;
  }

  private getDocumentTreeRoot(
    currentFsPath: string,
    containers: readonly string[],
  ): string | undefined {
    return containers
      .filter((containerPath) => isPathUnderDirectory(currentFsPath, containerPath))
      .sort((a, b) => a.length - b.length)[0];
  }

  private async getRootDisplay(rootDir: string): Promise<RootDisplay> {
    const parentFile = await this.findRootParentFile(rootDir);
    if (parentFile) {
      return {
        fsPath: parentFile,
        description: "Root",
        rootDir,
        uri: vscode.Uri.file(parentFile),
      };
    }

    return {
      fsPath: rootDir,
      description: "Root dir",
      rootDir,
    };
  }

  private async findRootParentFile(
    rootDir: string,
  ): Promise<string | undefined> {
    const entries = await vscode.workspace.fs.readDirectory(
      vscode.Uri.file(rootDir),
    );
    const rootWriterlyFiles = entries
      .filter(
        ([name, fileType]) =>
          fileType === vscode.FileType.File && isWriterlyFilePath(name),
      )
      .map(([name]) => name);
    const parentFiles: { name: string; prefix: string }[] = [];
    for (const name of rootWriterlyFiles) {
      const prefix = this.getParentFilePrefix(name);
      if (
        prefix !== undefined &&
        rootWriterlyFiles.every((fileName) => fileName.startsWith(prefix))
      ) {
        parentFiles.push({ name, prefix });
      }
    }

    parentFiles.sort(
      (a, b) =>
        a.prefix.length - b.prefix.length || a.name.localeCompare(b.name),
    );

    return parentFiles[0]
      ? path.join(rootDir, parentFiles[0].name)
      : undefined;
  }

  private getParentFilePrefix(fileName: string): string | undefined {
    const suffix = `__parent${WRITERLY_FILE_EXTENSION}`;
    if (!fileName.endsWith(suffix)) return undefined;
    return fileName.slice(0, -suffix.length);
  }

  private getIndent(depth: number): string {
    return "  ".repeat(Math.max(depth, 0));
  }

  private getRelativeWorkspacePath(fullPath: string): string {
    for (const folder of vscode.workspace.workspaceFolders || []) {
      const workspaceRoot = folder.uri.fsPath;
      if (!isPathUnderDirectory(fullPath, workspaceRoot)) continue;

      const relativePath = path.relative(workspaceRoot, fullPath);
      return relativePath
        ? relativePath.split(path.sep).join("/")
        : folder.name;
    }

    return fullPath;
  }
}
