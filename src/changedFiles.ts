/**
 * Lists repo-relative paths that differ between two sides. No VS Code imports.
 */
import { GitReader, NAME_ONLY_FLAGS } from './gitReader';
import { SideToken, fromUriSide, validatePath } from './validator';

/** A git `diff` endpoint: a tree-ish, the index, or the worktree. */
export type DiffEnd = { kind: 'tree'; spec: string } | { kind: 'staged' } | { kind: 'worktree' };

export function endOf(token: SideToken): DiffEnd {
  switch (token.kind) {
    case 'sha':
      return { kind: 'tree', spec: token.value };
    case 'HEAD':
      return { kind: 'tree', spec: 'HEAD' };
    case 'stash':
      return { kind: 'tree', spec: `stash@{${token.n}}` };
    case 'staged':
    case 'worktree':
      return { kind: token.kind };
  }
}

/**
 * Argument array for `git diff --name-only -z` between two ends.
 * `undefined` means the pair cannot differ (same live side, or identical tree-ish).
 */
export function nameOnlyArgs(left: DiffEnd, right: DiffEnd): string[] | undefined {
  if (left.kind === 'tree' && right.kind === 'tree') {
    if (left.spec === right.spec) return undefined;
    return [...NAME_ONLY_FLAGS, '--end-of-options', left.spec, right.spec];
  }
  if (left.kind === 'tree' && right.kind === 'staged') {
    return [...NAME_ONLY_FLAGS, '--cached', '--end-of-options', left.spec];
  }
  if (left.kind === 'staged' && right.kind === 'tree') {
    return [...NAME_ONLY_FLAGS, '--cached', '--end-of-options', right.spec];
  }
  if (
    (left.kind === 'staged' && right.kind === 'worktree') ||
    (left.kind === 'worktree' && right.kind === 'staged')
  ) {
    return [...NAME_ONLY_FLAGS];
  }
  if (left.kind === 'tree' && right.kind === 'worktree') {
    return [...NAME_ONLY_FLAGS, '--end-of-options', left.spec];
  }
  if (left.kind === 'worktree' && right.kind === 'tree') {
    return [...NAME_ONLY_FLAGS, '--end-of-options', right.spec];
  }
  return undefined;
}

function sameSide(left: SideToken, right: SideToken): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'sha' && right.kind === 'sha') return left.value === right.value;
  if (left.kind === 'stash' && right.kind === 'stash') return left.n === right.n;
  return true;
}

function collect(paths: Set<string>, names: string[]): void {
  for (const name of names) {
    if (validatePath(name) === undefined) paths.add(name);
  }
}

async function addDiff(reader: GitReader, root: string, paths: Set<string>, left: DiffEnd, right: DiffEnd): Promise<void> {
  const args = nameOnlyArgs(left, right);
  if (!args) return;
  collect(paths, await reader.nameOnly(root, args));
}

/**
 * Paths that differ between two `deep-diff://` authorities (sha40 or live token).
 * Includes untracked files when a side is `worktree`, and `stash@{n}^3` (U22).
 */
export async function listChangedFiles(reader: GitReader, root: string, leftId: string, rightId: string): Promise<string[]> {
  const left = fromUriSide(leftId);
  const right = fromUriSide(rightId);
  if (!left || !right) throw new Error(`Not a deep-diff side: ${leftId} / ${rightId}`);
  if (sameSide(left, right)) return [];

  const paths = new Set<string>();
  const leftEnd = endOf(left);
  const rightEnd = endOf(right);
  await addDiff(reader, root, paths, leftEnd, rightEnd);

  if (left.kind === 'worktree' || right.kind === 'worktree') {
    collect(paths, await reader.listUntracked(root));
  }

  for (const side of [left, right]) {
    if (side.kind !== 'stash') continue;
    const spec = `stash@{${side.n}}^3`;
    if (!(await reader.revParseVerify(root, spec))) continue;
    const extra: DiffEnd = { kind: 'tree', spec };
    const other = side === left ? rightEnd : leftEnd;
    await addDiff(reader, root, paths, extra, other);
  }

  return [...paths].sort();
}
