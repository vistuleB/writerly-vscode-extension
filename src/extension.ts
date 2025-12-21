"use strict";
import * as vscode from "vscode";
import { WlyFileProvider } from "./WlyFileProvider";
import { FileOpener } from "./FileOpener";
import { HoverProvider } from "./HoverProvider";
import { WlyCompletionProvider } from "./CompletionProvider";
import { WlyLinkProvider } from "./LinkProvider";

export function activate(context: vscode.ExtensionContext) {
  new WlyLinkProvider(context);
  new FileOpener(context);
  new HoverProvider(context);
  new WlyFileProvider(context);
  new WlyCompletionProvider(context);
}
