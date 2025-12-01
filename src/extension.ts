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
  // b. declaring the dictionary type
  // c. writing a function that populates the dictionary for 1 document
  // d. calling this for all .wly docs on load
  // e. listen to uri deletions

  // Validate already open documents
  vscode.workspace.textDocuments.forEach(
    (document: vscode.TextDocument) => validator.validateDocument(document)
  );

  let linkProvider = new WriterlyLinkProvider();
  linkProvider.name = "sellers";
  linkProvider.onStart();

  let disposables: Array<vscode.Disposable> = [
    vscode.workspace.onDidOpenTextDocument(
      (document: vscode.TextDocument) => validator.validateDocument(document)
    ),  

    vscode.workspace.onDidChangeTextDocument(
      (event: vscode.TextDocumentChangeEvent) => validator.validateDocument(event.document)
    ),  

    vscode.workspace.onDidChangeTextDocument(
      (event: vscode.TextDocumentChangeEvent) => linkProvider.onDidChange(event.document)
    ),
    
    vscode.workspace.onDidRenameFiles(
      (event: vscode.FileRenameEvent) => linkProvider.onDidRename(event)
    ),

    vscode.workspace.onDidDeleteFiles(
      (event: vscode.FileDeleteEvent) => linkProvider.onDidDelete(event)
    ),

    vscode.commands.registerCommand(
      "writerly.openUnderCursorWithDefault",
      () => FileOpener.openUnderCursor(OpeningMethod.WITH_DEFAULT),
    ),

    vscode.commands.registerCommand(
      "writerly.openUnderCursorWithVSCode",
      () => FileOpener.openUnderCursor(OpeningMethod.WITH_VSCODE),
    ),

    vscode.commands.registerCommand(
      "writerly.openUnderCursorAsImageWithVSCode",
      () => FileOpener.openUnderCursor(OpeningMethod.AS_IMAGE_WITH_VSCODE),
    ),

    vscode.commands.registerCommand(
      "writerly.openResolvedPath",
      (path, method) => FileOpener.openResolvedPath(path, method),
    ),

    vscode.languages.registerHoverProvider(
      { scheme: "file", language: "writerly" },
      new WriterlyHoverProvider(),
    ),

    vscode.languages.registerDocumentLinkProvider(
      { scheme: "file", language: "writerly" },
      linkProvider,
    ),
  ];

  for (const disposable of disposables) {
    context.subscriptions.push(disposable);
  }
}