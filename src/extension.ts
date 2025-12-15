"use strict";
import * as vscode from "vscode";
import * as path from 'path';
import DocumentValidator from "./DocumentValidator";
import { WlyFileProvider } from "./WlyFileProvider";
import { FileOpener, OpeningMethod } from "./FileOpener";
import { HoverProvider } from "./HoverProvider";
import { WriterlyLinkProvider } from "./LinkProvider";

export function activate(context: vscode.ExtensionContext) {
  // Instantiate a validator
  const collection = vscode.languages.createDiagnosticCollection("writerly");
  const validator = new DocumentValidator(collection);

  new WriterlyLinkProvider(context);

  // Validate already open documents
  vscode.workspace.textDocuments.forEach((document: vscode.TextDocument) =>
    validator.validateDocument(document)
  );

  let disposables: Array<vscode.Disposable> = [
    // Validate on document open
    vscode.workspace.onDidOpenTextDocument((document: vscode.TextDocument) =>
      validator.validateDocument(document)
    ),

    // Validate on document change
    vscode.workspace.onDidChangeTextDocument(
      (event: vscode.TextDocumentChangeEvent) =>
        validator.validateDocument(event.document)
    ),

    // Register the "Open File Under Cursor With Default" command
    vscode.commands.registerCommand("writerly.openUnderCursorWithDefault", () =>
      FileOpener.openUnderCursor(OpeningMethod.WITH_DEFAULT)
    ),

    // Register the "Open File Under Cursor With VSCode" command
    vscode.commands.registerCommand("writerly.openUnderCursorWithVSCode", () =>
      FileOpener.openUnderCursor(OpeningMethod.WITH_VSCODE)
    ),

    // Register the "Open File Under Cursor As Image With VSCode" command
    vscode.commands.registerCommand(
      "writerly.openUnderCursorAsImageWithVSCode",
      () => FileOpener.openUnderCursor(OpeningMethod.AS_IMAGE_WITH_VSCODE)
    ),

    // This one is for API-centric usage:
    vscode.commands.registerCommand(
      "writerly.openResolvedPath",
      (path, method) => FileOpener.openResolvedPath(path, method)
    ),

    // Register hover provider for file paths
    vscode.languages.registerHoverProvider(
      { scheme: "file", language: "writerly" },
      new HoverProvider()
    ),
  ];

  for (const disposable of disposables) {
    context.subscriptions.push(disposable);
  }

  // Instantiate the provider, which sets up the watchers in its constructor
  const wlyFileProvider = new WlyFileProvider();

  // Register the provider with VS Code
  vscode.window.registerTreeDataProvider("wlyFiles", wlyFileProvider);

  // Optional: Register a command to manually refresh the view via the command palette
  context.subscriptions.push(
    vscode.commands.registerCommand("wlyFiles.refreshEntry", () =>
      wlyFileProvider.refresh()
    )
  );
}
