import * as vscode from "vscode";

declare module 'vscode' {
    export interface DocumentLink {
        data: [string, vscode.Uri];
    }
}

export class WriterlyLinkProvider implements vscode.DocumentLinkProvider {
    regex1 = />>([\w\-\^]+)/g;
    regex2 = /([ ]*)handle=([^ ]*)/g;
    
    leadingSpacesRegex = /^ */; 

    private numLeadingSpaces(content: string):number {
        const match = content.match(this.leadingSpacesRegex);
        if (match) {
            return match[0].length;
        }
        return 0;
    }

    handles: Map<string, [vscode.TextDocument, vscode.Range]> = new Map([]);

    private regexMatchToRange(
        document: vscode.TextDocument,
        match: RegExpExecArray,
    ): vscode.Range {
        const content = match[0];
        let numSpaces = this.numLeadingSpaces(content);
        let startPos = document.positionAt(match.index);
        startPos = new vscode.Position(startPos.line, startPos.character + numSpaces);
        const endPos = document.positionAt(match.index + match[0].length);
        return new vscode.Range(startPos, endPos);
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
        while ((match = this.regex2.exec(text)) !== null) {
            let content = match[2];
            let range = this.regexMatchToRange(document, match);
            this.handles.set(content, [document, range]);
        }
        return links;
    }

    private createUriForRange(document: vscode.TextDocument, range: vscode.Range): vscode.Uri {
        const line = range.start.line + 1;
        const character = range.start.character + 1;
        const fragment = `${line},${character}`;
        console.log("fragment:", fragment);
        return document.uri.with({ fragment: fragment });
    }
    
    public async resolveDocumentLink(
        link: vscode.DocumentLink,
        _token: vscode.CancellationToken,
    ): Promise<vscode.DocumentLink> {
        let target = link.target;
        let address = this.handles.get(link.data[0]);
        if (address !== undefined) {
            let [document, range] = address;
            target = this.createUriForRange(document, range);
        }
        return new vscode.DocumentLink(link.range, target);
    }
}
