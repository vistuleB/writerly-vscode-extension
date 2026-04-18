import * as vscode from "vscode";
import { WriterlyLinkProvider } from "./WriterlyLinkProvider";
import { WriterlyFileProvider } from "./WriterlyFileProvider";
import { WriterlyFileOpener } from "./WriterlyFileOpener";
import { WriterlyHoverProvider } from "./WriterlyHoverProvider";
import { WriterlyCompletionProvider } from "./WriterlyCompletionProvider";

export class WriterlyController {
  private providers: any[] = [];

  constructor(context: vscode.ExtensionContext) {
    this.providers = [
      new WriterlyFileOpener(context),
      new WriterlyHoverProvider(context),
      new WriterlyFileProvider(context),
      new WriterlyCompletionProvider(context),
      new WriterlyLinkProvider(context),
    ];

    // Register the master restart command
    context.subscriptions.push(
      vscode.commands.registerCommand("writerly.restart", () => this.restart()),
    );
  }

  public async restart() {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Writerly",
        cancellable: false,
      },
      async (progress) => {
        progress.report({ message: "Restarting all providers..." });

        for (const provider of this.providers) {
          if (typeof provider.reset === "function") {
            await Promise.resolve(provider.reset());
          }
        }
      },
    );
  }
}
