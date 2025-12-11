import * as vscode from "vscode";
import { WriterlyDocumentWalker, LineType } from "./walker";

declare module "vscode" {
  export interface DocumentLink {
    data: { handleName: string; fsPath: string };
  }
}

type FSPath = string;
type HandleName = string;

type HandleDefinition = {
  fsPath: FSPath;
  range: vscode.Range;
};

const regexStartChar = "a-zA-Z_";
const regexBodyChar = "-a-zA-Z0-9\\._\\:";
const regexEndChar = "a-zA-Z0-9_";
const regexUsageBodyChar = "-a-zA-Z0-9\\._";
const regexHandleName = `([${regexStartChar}][${regexBodyChar}]*[${regexEndChar}])|[${regexStartChar}]`;
const regexUsageHandleName = `([${regexStartChar}][${regexUsageBodyChar}]*[${regexEndChar}])|[${regexStartChar}]`;
const defRegex = new RegExp(`^handle=\\s*(${regexHandleName})(\s|$)`);
const usageRegex = new RegExp(`>>(${regexUsageHandleName})`, "g");

export class WriterlyLinkProvider implements vscode.DocumentLinkProvider {
  definitions: Map<HandleName, HandleDefinition[]> = new Map([]);
  parents: FSPath[] = [];

  constructor(context: vscode.ExtensionContext) {
    this.onDidStart();

    let subscriptions = [
      vscode.workspace.onDidChangeTextDocument(
        (event: vscode.TextDocumentChangeEvent) =>
          this.onDidChange(event.document),
      ),

      vscode.workspace.onDidRenameFiles((event: vscode.FileRenameEvent) =>
        this.onDidRename(event),
      ),

      vscode.workspace.onDidDeleteFiles((event: vscode.FileDeleteEvent) =>
        this.onDidDelete(event),
      ),

      vscode.workspace.onDidCreateFiles((event: vscode.FileCreateEvent) =>
        this.onDidCreate(event),
      ),

      vscode.languages.registerDocumentLinkProvider(
        {
          scheme: "file",
          language: "writerly",
        },
        this,
      ),
    ];

    for (const subscription of subscriptions) {
      context.subscriptions.push(subscription);
    }
  }

  private async onDidStart() {
    // discover all parent directories containing __parent.wly files
    await this.discoverParentDirectories();

    // then process all existing .wly files in the workspace
    const uris = await vscode.workspace.findFiles("**/*.wly", null, 1500);
    for (const uri of uris) {
      this.processUri(uri);
    }
  }

  private async discoverParentDirectories() {
    // find all __parent.wly files
    const parentFiles = await vscode.workspace.findFiles(
      "**/__parent.wly",
      null,
      1500,
    );

    // extract directory paths containing __parent.wly files
    this.parents = parentFiles.map((uri) => {
      // remove the filename to get just the directory path
      const dirPath = uri.fsPath.replace(/[\/\\]__parent\.wly$/, "");
      return dirPath;
    });
  }

  private onDidChange(document: vscode.TextDocument): void {
    this.processDocument(document);
  }

  private onDidRename(event: vscode.FileRenameEvent): void {
    for (const file of event.files) {
      this.renameUri(file.oldUri, file.newUri);
    }
  }

  private onDidDelete(event: vscode.FileDeleteEvent): void {
    for (const uri of event.files) {
      this.deleteUri(uri);
    }
  }

  private async onDidCreate(event: vscode.FileCreateEvent): Promise<void> {
    for (const uri of event.files) {
      if (!uri.fsPath.endsWith(".wly")) return;
      this.processUri(uri);
      // todo (more work later)
    }
  }

  private async renameUri(oldUri: vscode.Uri, newUri: vscode.Uri) {
    for (const [handleName, definitions] of this.definitions) {
      this.definitions.set(
        handleName,
        definitions.map((def) =>
          def.fsPath === oldUri.fsPath
            ? { ...def, fsPath: newUri.fsPath }
            : def,
        ),
      );
    }
  }

  private deleteUri(uri: vscode.Uri) {
    // remove all items from the dictionary where def.fsPath === uri.fsPath
    for (const [handleName, definitions] of this.definitions) {
      const filtered = definitions.filter((def) => def.fsPath !== uri.fsPath);
      filtered.length === 0
        ? this.definitions.delete(handleName)
        : this.definitions.set(handleName, filtered);
    }
  }

