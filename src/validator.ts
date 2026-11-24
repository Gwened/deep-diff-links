/**
 * Pure validation of link parameters (spec §5.1). No VS Code imports.
 * Inputs failing validation are rejected, never sanitized.
 */

export interface LinkParams {
  repo: string;
  left: string;
  right: string;
  path: string;
  line?: number;
  /** [v1.1] Sorted, merged, inclusive 1-based ranges from `lines`. */
  ranges?: LineRange[];
}

/** Inclusive, 1-based line range. */
export type LineRange = [start: number, end: number];

export const MAX_RANGES = 50;

export type ValidationResult =
  | { ok: true; params: LinkParams }
  | { ok: false; param: string; reason: string };

const SHA_RE = /^[0-9a-f]{7,40}$/;
export const SHA40_RE = /^[0-9a-f]{40}$/;
/** `stash` or `stash@{0}`–`stash@{99}` (no leading zeros except `{0}`). */
const STASH_RE = /^stash(?:@\{([0-9]|[1-9][0-9])\})?$/;
/** Authority of a `deep-diff://` URI: sha40 or live token (`stash.N`). */
/** `HEAD` is also accepted as `head`: vscode.Uri lowercases the authority like a hostname. */
export const URI_SIDE_RE = /^(?:[0-9a-f]{40}|HEAD|head|worktree|staged|stash\.(?:[0-9]|[1-9][0-9]))$/;
const LINE_RE = /^[1-9][0-9]{0,8}$/;
const RANGE_RE = /^([1-9][0-9]{0,8})(?:-([1-9][0-9]{0,8}))?$/;
const KNOWN = new Set(['repo', 'left', 'right', 'path', 'line', 'lines']);

export type SideToken =
  | { kind: 'sha'; value: string }
  | { kind: 'HEAD' }
  | { kind: 'worktree' }
  | { kind: 'staged' }
  | { kind: 'stash'; n: number };

export function parseSide(value: string): SideToken | undefined {
  if (SHA_RE.test(value)) return { kind: 'sha', value };
  if (value === 'HEAD' || value === 'worktree' || value === 'staged') return { kind: value };
  const m = STASH_RE.exec(value);
  if (m) return { kind: 'stash', n: m[1] === undefined ? 0 : Number(m[1]) };
  return undefined;
}

/** Identity used as `deep-diff://` authority and in partial query JSON. */
export function toUriSide(token: SideToken, sha40?: string): string {
  switch (token.kind) {
    case 'sha':
      if (!sha40 || !SHA40_RE.test(sha40)) throw new Error('toUriSide requires a resolved sha40');
      return sha40;
    case 'HEAD':
    case 'worktree':
    case 'staged':
      return token.kind;
    case 'stash':
      return `stash.${token.n}`;
  }
}

export function fromUriSide(authority: string): SideToken | undefined {
  if (SHA40_RE.test(authority)) return { kind: 'sha', value: authority };
  if (authority === 'HEAD' || authority === 'head') return { kind: 'HEAD' };
  if (authority === 'worktree' || authority === 'staged') return { kind: authority };
  const m = /^stash\.([0-9]|[1-9][0-9])$/.exec(authority);
  if (m) return { kind: 'stash', n: Number(m[1]) };
  return undefined;
}

export function isLiveUriSide(side: string): boolean {
  return !SHA40_RE.test(side);
}

/** Title / error label: 7-char SHA, `stash@{n}`, or the live keyword. */
export function formatSideLabel(side: string): string {
  if (SHA_RE.test(side)) return side.slice(0, 7);
  if (side === 'head') return 'HEAD';
  if (side === 'stash') return 'stash@{0}';
  const m = /^stash\.(\d+)$/.exec(side);
  if (m) return `stash@{${m[1]}}`;
  return side;
}

