import * as vscode from 'vscode';
import { DiffOpened, DiffOpener } from './diffOpener';
import { ErrorCode, LinkError, messages } from './errors';
import { resolveCommits } from './fileAtCommit';
import { GitReader } from './gitReader';
import { resolveRepo } from './repoResolver';
import { formatRanges, parseQuery, validateParams } from './validator';

export type HandleResult =
  | ({ ok: true } & DiffOpened)
  | { ok: false; code: ErrorCode; message: string };

export class DeepDiffUriHandler implements vscode.UriHandler {
  constructor(
    private readonly opener: DiffOpener,
    private readonly log: vscode.LogOutputChannel,
  ) {}

  async handleUri(uri: vscode.Uri): Promise<void> {
    await this.handle(uri);
  }

  /** Runs the whole flow and reports every failure (notification + log). Never throws. */
  async handle(uri: vscode.Uri): Promise<HandleResult> {
    const entries = parseQuery(uri.query);
    try {
      return { ok: true, ...(await this.run(uri, entries)) };
    } catch (error) {
      const linkError =
        error instanceof LinkError ? error : new LinkError('E2', 'Deep diff link failed. See the output channel.', error);
      this.log.error(
        `[${linkError.code}] ${linkError.message}`,
        `link: path=${uri.path} params=${JSON.stringify(Object.fromEntries(entries))}`,
        linkError.detail ?? '',
      );
      void vscode.window.showErrorMessage(linkError.message);
      return { ok: false, code: linkError.code, message: linkError.message };
    }
  }

  private async run(uri: vscode.Uri, entries: Array<[string, string]>) {
    if (uri.path !== '/diff') {
      throw new LinkError('E1', messages.invalid('path', `of the link must be /diff`), uri.path);
    }
    const v = validateParams(entries);
    if (!v.ok) throw new LinkError('E1', messages.invalid(v.param, v.reason));
    const p = v.params;
    this.log.info(
      `Opening ${p.repo}:${p.path} ${p.left}..${p.right}${p.line ? ` line ${p.line}` : ''}${p.ranges ? ` lines ${formatRanges(p.ranges)}` : ''}`,
    );

    const { root, gitPath } = await resolveRepo(p.repo);

    let lookups;
    try {
      lookups = await resolveCommits(new GitReader(gitPath), root, [p.left, p.right]);
    } catch (error) {
      throw new LinkError('E2', messages.gitFailedCommit(`${p.left}..${p.right}`), error);
    }
    const shas: string[] = [];
    for (const [i, param] of (['left', 'right'] as const).entries()) {
      const r = lookups[i];
      if (r.status === 'missing') throw new LinkError('U3', messages.commitNotFound(p[param], p.repo));
      if (r.status === 'ambiguous') {
        throw new LinkError('E1', messages.invalid(param, 'matches more than one object; use a longer SHA'));
      }
      shas.push(r.sha);
    }

    return this.opener.open({
      repoName: p.repo,
      root,
      gitPath,
      left: shas[0],
      right: shas[1],
      path: p.path,
      line: p.line,
      ranges: p.ranges,
    });
  }
}