  private async processUri(uri: vscode.Uri) {
    try {
      const document: vscode.TextDocument =
        await vscode.workspace.openTextDocument(uri);
      this.processDocument(document);
    } catch (e) {
      console.error("...");
    }
  }

  private processDocument(
    document: vscode.TextDocument,
  ): vscode.DocumentLink[] {
    const documentLinks: vscode.DocumentLink[] = [];
    const currentFsPath = document.uri.fsPath;

    // filter out all existing entries for this document
    for (const [handleName, definitions] of this.definitions) {
      const filteredDefinitions = definitions.filter(
        (def) => def.fsPath !== currentFsPath,
      );

      if (filteredDefinitions.length === 0) {
        this.definitions.delete(handleName);
      } else {
        this.definitions.set(handleName, filteredDefinitions);
      }
    }

    // use walker to find handle definitions and usage
    WriterlyDocumentWalker.walk(
      document,
      (
        _stateBeforeLine,
        lineType,
        _stateAfterLine,
        lineNumber,
        indent,
        content,
      ) => {
        if (lineType === LineType.Attribute) {
          const handleMatch = content.match(defRegex);
          if (handleMatch) {
            const fullHandleName = handleMatch[1];
            // truncate everything after ':' for the handle name
            const handleName = fullHandleName.split(":")[0];
            const handleStart = content.indexOf(handleMatch[0]);
            const range = new vscode.Range(
              lineNumber,
              indent + handleStart,
              lineNumber,
              indent + handleStart + handleMatch[0].length,
            );

            const definition: HandleDefinition = {
              fsPath: currentFsPath,
              range: range,
            };

            // add to definitions map
            if (!this.definitions.has(handleName)) {
              this.definitions.set(handleName, []);
            }
            this.definitions.get(handleName)!.push(definition);
          }
        }

        // find handle usage (>>handleName) outside of codeblocks
        if (
          lineType !== LineType.CodeBlockLine &&
          lineType !== LineType.CodeBlockOpening &&
          lineType !== LineType.CodeBlockClosing
        ) {
          let usageMatch;
          while ((usageMatch = usageRegex.exec(content)) !== null) {
            const handleName = usageMatch[1];
            const matchStart = usageMatch.index;
            const range = new vscode.Range(
              lineNumber,
              indent + matchStart,
              lineNumber,
              indent + matchStart + usageMatch[0].length,
            );

            // create DocumentLink for handle usage
            const link = new vscode.DocumentLink(range);
            link.data = {
              handleName: handleName,
              fsPath: currentFsPath,
            };

            documentLinks.push(link);
          }
        }
      },
    );

    return documentLinks;
  }

  public provideDocumentLinks(
    document: vscode.TextDocument,
    token: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.DocumentLink[]> {
    return this.processDocument(document);
  }

  public resolveDocumentLink(
    link: vscode.DocumentLink,
    token: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.DocumentLink> {
    const handleName = link.data?.handleName;
    const currentFsPath = link.data?.fsPath;

    if (!handleName || !currentFsPath) {
      return undefined;
    }

    const definitions = this.definitions.get(handleName);
    if (!definitions || definitions.length === 0) {
      return undefined;
    }

    const filteredDefinitions = definitions.filter((def) =>
      this.isInSameDocumentTree(currentFsPath, def.fsPath),
    );

    if (filteredDefinitions.length !== 1) {
      return undefined;
    }

    const definition = filteredDefinitions[0];
    const uri = vscode.Uri.file(definition.fsPath);
    const targetUri = this.attachRangeToUri(uri, definition.range);

    // set the target on the existing link
    link.target = targetUri;
    return link;
  }

  private attachRangeToUri(uri: vscode.Uri, range: vscode.Range): vscode.Uri {
    const line = range.start.line + 1;
    const character = range.start.character + 1;
    const fragment = `${line},${character}`;
    return uri.with({ fragment: fragment });
  }

  private isInSameDocumentTree(
    currentFsPath: string,
    definitionFsPath: string,
  ): boolean {
    if (currentFsPath === definitionFsPath) {
      return true;
    }

    // check if they share a common ancestor directory that contains __parent.wly
    // this is where we use the parents list
    return this.parents.some((parentPath) => {
      return (
        currentFsPath.startsWith(parentPath) &&
        definitionFsPath.startsWith(parentPath)
      );
    });
  }
}
