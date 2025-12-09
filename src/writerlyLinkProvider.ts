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
    // process all existing .wly files in the workspace:
    const uris = await vscode.workspace.findFiles("**/*.wly", null, 1500);
    for (const uri of uris) {
      this.processUri(uri);
    }
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

  // private processDocument(document: vscode.TextDocument): void {
  //   // todo
  // }

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
        stateBeforeLine,
        lineType,
        stateAfterLine,
        lineNumber,
        indent,
        content,
      ) => {
        // find handle definitions in attributes
        if (lineType === LineType.Attribute) {
          const handleMatch = content.match(
            /handle\s*=\s*([a-zA-Z_][-a-zA-Z0-9\._\:]*)/,
          );
          if (handleMatch) {
            const handleName = handleMatch[1];
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
          const usageRegex = />>\s*([a-zA-Z_][-a-zA-Z0-9\._\:]*)/g;
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
    // lookup link.data.handleName in definitions dictionary
    const handleName = link.data?.handleName;
    const currentFsPath = link.data?.fsPath;

    if (!handleName || !currentFsPath) {
      return undefined;
    }

    const definitions = this.definitions.get(handleName);
    if (!definitions || definitions.length === 0) {
      return undefined;
    }

    // filter out those entries that are not part of the same document tree
    const filteredDefinitions = definitions.filter((def) =>
      this.isInSameDocumentTree(currentFsPath, def.fsPath),
    );

    // if exactly one HandleDefinition remains, create target
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

  // public resolveDocumentLink(
  //   link: vscode.DocumentLink,
  //   token: vscode.CancellationToken,
  // ): vscode.ProviderResult<vscode.DocumentLink> {
  //   // get the handle name from the link data
  //   const handleName = link.data?.handleName;
  //   if (!handleName) {
  //     return undefined;
  //   }

  //   // look up the handle in our definitions map
  //   const definitions = this.definitions.get(handleName);
  //   if (!definitions || definitions.length === 0) {
  //     return undefined;
  //   }

  //   // use the first definition (you could enhance this to be smarter - e.g., prefer same file, closest match, etc.)
  //   const definition = definitions[0];

  //   // create a URI pointing to the definition location with line/column info
  //   const uri = vscode.Uri.file(definition.fsPath).with({
  //     fragment: `L${definition.range.start.line + 1},${definition.range.start.character + 1}`,
  //   });

  //   // create a new DocumentLink with the target URI
  //   const resolvedLink = new vscode.DocumentLink(link.range, uri);
  //   resolvedLink.data = link.data;

  //   return resolvedLink;
  // }
}
