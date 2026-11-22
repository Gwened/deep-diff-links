/**
 * Resolves commits and reads one file at one commit. No VS Code imports.
 */
import { BatchCheckResult, GitReader, commitSpec, pathSpec } from './gitReader';

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
  | { kind: 'text'; text: string; oid: string }
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

/** Reads `path` at full commit `sha`. Never touches the working tree or index. */
export async function readFileAtCommit(
  reader: GitReader,
  root: string,
  sha: string,
  path: string,
  maxBytes: number,
): Promise<FileSide> {
  const [entry] = await reader.batchCheck(root, [pathSpec(sha, path)]);
  const c = classify(entry);
  if (c.kind !== 'blob') return c;
  if (c.size > maxBytes) return { kind: 'tooLarge', size: c.size };
  const content = await reader.readBlob(root, c.oid, maxBytes);
  if (isBinary(content)) return { kind: 'binary' };
  return { kind: 'text', text: content.toString('utf8'), oid: c.oid };
}

export type PartialSides =
  | { kind: 'modified'; leftText: string; rightText: string; leftOid: string; rightOid: string }
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
