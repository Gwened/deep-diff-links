import * as path from 'path';
import * as vscode from 'vscode';
import { FileSide, partialSides, readFileAtSide, sideText } from './fileAtCommit';
import { GitReader } from './gitReader';
import { PartialPlan, planModified, planOneSided } from './hunkSelector';
import { watchRepoState } from './repoResolver';
import { URI_SIDE_RE, isLiveUriSide, parseLines } from './validator';

export const SCHEME = 'deep-diff';

export interface SideRef {
  root: string;
  gitPath: string;
  /** `deep-diff://` authority: sha40, `HEAD`, `worktree`, `staged`, or `stash.N`. */
  side: string;
  path: string;
}

/** [v1.1] Identifies a partial diff: both sides plus the merged ranges. */
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
 * URI layout (spec §7.2): deep-diff://<sha40|live>/<path>?<json>
 * The query carries the repo root and git executable path, and for a synthetic
 * side both side identities and the ranges, so a restored tab can be rebuilt.
 */
export function toUri(ref: SideRef, partial?: PartialRef): vscode.Uri {
  const query: UriQuery = { repo: ref.root, git: ref.gitPath };
  if (partial) query.partial = { left: partial.left, right: partial.right, lines: partial.lines };
  return vscode.Uri.from({ scheme: SCHEME, authority: ref.side, path: `/${ref.path}`, query: JSON.stringify(query) });
}

