"use strict";
import * as vscode from "vscode";
import WriterlyDocumentValidator from "./validator";
import { FileOpener } from "./fileOpener";
import { WriterlyHoverProvider } from "./hoverProvider";

export function activate(context: vscode.ExtensionContext) {
  // Instantiate a validator
  const collection = vscode.languages.createDiagnosticCollection("writerly");
  const validator = new WriterlyDocumentValidator(collection);

  // Validate on document open
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(
      (document: vscode.TextDocument) => validator.validateDocument(document)
    )
  );

  // Validate on document change
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument(
      (event: vscode.TextDocumentChangeEvent) => validator.validateDocument(event.document)
    ),
  );

  // Validate already open documents
  vscode.workspace.textDocuments.forEach(
    (document: vscode.TextDocument) => validator.validateDocument(document)
  );

  // Register the "Open File Under Cursor" command
  vscode.commands.registerCommand(
    "writerly.openFileUnderCursor",
    () => FileOpener.openFileUnderCursor(),
  );

  // Register hover provider for file paths
  vscode.languages.registerHoverProvider(
    { scheme: "file", language: "writerly" },
    new WriterlyHoverProvider(),
  );
}