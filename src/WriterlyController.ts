import * as vscode from "vscode";
import { WlyLinkProvider } from "./LinkProvider";
import { WlyFileProvider } from "./WlyFileProvider";
import { FileOpener } from "./FileOpener";
import { HoverProvider } from "./HoverProvider";
import { WlyCompletionProvider } from "./CompletionProvider";

export class WriterlyController {
  private providers: any[] = [];

  constructor(context: vscode.ExtensionContext) {
    this.providers = [
      new WlyLinkProvider(context),
      new FileOpener(context),
      new HoverProvider(context),
      new WlyFileProvider(context),
      new WlyCompletionProvider(context),
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