export function fromUri(uri: vscode.Uri): { side: SideRef; partial?: PartialRef } {
  if (uri.scheme !== SCHEME || !URI_SIDE_RE.test(uri.authority)) throw new Error(`Not a ${SCHEME} URI: ${uri.toString()}`);
  const q = JSON.parse(uri.query) as Partial<UriQuery>;
  if (typeof q.repo !== 'string' || typeof q.git !== 'string') throw new Error('Malformed deep-diff query');
  const side: SideRef = { root: q.repo, gitPath: q.git, side: uri.authority, path: uri.path.replace(/^\//, '') };
  if (!q.partial) return { side };
  const { left, right, lines } = q.partial;
  if (!URI_SIDE_RE.test(left) || !URI_SIDE_RE.test(right) || !parseLines(lines).ok) throw new Error('Malformed partial query');
  return { side, partial: { root: side.root, gitPath: side.gitPath, path: side.path, left, right, lines } };
}

const sideKey = (ref: SideRef) => `${ref.root}\0${ref.side}\0${ref.path}`;
const partialKey = (ref: PartialRef) => `${ref.root}\0${ref.left}\0${ref.right}\0${ref.path}\0${ref.lines}`;

const gitLive = (id: string) => id === 'HEAD' || id === 'head' || id === 'staged' || id.startsWith('stash.');
const worktreeLive = (id: string) => id === 'worktree';
const fileWatchKey = (root: string, relPath: string) => `${root}\0${relPath}`;

/** [v1.1] Result of planning a partial diff; `undefined` plan means ranges don't apply. */
export interface PartialResult {
  left: FileSide;
  right: FileSide;
  plan?: PartialPlan;
}

/**
 * Serves file content at a side, and [v1.1] synthetic sides of partial diffs.
 * Commit SHAs are immutable and cached for the window. Live sides re-read and
 * emit `onDidChange` while a live URI is open. Failed reads are not cached.
 */
export class CommitContentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly sides = new Map<string, Promise<FileSide>>();
  private readonly partials = new Map<string, Promise<PartialResult>>();
  private readonly liveUris = new Map<string, vscode.Uri>();
  private readonly fileWatchers = new Map<string, vscode.FileSystemWatcher>();
  private readonly gitWatchers = new Map<string, vscode.Disposable>();
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

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
    const load = () => readFileAtSide(new GitReader(ref.gitPath), ref.root, ref.side, ref.path, this.maxBytes());
    if (isLiveUriSide(ref.side)) return load();
    return this.cached(this.sides, sideKey(ref), load);
  }

  readPartial(ref: PartialRef): Promise<PartialResult> {
    const load = async () => {
      const base = { root: ref.root, gitPath: ref.gitPath, path: ref.path };
      const [left, right] = await Promise.all([this.read({ ...base, side: ref.left }), this.read({ ...base, side: ref.right })]);
      const parsed = parseLines(ref.lines);
      if (!parsed.ok) throw new Error(`Invalid ranges ${ref.lines}`);
      const ranges = parsed.ranges;
      const sides = partialSides(left, right);
      switch (sides.kind) {
        case 'modified': {
          const reader = new GitReader(ref.gitPath);
          const diff =
            sides.leftOid && sides.rightOid
              ? await reader.diffBlobs(ref.root, sides.leftOid, sides.rightOid, this.maxBytes())
              : await reader.diffNoIndex(sides.leftText, sides.rightText, this.maxBytes());
          return { left, right, plan: planModified(sides.leftText, sides.rightText, diff, ranges) };
        }
        case 'added':
          return { left, right, plan: planOneSided(sides.rightText, 'right', ranges) };
        case 'deleted':
          return { left, right, plan: planOneSided(sides.leftText, 'left', ranges) };
        case 'unsupported':
          return { left, right };
      }
    };
    if (isLiveUriSide(ref.left) || isLiveUriSide(ref.right)) return load();
    return this.cached(this.partials, partialKey(ref), load);
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    try {
      this.watch(uri);
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

  watch(uri: vscode.Uri): void {
    let parsed: { side: SideRef; partial?: PartialRef };
    try {
      parsed = fromUri(uri);
    } catch {
      return;
    }
    const { side, partial } = parsed;
    const live =
      isLiveUriSide(side.side) || (partial !== undefined && (isLiveUriSide(partial.left) || isLiveUriSide(partial.right)));
    if (!live) return;
    this.liveUris.set(uri.toString(), uri);
    if (worktreeLive(side.side) || (partial && (worktreeLive(partial.left) || worktreeLive(partial.right)))) {
      this.ensureFileWatch(side.root, side.path);
    }
    if (gitLive(side.side) || (partial && (gitLive(partial.left) || gitLive(partial.right)))) {
      this.ensureGitWatch(side.root);
    }
  }

  unwatch(uri: vscode.Uri): void {
    this.liveUris.delete(uri.toString());
    this.pruneWatchers();
  }

  dispose(): void {
    this._onDidChange.dispose();
    for (const w of this.fileWatchers.values()) w.dispose();
    for (const w of this.gitWatchers.values()) w.dispose();
    this.fileWatchers.clear();
    this.gitWatchers.clear();
    this.liveUris.clear();
  }

  private ensureFileWatch(root: string, relPath: string): void {
    const key = fileWatchKey(root, relPath);
    if (this.fileWatchers.has(key)) return;
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, relPath));
    const fire = () => this.refreshWorktree(root, relPath);
    watcher.onDidChange(fire);
    watcher.onDidCreate(fire);
    watcher.onDidDelete(fire);
    this.fileWatchers.set(key, watcher);
  }

  private ensureGitWatch(root: string): void {
    if (this.gitWatchers.has(root)) return;
    const pending: vscode.Disposable = { dispose() {} };
    this.gitWatchers.set(root, pending);
    void watchRepoState(root, () => this.refreshGit(root)).then(
      (d) => {
        if (!this.gitWatchers.has(root)) {
          d?.dispose();
          return;
        }
        this.gitWatchers.set(root, d ?? this.watchGitDotFiles(root));
      },
      () => {
        if (!this.gitWatchers.has(root)) return;
        this.gitWatchers.set(root, this.watchGitDotFiles(root));
      },
    );
  }

  /** Fallback when the Git extension has not opened this folder. */
  private watchGitDotFiles(root: string): vscode.Disposable {
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(path.join(root, '.git'), '{HEAD,index,refs/stash,logs/refs/stash}'),
    );
    const fire = () => this.refreshGit(root);
    watcher.onDidChange(fire);
    watcher.onDidCreate(fire);
    watcher.onDidDelete(fire);
    return watcher;
  }

  private refreshWorktree(root: string, relPath: string): void {
    for (const uri of this.liveUris.values()) {
      try {
        const { side, partial } = fromUri(uri);
        if (side.root !== root || side.path !== relPath) continue;
        if (worktreeLive(side.side) || (partial && (worktreeLive(partial.left) || worktreeLive(partial.right)))) {
          this._onDidChange.fire(uri);
        }
      } catch {
        /* ignore a URI that no longer parses */
      }
    }
  }

  private refreshGit(root: string): void {
    for (const uri of this.liveUris.values()) {
      try {
        const { side, partial } = fromUri(uri);
        if (side.root !== root) continue;
        if (gitLive(side.side) || (partial && (gitLive(partial.left) || gitLive(partial.right)))) {
          this._onDidChange.fire(uri);
        }
      } catch {
        /* ignore */
      }
    }
  }

  private pruneWatchers(): void {
    const neededFiles = new Set<string>();
    const neededRoots = new Set<string>();
    for (const uri of this.liveUris.values()) {
      try {
        const { side, partial } = fromUri(uri);
        if (worktreeLive(side.side) || (partial && (worktreeLive(partial.left) || worktreeLive(partial.right)))) {
          neededFiles.add(fileWatchKey(side.root, side.path));
        }
        if (gitLive(side.side) || (partial && (gitLive(partial.left) || gitLive(partial.right)))) {
          neededRoots.add(side.root);
        }
      } catch {
        /* ignore */
      }
    }
    for (const [key, w] of this.fileWatchers) {
      if (!neededFiles.has(key)) {
        w.dispose();
        this.fileWatchers.delete(key);
      }
    }
    for (const [root, w] of this.gitWatchers) {
      if (!neededRoots.has(root)) {
        w.dispose();
        this.gitWatchers.delete(root);
      }
    }
  }
}
