/**
 * Resolves commits and reads one file at one side (commit or live token). No VS Code imports.
 */
import { promises as fs } from 'fs';
import * as path from 'path';
import { LinkError, SideReadError, messages } from './errors';
import {
  BatchCheckResult,
  GitReader,
  commitSpec,
  headCommitSpec,
  indexPathSpec,
  pathSpec,
  stashCommitSpec,
  stashPathSpec,
  stashUntrackedPathSpec,
} from './gitReader';
import { SHA40_RE, fromUriSide } from './validator';

export const BINARY_TEXT = 'Binary file, cannot display.';
export const SUBMODULE_TEXT = 'Submodule, cannot display.';
export const DIRECTORY_TEXT = 'Directory, cannot display.';
const BINARY_SNIFF_BYTES = 8 * 1024;

export function isBinary(content: Buffer): boolean {
  return content.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}

export type CommitLookup =
  | { status: 'found'; sha: string }
  | { status: 'missing' }
  | { status: 'ambiguous' };

/** Checks that each SHA names a commit in the clone and expands it to the full SHA. */
export async function resolveCommits(reader: GitReader, root: string, shas: string[]): Promise<CommitLookup[]> {
  const results = await reader.batchCheck(root, shas.map(commitSpec));
  return results.map((r): CommitLookup => {
    if (r.status !== 'found') return r;
    if (r.type !== 'commit') return { status: 'missing' };
    return { status: 'found', sha: r.oid };
  });
}

export type FileSide =
  | { kind: 'absent' }
  | { kind: 'text'; text: string; oid?: string }
  | { kind: 'binary' }
  | { kind: 'submodule' }
  | { kind: 'directory' }
  | { kind: 'tooLarge'; size: number };

/** Text the content provider shows for a side. */
export function sideText(side: FileSide): string {
  switch (side.kind) {
    case 'absent':
      return '';
    case 'text':
      return side.text;
    case 'binary':
      return BINARY_TEXT;
    case 'submodule':
      return SUBMODULE_TEXT;
    case 'directory':
      return DIRECTORY_TEXT;
    case 'tooLarge':
      return `File is ${side.size} bytes, above deepDiffLinks.maxFileBytes. Not displayed.`;
  }
}

function classify(entry: BatchCheckResult): FileSide | { kind: 'blob'; oid: string; size: number } {
  if (entry.status !== 'found') return { kind: 'absent' };
  switch (entry.type) {
    case 'blob':
      return { kind: 'blob', oid: entry.oid, size: entry.size };
    case 'commit':
      return { kind: 'submodule' };
    case 'tree':
      return { kind: 'directory' };
    default:
      return { kind: 'absent' };
  }
}

export type PartialSides =
  | { kind: 'modified'; leftText: string; rightText: string; leftOid?: string; rightOid?: string }
  | { kind: 'added'; rightText: string }
  | { kind: 'deleted'; leftText: string }
  | { kind: 'unsupported' };

/** [v1.1] Whether ranges can apply to these sides (§7.2: ignored for binary, submodule, directory). */
export function partialSides(left: FileSide, right: FileSide): PartialSides {
  if (left.kind === 'text' && right.kind === 'text') {
    return { kind: 'modified', leftText: left.text, rightText: right.text, leftOid: left.oid, rightOid: right.oid };
  }
  if (left.kind === 'absent' && right.kind === 'text') return { kind: 'added', rightText: right.text };
  if (left.kind === 'text' && right.kind === 'absent') return { kind: 'deleted', leftText: left.text };
  return { kind: 'unsupported' };
}

