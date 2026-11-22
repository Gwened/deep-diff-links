import * as vscode from 'vscode';
import { CommitContentProvider, SCHEME } from './contentProvider';
import { DiffOpener } from './diffOpener';
import { findForeignLinks, markdownItSchemePlugin } from './linkRewriter';
import { DeepDiffUriHandler, HandleResult } from './uriHandler';

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
/**
 * Former extension ids. Links using them are rewritten to the current id in Markdown.
 * Add an entry here if the publisher or name ever changes. Empty: no former ids are supported.
 */
const LEGACY_IDS: string[] = [];

/** Returned from activate. `handleUri` is for integration tests; `extendMarkdownIt` is for the markdown preview. */
export interface DeepDiffLinksApi {
  handleUri(uri: vscode.Uri): Promise<HandleResult>;
  extendMarkdownIt<T>(md: T): T;
}

export function activate(context: vscode.ExtensionContext): DeepDiffLinksApi {
  const id = context.extension.id;
  const legacy = LEGACY_IDS.filter((old) => old !== id.toLowerCase());
  const log = vscode.window.createOutputChannel('Deep Diff Links', { log: true });
  const maxBytes = () =>
    vscode.workspace.getConfiguration('deepDiffLinks').get<number>('maxFileBytes', DEFAULT_MAX_BYTES);

  const provider = new CommitContentProvider(maxBytes, log);
  const handler = new DeepDiffUriHandler(new DiffOpener(provider, maxBytes), log);

  context.subscriptions.push(
    log,
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, provider),
    vscode.window.registerUriHandler(handler),
    // In the markdown source editor, links written with another editor's scheme would be
    // opened as files and fail. Provide a link to the same place with this editor's scheme.
    vscode.languages.registerDocumentLinkProvider(
      { language: 'markdown' },
      {
        provideDocumentLinks(doc) {
          return findForeignLinks(doc.getText(), id, vscode.env.uriScheme, legacy).map(
            (l) => new vscode.DocumentLink(new vscode.Range(doc.positionAt(l.start), doc.positionAt(l.end)), vscode.Uri.parse(l.target)),
          );
        },
      },
    ),
  );

  return {
    handleUri: (uri) => handler.handle(uri),
    // Links written as vscode:// (or cursor://) are rewritten to this editor's own scheme,
    // so one review file works in VS Code and in Cursor.
    extendMarkdownIt: (md) => markdownItSchemePlugin(md, id, vscode.env.uriScheme, legacy),
  };
}

export function deactivate(): void {}
