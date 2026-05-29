import * as vscode from "vscode";

export class WriterlyRenameWatcher {
  filesBeforeRename: vscode.Uri[] = []; // Store the list of files before the rename operation. so we can get the full old path of the file mentioned in the src attribute

  constructor(context: vscode.ExtensionContext) {
    this.setFilesBeforeRename();
    context.subscriptions.push(
      vscode.workspace.onDidRenameFiles(async (event) => {
        await this.walkThroughWlyFiles(
          event.files[0].oldUri.fsPath,
          event.files[0].newUri.fsPath
        );
        this.setFilesBeforeRename();
      })
    );
  }

  public reset(): void {
    // No internal state to clear.
  }

  setFilesBeforeRename(): void {
    vscode.workspace
      .findFiles("**/*", "{**/node_modules/**,**/.*/**,**/dist/**,**/build/**}")
      .then((uris) => {
        this.filesBeforeRename = uris;
      });
  }

  /*
    old url : path/images
    new url : path/assets/images
    src     : path/images/x.png 

    we need to find all .wly files that have src=somepath where somepath is equal to old url or is contained in it. e.g. images/**.x
    then we verify if  the file **.x exists in the new path (assets/images/**.x) and if it does we update the src to the new path.
  */
  async walkThroughWlyFiles(oldPath?: string, newPath?: string): Promise<void> {
    if (!vscode.workspace.workspaceFolders || !oldPath || !newPath)
      return Promise.resolve();

    const pattern = new vscode.RelativePattern(
      vscode.workspace.workspaceFolders[0],
      "**/*.wly"
    );

    const uris = await vscode.workspace.findFiles(pattern);
    // we will collect all changes first and then apply them at once in the end to avoid multiple edits
    const changes: {
      uri: vscode.Uri;
      lineNumber: number;
      change: string;
    }[] = [];

    await Promise.all(
      // parellel processing of files to speed up the process
      uris.map(async (uri) => {
        const { result: content, error } = await tryCatch(
          vscode.workspace.openTextDocument(uri)
        );
        if (!content || error) {
          console.error("Error opening text document:", error);
          return;
        }
        const text = content.getText();
        const lines = text.split("\n");

        await Promise.all(
          // parellel processing of lines to speed up the process
          lines.map(async (line, index) => {
            // regex to find src=xxx with or without quotes
            const regex = /src\s*=\s*["']?([^"'\s]+)["']?/;
            const match = regex.exec(line);
            if (match !== null) {
              const srcPath = match[1];
              // find full path of the src e.g. images/x.png --> root/public/images/x.png
              const fullSrcPath = findFullPathOfSubPath(
                srcPath,
                this.filesBeforeRename
              );

              if (fullSrcPath && fullSrcPath.startsWith(oldPath)) {
                const newSrcPath = fullSrcPath.replace(oldPath, newPath);
                const fileUri = vscode.Uri.file(newSrcPath);
                const { error } = await tryCatch(
                  vscode.workspace.fs.stat(fileUri)
                );
                if (error) {
                  console.log(
                    `File ${newSrcPath} does not exist in new path, skipping update for this src.`
                  );
                  return;
                }

                // file exists, we can update the src in the .wly file

                // new src should be prefixed same as origin src path, e.g. if src is images/x.png and images was renamed to assets/images then we should prefix new src with assets/images/x.png instead of path/assets/images/x.png
                const sharedBase = getSharedOldAndNewPathsBase(
                  oldPath,
                  newPath
                ); // e.g. path/
                const prefix = newPath.replace(sharedBase, ""); // e.g. assets/images/
                const srcPathSuffix = fullSrcPath.replace(oldPath, ""); // e.g. x.png
                const finalSrcPath = prefix + srcPathSuffix; // e.g. assets/images/x.png

                const newLine = line.replace(srcPath, finalSrcPath);
                changes.push({ uri, lineNumber: index, change: newLine });
              }
            }
          })
        );
      })
    );

    if (changes.length > 0) {
      const edit = new vscode.WorkspaceEdit();
      changes.forEach((change) => {
        const range = new vscode.Range(
          change.lineNumber,
          0,
          change.lineNumber,
          change.change.length
        );
        edit.replace(change.uri, range, change.change);
      });
      const { result, error } = await tryCatch(
        vscode.workspace.applyEdit(edit)
      );
      if (!result || error) {
        console.error("Error applying edits to .wly files:", error);
      } else {
        console.log(
          `Applied ${changes.length} line changes to ${uris.length} .wly files.`
        );
      }
    }
  }
}

/**
 * images/x.png --> root/public/images/x.png
 */
function findFullPathOfSubPath(
  subPath: string,
  filesBeforeRename: vscode.Uri[]
): string | null {
  const subPathParts = subPath.split("/").filter((part) => part.length > 0);
  const matchingFiles = filesBeforeRename.filter((uri) => {
    const uriParts = uri.fsPath.split("/").filter((part) => part.length > 0);
    return subPathParts.every((part, index) => {
      const uriPart = uriParts[uriParts.length - subPathParts.length + index];
      return uriPart === part;
    });
  });
  if (matchingFiles.length === 1) {
    // we found exactly one file that matches the subPath, if there are more than one we can't be sure which one is the right one so we return null . maybe we think about this more later
    return matchingFiles[0].fsPath;
  }
  return null;
}

function getSharedOldAndNewPathsBase(oldPath: string, newPath: string): string {
  let sharedBase = "";
  let part = "";

  for (let i = 0; i < oldPath.length; i++) {
    if (oldPath[i] === newPath[i]) {
      part += oldPath[i];
      if (oldPath[i] === "/") {
        sharedBase += part;
        part = "";
      }
    } else {
      break;
    }
  }
  return sharedBase;
}

function tryCatch<T, Error>(
  thenable: Thenable<T>
): Promise<{ result?: T; error?: Error }> {
  return new Promise((resolve) => {
    thenable.then(
      (result) => {
        resolve({ result });
      },
      (error) => {
        resolve({ error });
      }
    );
  });
}
