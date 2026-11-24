import * as vscode from 'vscode';
import { DiffOpened, DiffOpener } from './diffOpener';
import { ErrorCode, LinkError, messages } from './errors';
import { resolveCommits } from './fileAtCommit';
import { GitReader, headCommitSpec, stashCommitSpec } from './gitReader';
import { resolveRepo } from './repoResolver';
import { formatRanges, parseQuery, parseSide, toUriSide, validateParams } from './validator';

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
      `Opening ${p.repo}:${p.path ?? '*'} ${p.left}..${p.right}${p.line ? ` line ${p.line}` : ''}${p.ranges ? ` lines ${formatRanges(p.ranges)}` : ''}`,
    );

    const { root, gitPath } = await resolveRepo(p.repo);
    const reader = new GitReader(gitPath);
    const left = await resolveLinkSide(reader, root, 'left', p.left, p.repo);
    const right = await resolveLinkSide(reader, root, 'right', p.right, p.repo);

    return this.opener.open({
      repoName: p.repo,
      root,
      gitPath,
      left,
      right,
      path: p.path,
      line: p.line,
      ranges: p.ranges,
    });
  }
}

async function resolveLinkSide(
  reader: GitReader,
  root: string,
  param: 'left' | 'right',
  value: string,
  repo: string,
): Promise<string> {
  const token = parseSide(value);
  if (!token) throw new LinkError('E1', messages.invalid(param, 'is not a valid side'));
  try {
    switch (token.kind) {
      case 'sha': {
        const [r] = await resolveCommits(reader, root, [token.value]);
        if (r.status === 'missing') throw new LinkError('U3', messages.commitNotFound(value, repo));
        if (r.status === 'ambiguous') {
          throw new LinkError('E1', messages.invalid(param, 'matches more than one object; use a longer SHA'));
        }
        return toUriSide(token, r.sha);
      }
      case 'HEAD': {
        const sha = await reader.revParseVerify(root, headCommitSpec());
        if (!sha) throw new LinkError('U19', messages.headNotFound(repo));
        return toUriSide(token);
      }
      case 'stash': {
        const sha = await reader.revParseVerify(root, stashCommitSpec(token.n));
        if (!sha) throw new LinkError('U18', messages.stashNotFound(`stash@{${token.n}}`, repo));
        return toUriSide(token);
      }
      case 'worktree':
      case 'staged':
        return toUriSide(token);
    }
  } catch (error) {
    if (error instanceof LinkError) throw error;
    throw new LinkError('E2', messages.gitFailedCommit(value), error);
  }
}
