"use strict";
import * as vscode from "vscode";
import WriterlyDocumentValidator from "./validator";
import { FileOpener } from "./fileOpener";
import { WriterlyHoverProvider } from "./hoverProvider";

export function activate(context: vscode.ExtensionContext) {
  const collection = vscode.languages.createDiagnosticCollection("writerly");

  // Register the indentation validator
  const validator = new WriterlyDocumentValidator(collection);

  // Validate on document open
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((document) => {
      if (document.languageId === "writerly") {
        validator.validateDocument(document);
      }
    }),
  );

  // Validate on document change
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document.languageId === "writerly") {
        validator.validateDocument(event.document);
      }
    }),
  );

  // Validate already open documents
  vscode.workspace.textDocuments.forEach((document) => {
    if (document.languageId === "writerly") {
      validator.validateDocument(document);
    }
  });

  // Register the "Open File Under Cursor" command
  const openFileCommand = vscode.commands.registerCommand(
    "writerly.openFileUnderCursor",
    () => FileOpener.openFileUnderCursor(),
  );
  context.subscriptions.push(openFileCommand);

  // Register hover provider for file paths
  const hoverProvider = vscode.languages.registerHoverProvider(
    { scheme: "file", language: "writerly" },
    new WriterlyHoverProvider(),
  );
  context.subscriptions.push(hoverProvider);
}
