"use strict";
import * as vscode from "vscode";
import WriterlyDocumentValidator from "./validator";
import { FileOpener, OpeningMethod } from "./fileOpener";
import { WriterlyHoverProvider } from "./hoverProvider";
import { WriterlyLinkProvider } from "./writerlyLinkProvider";

export function activate(context: vscode.ExtensionContext) {
  // Instantiate a validator
  const collection = vscode.languages.createDiagnosticCollection("writerly");
  const validator = new WriterlyDocumentValidator(collection);

  new WriterlyLinkProvider(context);

  // Validate already open documents
  vscode.workspace.textDocuments.forEach((document: vscode.TextDocument) =>
    validator.validateDocument(document),
  );

  let disposables: Array<vscode.Disposable> = [
    // Validate on document open
    vscode.workspace.onDidOpenTextDocument((document: vscode.TextDocument) =>
      validator.validateDocument(document),
    ),

    // Validate on document change
    vscode.workspace.onDidChangeTextDocument(
      (event: vscode.TextDocumentChangeEvent) =>
        validator.validateDocument(event.document),
    ),

    // Register the "Open File Under Cursor With Default" command
    vscode.commands.registerCommand("writerly.openUnderCursorWithDefault", () =>
      FileOpener.openUnderCursor(OpeningMethod.WITH_DEFAULT),
    ),

    // Register the "Open File Under Cursor With VSCode" command
    vscode.commands.registerCommand("writerly.openUnderCursorWithVSCode", () =>
      FileOpener.openUnderCursor(OpeningMethod.WITH_VSCODE),
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
  ];

  for (const disposable of disposables) {
    context.subscriptions.push(disposable);
  }
}
