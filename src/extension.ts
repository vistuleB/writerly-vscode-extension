"use strict";
import * as vscode from "vscode";
import WriterlyIndentationValidator2 from "./indentation-validator";

export function activate(context: vscode.ExtensionContext) {
  const collection = vscode.languages.createDiagnosticCollection("writerly");

  // Register the indentation validator
  const indentationValidator = new WriterlyIndentationValidator2(collection);

  // Validate on document open
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((document) => {
      if (document.languageId === "writerly") {
        indentationValidator.validateDocument(document);
      }
    }),
  );

  // Validate on document change
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document.languageId === "writerly") {
        indentationValidator.validateDocument(event.document);
      }
    }),
  );

  // Validate already open documents
  vscode.workspace.textDocuments.forEach((document) => {
    if (document.languageId === "writerly") {
      indentationValidator.validateDocument(document);
    }
  });

  // John: code action was crappy but leaving for reference:

  // Register code action provider for quick fixes
  // const codeActionProvider = new WriterlyCodeActionProvider();
  // context.subscriptions.push(
  //   vscode.languages.registerCodeActionsProvider(
  //     "writerly",
  //     codeActionProvider,
  //   ),
  // );
}
