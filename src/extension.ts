"use strict";
import * as vscode from "vscode";
import { WriterlyController } from "./WriterlyController";

export function activate(context: vscode.ExtensionContext) {
  new WriterlyController(context);
}
