"use strict";
import * as vscode from "vscode";
import WriterlyDocumentValidator from "./validator";

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
}
