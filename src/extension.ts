"use strict";
import * as vscode from "vscode";
import * as path from 'path';
import DocumentValidator from "./DocumentValidator";
import { WlyFileProvider } from "./WlyFileProvider";
import { FileOpener, OpeningMethod } from "./FileOpener";
import { HoverProvider } from "./HoverProvider";
import { WriterlyLinkProvider } from "./LinkProvider";

export function activate(context: vscode.ExtensionContext) {
  new DocumentValidator(context);
  new WlyFileProvider(context);
  new WriterlyLinkProvider(context);
  new FileOpener(context);
  new HoverProvider(context);
}