/**
 * Characters rejected in `repo` and `path` (AC3). The extension never uses a
 * shell, but links containing these are refused outright. Brackets, parentheses,
 * braces and spaces are allowed because real file names use them
 * (e.g. Next.js `[id].tsx`, `(group)/page.tsx`).
 */
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CHARS = /[\u0000-\u001f\u007f`$;|&<>"'\\*?!]/;

export function validateSha(value: string): string | undefined {
  return SHA_RE.test(value) ? undefined : 'must be a lowercase hex commit SHA of 7 to 40 characters';
}

export function validateSide(value: string): string | undefined {
  return parseSide(value)
    ? undefined
    : 'must be a lowercase hex commit SHA of 7 to 40 characters, or HEAD, worktree, staged, stash, or stash@{n}';
}

export function validatePath(value: string): string | undefined {
  if (value.length === 0) return 'is empty';
  if (value.length > 4096) return 'is too long';
  if (FORBIDDEN_CHARS.test(value)) return 'contains a forbidden character';
  if (value.startsWith('/')) return 'must be relative to the repository root';
  if (/^[A-Za-z]:\//.test(value)) return 'must be relative to the repository root';
  for (const segment of value.split('/')) {
    if (segment === '') return 'contains an empty segment';
    if (segment === '..' || segment === '.') return 'contains a `.` or `..` segment';
  }
  return undefined;
}

export function validateRepo(value: string): string | undefined {
  if (value.length === 0) return 'is empty';
  if (value.length > 255) return 'is too long';
  if (FORBIDDEN_CHARS.test(value)) return 'contains a forbidden character';
  if (value.includes('/')) return 'must be a folder name, not a path';
  if (value === '.' || value === '..') return 'must be a folder name';
  return undefined;
}

/** Sorts and merges overlapping or adjacent ranges. */
export function mergeRanges(ranges: LineRange[]): LineRange[] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: LineRange[] = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1] + 1) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

/** Parses `lines` (e.g. `25-30,120-160`) into merged ranges, or returns a rejection reason. */
export function parseLines(value: string): { ok: true; ranges: LineRange[] } | { ok: false; reason: string } {
  if (value === '') return { ok: false, reason: 'is empty' };
  const items = value.split(',');
  if (items.length > MAX_RANGES) return { ok: false, reason: `has more than ${MAX_RANGES} ranges` };
  const ranges: LineRange[] = [];
  for (const item of items) {
    const m = RANGE_RE.exec(item);
    if (!m) return { ok: false, reason: 'must be comma-separated line numbers or ranges like 25-30' };
    const start = Number(m[1]);
    const end = m[2] === undefined ? start : Number(m[2]);
    if (start > end) return { ok: false, reason: 'has a range whose start is after its end' };
    ranges.push([start, end]);
  }
  return { ok: true, ranges: mergeRanges(ranges) };
}

/** `[[25,30],[120,120]]` → `25-30, 120`. */
export function formatRanges(ranges: LineRange[], separator = ', '): string {
  return ranges.map(([s, e]) => (s === e ? `${s}` : `${s}-${e}`)).join(separator);
}

export function validateLine(value: string): string | undefined {
  return LINE_RE.test(value) ? undefined : 'must be a positive integer';
}

/**
 * Validates a decoded query map. `entries` must preserve duplicates so they can be rejected.
 * Unknown parameters are ignored (forward compatibility); duplicates of known ones are rejected.
 */
export function validateParams(entries: Array<[string, string]>): ValidationResult {
  const seen = new Map<string, string>();
  for (const [key, value] of entries) {
    if (!KNOWN.has(key)) continue;
    if (seen.has(key)) return { ok: false, param: key, reason: 'appears more than once' };
    seen.set(key, value);
  }

  for (const required of ['repo', 'left', 'right', 'path']) {
    if (!seen.has(required)) return { ok: false, param: required, reason: 'is missing' };
  }

  const repo = seen.get('repo')!;
  const left = seen.get('left')!;
  const right = seen.get('right')!;
  const path = seen.get('path')!;
  const line = seen.get('line');
  const lines = seen.get('lines');

  const checks: Array<[string, string | undefined]> = [
    ['repo', validateRepo(repo)],
    ['left', validateSide(left)],
    ['right', validateSide(right)],
    ['path', validatePath(path)],
    ['line', line === undefined ? undefined : validateLine(line)],
  ];
  for (const [param, reason] of checks) {
    if (reason) return { ok: false, param, reason };
  }

  let ranges: LineRange[] | undefined;
  if (lines !== undefined) {
    const parsed = parseLines(lines);
    if (!parsed.ok) return { ok: false, param: 'lines', reason: parsed.reason };
    ranges = parsed.ranges;
  }

  return {
    ok: true,
    params: {
      repo,
      left,
      right,
      path,
      line: line === undefined ? undefined : Number(line),
      ...(ranges ? { ranges } : {}),
    },
  };
}

/**
 * Splits an already percent-decoded query string (as exposed by `vscode.Uri.query`)
 * into key/value pairs. Values are not decoded again, so a literal `%` in a path
 * survives. Consequence: values cannot contain `&` (which `path` forbids anyway).
 */
export function parseQuery(decodedQuery: string): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  for (const part of decodedQuery.split('&')) {
    if (part === '') continue;
    const eq = part.indexOf('=');
    entries.push(eq === -1 ? [part, ''] : [part.slice(0, eq), part.slice(eq + 1)]);
  }
  return entries;
}
