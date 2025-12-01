import * as vscode from "vscode";
import path = require('path');

declare module 'vscode' {
    export interface DocumentLink {
        data: [string, vscode.Uri];
    }
}

export class WriterlyLinkProvider implements vscode.DocumentLinkProvider {
    regex1 = />>([\w\-\^]+)/g;
    regex2 = /handle=([^\s]*)/g;
    leadingSpacesRegex = /^ */;

    handles: Map<string, [vscode.Uri, vscode.Range]> = new Map([]);
    // tmpHandles: Map<string, [vscode.Uri, vscode.Range]> = new Map([]);
    public name: string = "bakari";

    // private numLeadingSpaces(content: string):number {
    //     const match = content.match(this.leadingSpacesRegex);
    //     return (match) ? match[0].length : 0;
    // }

    private async getTextDocumentReference(uri: vscode.Uri): Promise<vscode.TextDocument> {
    try {
        // openTextDocument loads the document data into memory if it's not already loaded.
        // It does NOT show the document in the editor UI.
        const document: vscode.TextDocument = await vscode.workspace.openTextDocument(uri);
        return document;
    } catch (error) {
        console.error(`Error loading document from URI: ${uri.fsPath}`, error);
        throw new Error(`Could not access document at ${uri.fsPath}`);
    }
}
    
    private regexMatchToRange(
        document: vscode.TextDocument,
        match: RegExpExecArray,
    ): vscode.Range {
        let startPos = document.positionAt(match.index);
        const endPos = document.positionAt(match.index + match[0].length);
        return new vscode.Range(startPos, endPos);
    }

    private basename(
        uri: vscode.Uri,
    ): string {
        return path.basename(uri.fsPath);
    }

    private deleteUri(
        uri: vscode.Uri,
    ): void {
        console.log(`deleting handles with uri ${this.basename(uri)}`);
        let tmpHandles: Map<string, [vscode.Uri, vscode.Range]> = new Map([]);
        this.handles.forEach((value, key, _map) => {
            let [keyUri, _] = value;
            if (keyUri.fsPath != uri.fsPath) {
                tmpHandles.set(key, value);
            } else {
                console.log(`DELETING handle ${key} from handles`);
            }
        });
        this.handles = tmpHandles;
    }

    private renameUri(
        oldUri: vscode.Uri,
        newUri: vscode.Uri,
    ): void {
        console.log(`renaming '${this.basename(oldUri)}' to '${this.basename(newUri)}'`);
        let tmpHandles: Map<string, [vscode.Uri, vscode.Range]> = new Map([]);
        this.handles.forEach((value, key, _) => {
            let [keyUri, range] = value;
            if (keyUri.fsPath != oldUri.fsPath) {
                tmpHandles.set(key, value);
            } else {
                tmpHandles.set(key, [newUri, range]);
            }
        });
        this.handles = tmpHandles;
    }

    private populateHandleMap(
        document: vscode.TextDocument,
    ): void {
        if (document.languageId !== "writerly") {
            console.error("wrongly categorized as 'writerly' document:", document.uri.fsPath);
            return; // I'd rather be made aware sooner than later of such a behavior...
        }
        console.log(`${this.name} top of populateHandleMap with uri = ${document.uri}`);
        this.deleteUri(document.uri);
        let text = document.getText();
        let match: RegExpExecArray | null;
        while ((match = this.regex2.exec(text)) !== null) {
            let content = match[1];
            let range = this.regexMatchToRange(document, match);
            console.log(`${this.name} setting handle ${content} to uri ${document.uri}; L${range.start.line}:${range.start.character}`);
            this.handles.set(content, [document.uri, range]);
            let test = this.handles.get(content);
            console.log(`${this.name} result (1) of trying to immediately get handle '${content}':`, test);
        }
        let test2 = this.handles.get("quizz");
        console.log(`${this.name} result (2) of trying to immediately get handle 'quizz' at end of populateHandleMap:`, test2);
    }

    public async onStart() {
        const uris = await vscode.workspace.findFiles('**/*', null, 1500);
        for (const uri of uris) {
            if (!uri.fsPath.endsWith(".wly")) continue;
            let document = await this.getTextDocumentReference(uri);
            this.populateHandleMap(document);
        }
    }

    public async onDidChange(
        document: vscode.TextDocument,
    ): Promise<void> {
        this.populateHandleMap(document);
    }

    public async onDidRename(
        event: vscode.FileRenameEvent,
    ): Promise<void> {
        for (const file of event.files) {
            this.renameUri(file.oldUri, file.newUri);
        }
    }

    public async onDidDelete(
        event: vscode.FileDeleteEvent,
    ): Promise<void> {
        for (const uri of event.files) {
            this.deleteUri(uri);
        }
    }

    public async provideDocumentLinks(
        document: vscode.TextDocument,
        _: vscode.CancellationToken,
    ): Promise<vscode.DocumentLink[]> {
        const links: vscode.DocumentLink[] = [];
        const text = document.getText();
        let match: RegExpExecArray | null;
        while ((match = this.regex1.exec(text)) !== null) {
            let range = this.regexMatchToRange(document, match);
            let link = new vscode.DocumentLink(range, undefined);
            link.data = [match[1], document.uri];
            links.push(link);
        }
        return links;
    }

    private createUriForRange(uri: vscode.Uri, range: vscode.Range): vscode.Uri {
        const line = range.start.line + 1;
        const character = range.start.character + 1;
        const fragment = `${line},${character}`;
        console.log("fragment:", fragment);
        return uri.with({ fragment: fragment });
    }
    
    public async resolveDocumentLink(
        link: vscode.DocumentLink,
        _token: vscode.CancellationToken,
    ): Promise<vscode.DocumentLink> {
        let target = link.target;
        let handle = link.data[0];
        console.log(`${this.name} wants to resolve:`, handle);
        let address = this.handles.get(handle);
        if (address !== undefined) {
            let [uri, range] = address;
            target = this.createUriForRange(uri, range);
        } else {
            console.log("address not found");
        }
        return new vscode.DocumentLink(link.range, target);
    }
}
