import * as vscode from 'vscode';
import { FileSide, partialSides, readFileAtCommit, sideText } from './fileAtCommit';
import { GitReader } from './gitReader';
import { PartialPlan, planModified, planOneSided } from './hunkSelector';
import { parseLines } from './validator';

export const SCHEME = 'deep-diff';

export interface SideRef {
  root: string;
  gitPath: string;
  sha: string;
  path: string;
}

/** [v1.1] Identifies a partial diff: both commits plus the merged ranges. */
export interface PartialRef {
  root: string;
  gitPath: string;
  left: string;
  right: string;
  path: string;
  /** Merged ranges in canonical form, e.g. `25-30,120-160`. */
  lines: string;
}

interface UriQuery {
  repo: string;
  git: string;
  /** Present only on a synthetic side. */
  partial?: { left: string; right: string; lines: string };
}

/**
 * URI layout (spec §7.2): deep-diff://<sha40>/<path>?<json>
 * The query carries the repo root and git executable path, and for a synthetic
 * side [v1.1] both commits and the ranges, so a restored tab can be rebuilt.
 */
export function toUri(ref: SideRef, partial?: PartialRef): vscode.Uri {
  const query: UriQuery = { repo: ref.root, git: ref.gitPath };
  if (partial) query.partial = { left: partial.left, right: partial.right, lines: partial.lines };
  return vscode.Uri.from({ scheme: SCHEME, authority: ref.sha, path: `/${ref.path}`, query: JSON.stringify(query) });
}

export function fromUri(uri: vscode.Uri): { side: SideRef; partial?: PartialRef } {
  const sha40 = /^[0-9a-f]{40}$/;
  if (uri.scheme !== SCHEME || !sha40.test(uri.authority)) throw new Error(`Not a ${SCHEME} URI: ${uri.toString()}`);
  const q = JSON.parse(uri.query) as Partial<UriQuery>;
  if (typeof q.repo !== 'string' || typeof q.git !== 'string') throw new Error('Malformed deep-diff query');
  const side: SideRef = { root: q.repo, gitPath: q.git, sha: uri.authority, path: uri.path.replace(/^\//, '') };
  if (!q.partial) return { side };
  const { left, right, lines } = q.partial;
  if (!sha40.test(left) || !sha40.test(right) || !parseLines(lines).ok) throw new Error('Malformed partial query');
  return { side, partial: { root: side.root, gitPath: side.gitPath, path: side.path, left, right, lines } };
}

const sideKey = (ref: SideRef) => `${ref.root}\0${ref.sha}\0${ref.path}`;
const partialKey = (ref: PartialRef) => `${ref.root}\0${ref.left}\0${ref.right}\0${ref.path}\0${ref.lines}`;

/** [v1.1] Result of planning a partial diff; `undefined` plan means ranges don't apply. */
export interface PartialResult {
  left: FileSide;
  right: FileSide;
  plan?: PartialPlan;
}

/**
 * Serves file content at a commit, and [v1.1] synthetic sides of partial diffs.
 * Commits are immutable, so entries are cached in memory for the lifetime of the
 * window and never invalidated. Failed reads are not cached.
 */
export class CommitContentProvider implements vscode.TextDocumentContentProvider {
  private readonly sides = new Map<string, Promise<FileSide>>();
  private readonly partials = new Map<string, Promise<PartialResult>>();

  constructor(
    private readonly maxBytes: () => number,
    private readonly log: vscode.LogOutputChannel,
  ) {}

  private cached<T>(map: Map<string, Promise<T>>, key: string, make: () => Promise<T>): Promise<T> {
    let pending = map.get(key);
    if (!pending) {
      pending = make();
      pending.catch(() => map.delete(key));
      map.set(key, pending);
    }
    return pending;
  }

  read(ref: SideRef): Promise<FileSide> {
    return this.cached(this.sides, sideKey(ref), () =>
      readFileAtCommit(new GitReader(ref.gitPath), ref.root, ref.sha, ref.path, this.maxBytes()),
    );
  }

  readPartial(ref: PartialRef): Promise<PartialResult> {
    return this.cached(this.partials, partialKey(ref), async () => {
      const base = { root: ref.root, gitPath: ref.gitPath, path: ref.path };
      const [left, right] = await Promise.all([this.read({ ...base, sha: ref.left }), this.read({ ...base, sha: ref.right })]);
      const parsed = parseLines(ref.lines);
      if (!parsed.ok) throw new Error(`Invalid ranges ${ref.lines}`);
      const ranges = parsed.ranges;
      const sides = partialSides(left, right);
      switch (sides.kind) {
        case 'modified': {
          const diff = await new GitReader(ref.gitPath).diffBlobs(ref.root, sides.leftOid, sides.rightOid, this.maxBytes());
          return { left, right, plan: planModified(sides.leftText, sides.rightText, diff, ranges) };
        }
        case 'added':
          return { left, right, plan: planOneSided(sides.rightText, 'right', ranges) };
        case 'deleted':
          return { left, right, plan: planOneSided(sides.leftText, 'left', ranges) };
        case 'unsupported':
          return { left, right };
      }
    });
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    try {
      const { side, partial } = fromUri(uri);
      if (partial) {
        const result = await this.readPartial(partial);
        if (result.plan) return result.plan.text;
      }
      return sideText(await this.read(side));
    } catch (error) {
      // Normally everything is read before the diff opens, so this only happens
      // when VS Code restores an old tab. Log it and show the failure inline.
      this.log.error(`Failed to provide ${uri.toString()}`, error);
      return `Could not read this file from git. See the "Deep Diff Links" output channel.`;
    }
  }
}
