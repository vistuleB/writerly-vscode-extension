"use strict";
import * as vscode from "vscode";
import { WriterlyDocumentValidator } from "./validator";
import { FileOpener, OpeningMethod } from "./fileOpener";
import { WriterlyHoverProvider } from "./hoverProvider";
import { WriterlyLinkProvider } from "./documentLinkProvider";

export function activate(context: vscode.ExtensionContext) {
  // Instantiate a validator
  const collection = vscode.languages.createDiagnosticCollection("writerly");
  const validator = new WriterlyDocumentValidator(collection);
  
  // Game plan
  // work backwards from final functionality v1.0
  // - highlighted links
  // - that work (or not) when you click them
  // highlighting the links seems pretty straightforward
  // what about resolving a link?
  // you need side information stored in link.data and your private vars
  // link.data:
  // - the handle string value
  // - the document Uri
  // private vars:
  // - dictionary that maps handle values to occurrences (Uri + Range)
  // to maintain this dictionary though you have to:
  // 1. read all .wly in the workspace files once
  // 2. re-read a .wly file on save
  // 3. be appraised of deletions
  // 4. ...and renamings
  // ...ok so I guess we should start with:
  // a. changing the link.data type to be a string + Uri value
  // b. 

  // Validate already open documents
  vscode.workspace.textDocuments.forEach(
    (document: vscode.TextDocument) => validator.validateDocument(document)
  );

  let disposables: Array<vscode.Disposable> = [
    // Validate on document open
    vscode.workspace.onDidOpenTextDocument(
      (document: vscode.TextDocument) => validator.validateDocument(document)
    ),  

    // Validate on document change
    vscode.workspace.onDidChangeTextDocument(
      (event: vscode.TextDocumentChangeEvent) => validator.validateDocument(event.document)
    ),  

    // Register the "Open File Under Cursor With Default" command
    vscode.commands.registerCommand(
      "writerly.openUnderCursorWithDefault",
      () => FileOpener.openUnderCursor(OpeningMethod.WITH_DEFAULT),
    ),

    // Register the "Open File Under Cursor With VSCode" command
    vscode.commands.registerCommand(
      "writerly.openUnderCursorWithVSCode",
      () => FileOpener.openUnderCursor(OpeningMethod.WITH_VSCODE),
    ),

    // Register the "Open File Under Cursor As Image With VSCode" command
    vscode.commands.registerCommand(
      "writerly.openUnderCursorAsImageWithVSCode",
      () => FileOpener.openUnderCursor(OpeningMethod.AS_IMAGE_WITH_VSCODE),
    ),

    // This one is for API-centric usage:
    vscode.commands.registerCommand(
      "writerly.openResolvedPath",
      (path, method) => FileOpener.openResolvedPath(path, method),
    ),

    // Register hover provider for file paths
    vscode.languages.registerHoverProvider(
      { scheme: "file", language: "writerly" },
      new WriterlyHoverProvider(),
    ),

    // Register hover provider for file paths
    vscode.languages.registerDocumentLinkProvider(
      { scheme: "file", language: "writerly" },
      new WriterlyLinkProvider(),
    ),
  ];

  for (const disposable of disposables) {
    context.subscriptions.push(disposable);
  }
}