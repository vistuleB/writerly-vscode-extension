"use strict";
import * as vscode from "vscode";
import * as path from 'path';
// import DocumentValidator from "./DocumentValidator";
import { WlyFileProvider } from "./WlyFileProvider";
import { FileOpener } from "./FileOpener";
import { HoverProvider } from "./HoverProvider";
import { WriterlyLinkProvider } from "./LinkProvider";
import { WriterlyDocumentWalker } from "./walker";

export function activate(context: vscode.ExtensionContext) {
  new WriterlyLinkProvider(context);
  new FileOpener(context);
  new HoverProvider(context);
  new WlyFileProvider(context);
}