function isInsideRoot(rootReal: string, fileReal: string): boolean {
  const rel = path.relative(rootReal, fileReal);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

async function blobToSide(reader: GitReader, root: string, c: Exclude<ReturnType<typeof classify>, FileSide>, maxBytes: number): Promise<FileSide> {
  if (c.size > maxBytes) return { kind: 'tooLarge', size: c.size };
  const content = await reader.readBlob(root, c.oid, maxBytes);
  if (isBinary(content)) return { kind: 'binary' };
  return { kind: 'text', text: content.toString('utf8'), oid: c.oid };
}

async function readNamedBlob(
  reader: GitReader,
  root: string,
  name: string,
  maxBytes: number,
): Promise<FileSide> {
  const [entry] = await reader.batchCheck(root, [name]);
  const c = classify(entry);
  if (c.kind !== 'blob') return c;
  return blobToSide(reader, root, c, maxBytes);
}

/** Reads `path` at full commit `sha`. Never touches the working tree or index. */
export async function readFileAtCommit(
  reader: GitReader,
  root: string,
  sha: string,
  relPath: string,
  maxBytes: number,
): Promise<FileSide> {
  return readNamedBlob(reader, root, pathSpec(sha, relPath), maxBytes);
}

export async function readIndexPath(
  reader: GitReader,
  root: string,
  relPath: string,
  maxBytes: number,
): Promise<FileSide> {
  return readNamedBlob(reader, root, indexPathSpec(relPath), maxBytes);
}

export async function readStashPath(
  reader: GitReader,
  root: string,
  n: number,
  relPath: string,
  maxBytes: number,
  repoName: string,
): Promise<FileSide> {
  const sha = await reader.revParseVerify(root, stashCommitSpec(n));
  if (!sha) throw new SideReadError('U18', messages.stashNotFound(`stash@{${n}}`, repoName));
  const names = [stashPathSpec(n, relPath), stashUntrackedPathSpec(n, relPath)];
  const [wip, untracked] = await reader.batchCheck(root, names);
  const primary = classify(wip);
  if (primary.kind === 'blob') return blobToSide(reader, root, primary, maxBytes);
  if (primary.kind !== 'absent') return primary;
  const extra = classify(untracked);
  if (extra.kind === 'blob') return blobToSide(reader, root, extra, maxBytes);
  return extra;
}

export async function readWorktreePath(
  reader: GitReader,
  root: string,
  relPath: string,
  maxBytes: number,
): Promise<FileSide> {
  let rootReal: string;
  try {
    rootReal = await fs.realpath(root);
  } catch (error) {
    throw new LinkError('E2', messages.gitFailed('worktree', relPath), error);
  }
  const abs = path.resolve(rootReal, ...relPath.split('/'));
  let fileReal: string;
  try {
    fileReal = await fs.realpath(abs);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { kind: 'absent' };
    throw error;
  }
  if (!isInsideRoot(rootReal, fileReal)) {
    throw new SideReadError('E1', messages.invalid('path', messages.pathEscapesRepo()));
  }
  const st = await fs.stat(fileReal);
  if (st.isDirectory()) {
    try {
      await fs.stat(path.join(fileReal, '.git'));
      return { kind: 'submodule' };
    } catch {
      return { kind: 'directory' };
    }
  }
  if (st.size > maxBytes) return { kind: 'tooLarge', size: st.size };
  const raw = await fs.readFile(fileReal);
  if (raw.length > maxBytes) return { kind: 'tooLarge', size: raw.length };
  const converted = await reader.cleanWorktree(root, relPath, raw, maxBytes);
  if (isBinary(converted)) return { kind: 'binary' };
  return { kind: 'text', text: converted.toString('utf8') };
}

function repoNameFromRoot(root: string): string {
  return path.basename(root);
}

/** Reads `path` for a `deep-diff://` authority (`sha40` or live token). */
export async function readFileAtSide(
  reader: GitReader,
  root: string,
  side: string,
  relPath: string,
  maxBytes: number,
): Promise<FileSide> {
  if (SHA40_RE.test(side)) return readFileAtCommit(reader, root, side, relPath, maxBytes);
  const token = fromUriSide(side);
  if (!token) throw new Error(`Not a deep-diff side: ${side}`);
  switch (token.kind) {
    case 'sha':
      return readFileAtCommit(reader, root, token.value, relPath, maxBytes);
    case 'HEAD': {
      const sha = await reader.revParseVerify(root, headCommitSpec());
      if (!sha) throw new SideReadError('U19', messages.headNotFound(repoNameFromRoot(root)));
      return readFileAtCommit(reader, root, sha, relPath, maxBytes);
    }
    case 'staged':
      return readIndexPath(reader, root, relPath, maxBytes);
    case 'worktree':
      return readWorktreePath(reader, root, relPath, maxBytes);
    case 'stash':
      return readStashPath(reader, root, token.n, relPath, maxBytes, repoNameFromRoot(root));
  }
}
