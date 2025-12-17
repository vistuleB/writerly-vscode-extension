"use strict";
import * as vscode from "vscode";
import { WlyFileProvider } from "./WlyFileProvider";
import { FileOpener } from "./FileOpener";
import { HoverProvider } from "./HoverProvider";
import { WriterlyLinkProvider } from "./LinkProvider";

export function activate(context: vscode.ExtensionContext) {
  new WriterlyLinkProvider(context);
  new FileOpener(context);
  new HoverProvider(context);
  new WlyFileProvider(context);
}
