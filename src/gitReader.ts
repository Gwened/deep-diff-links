/**
 * Thin wrapper around the git CLI. No VS Code imports.
 *
 * - Always `execFile` with an argument array; never a shell or a command string.
 * - Read-only plumbing commands only (`cat-file`, `rev-parse`), plus `diff`.
 * - 10 s timeout per call, bounded output.
 * - Worktree conversion uses `hash-object -w` with `GIT_OBJECT_DIRECTORY` pointing
 *   outside the clone, so the user's object database is never written.
 */
import { execFile } from 'child_process';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';

export const GIT_TIMEOUT_MS = 10_000;
const SMALL_OUTPUT = 1024 * 1024;

export interface ExecOptions {
  cwd: string;
  timeout: number;
  maxBuffer: number;
  input?: string | Buffer;
  extraEnv?: NodeJS.ProcessEnv;
}

export interface ExecOutput {
  stdout: Buffer;
  stderr: string;
}

/** Error shape produced by `child_process.execFile`, plus captured output. */
export interface ExecFailure extends Error {
  code?: number | string;
  killed?: boolean;
  signal?: NodeJS.Signals | null;
  stderr?: string;
  stdout?: Buffer;
}

export type Exec = (file: string, args: string[], options: ExecOptions) => Promise<ExecOutput>;

export const defaultExec: Exec = (file, args, options) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      {
        cwd: options.cwd,
        timeout: options.timeout,
        maxBuffer: options.maxBuffer,
        encoding: 'buffer',
        windowsHide: true,
        shell: false,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', ...options.extraEnv },
      },
      (error, stdout, stderr) => {
        const stderrText = stderr ? stderr.toString('utf8') : '';
        if (error) {
          reject(Object.assign(error, { stderr: stderrText, stdout }));
        } else {
          resolve({ stdout, stderr: stderrText });
        }
      },
    );
    child.stdin?.end(options.input ?? '');
  });

export type GitErrorKind = 'timeout' | 'exit' | 'spawn' | 'output-too-large';

export class GitError extends Error {
  constructor(
    readonly kind: GitErrorKind,
    readonly args: string[],
    readonly stderr: string,
    readonly exitCode?: number,
    readonly stdout?: Buffer,
  ) {
    super(`git ${args.join(' ')} failed (${kind}${exitCode !== undefined ? ` ${exitCode}` : ''}): ${stderr.trim()}`);
    this.name = 'GitError';
  }
}

export function mapExecFailure(args: string[], error: ExecFailure): GitError {
  const stderr = error.stderr ?? '';
  if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return new GitError('output-too-large', args, stderr);
  if (error.killed || error.signal === 'SIGTERM') return new GitError('timeout', args, stderr);
  if (typeof error.code === 'number') return new GitError('exit', args, stderr, error.code, error.stdout);
  return new GitError('spawn', args, stderr || error.message);
}

/** Result of `git cat-file --batch-check` for one object name. */
export type BatchCheckResult =
  | { status: 'found'; oid: string; type: string; size: number }
  | { status: 'missing' }
  | { status: 'ambiguous' };

// ---- argument builders (pure, unit-tested) ----

export const batchCheckArgs = (): string[] => ['cat-file', '--batch-check'];
export const readBlobArgs = (oid: string): string[] => ['cat-file', 'blob', oid];
export const showToplevelArgs = (): string[] => ['rev-parse', '--show-toplevel'];
/** [v1.1] Change blocks between two blobs, no context lines, no external drivers. */
const DIFF_FLAGS = ['--no-color', '--no-ext-diff', '--no-textconv', '--text', '--diff-algorithm=myers', '-U0'] as const;

export const diffBlobsArgs = (oldOid: string, newOid: string): string[] => ['diff', ...DIFF_FLAGS, oldOid, newOid];
/** [v1.2] Change blocks between two files that are not objects in the user's database. */
export const diffNoIndexArgs = (leftFile: string, rightFile: string): string[] => [
  'diff',
  ...DIFF_FLAGS,
  '--no-index',
  '--',
  leftFile,
  rightFile,
];
export const revParseVerifyArgs = (spec: string): string[] => ['rev-parse', '--verify', '--end-of-options', spec];
/** NUL-separated paths that differ. Callers append the side tokens after `--end-of-options`. */
export const NAME_ONLY_FLAGS = ['diff', '--name-only', '-z'] as const;
export const untrackedArgs = (): string[] => ['ls-files', '-z', '--others', '--exclude-standard'];

export function parseNulPaths(stdout: Buffer): string[] {
  if (stdout.length === 0) return [];
  return stdout
    .toString('utf8')
    .split('\0')
    .filter((p) => p.length > 0);
}
export const hashObjectArgs = (relPath: string): string[] => ['hash-object', '-w', `--path=${relPath}`, '--stdin'];
/** Object name for "this SHA, peeled to a commit". */
export const commitSpec = (sha: string): string => `${sha}^{commit}`;
export const headCommitSpec = (): string => 'HEAD^{commit}';
export const stashCommitSpec = (n: number): string => `stash@{${n}}^{commit}`;

function assertRelPath(relPath: string): void {
  if (relPath.startsWith('/') || relPath.split('/').includes('..')) {
    throw new Error('pathSpec requires a validated repo-relative path');
  }
}

/** Object name for "this path in this commit". `path` must already be validated as repo-relative. */
export const pathSpec = (sha: string, relPath: string): string => {
  assertRelPath(relPath);
  return `${sha}:${relPath}`;
};
export const indexPathSpec = (relPath: string): string => {
  assertRelPath(relPath);
  return `:0:${relPath}`;
};
export const stashPathSpec = (n: number, relPath: string): string => pathSpec(`stash@{${n}}`, relPath);
export const stashUntrackedPathSpec = (n: number, relPath: string): string => {
  assertRelPath(relPath);
  return `stash@{${n}}^3:${relPath}`;
};

export function parseBatchCheck(output: string, count: number): BatchCheckResult[] {
  const lines = output.split('\n').filter((l) => l.length > 0);
  if (lines.length !== count) {
    throw new Error(`git cat-file --batch-check returned ${lines.length} lines, expected ${count}`);
  }
  return lines.map((line): BatchCheckResult => {
    if (line.endsWith(' missing')) return { status: 'missing' };
    if (line.endsWith(' ambiguous')) return { status: 'ambiguous' };
    const m = /^([0-9a-f]{40,64}) (\S+) (\d+)$/.exec(line);
    if (!m) throw new Error(`Unexpected git cat-file --batch-check line: ${line}`);
    return { status: 'found', oid: m[1], type: m[2], size: Number(m[3]) };
  });
}

export class GitReader {
  constructor(
    private readonly gitPath: string = 'git',
    private readonly exec: Exec = defaultExec,
    private readonly timeoutMs: number = GIT_TIMEOUT_MS,
  ) {}

  private async run(
    cwd: string,
    args: string[],
    maxBuffer: number,
    input?: string | Buffer,
    extraEnv?: NodeJS.ProcessEnv,
  ): Promise<ExecOutput> {
    try {
      return await this.exec(this.gitPath, args, { cwd, timeout: this.timeoutMs, maxBuffer, input, extraEnv });
    } catch (error) {
      throw mapExecFailure(args, error as ExecFailure);
    }
  }

  /** `git diff` exits 1 when the sides differ (`--no-index` always; blob diffs on some git versions). */
  private async runDiff(cwd: string, args: string[], maxBuffer: number): Promise<ExecOutput> {
    try {
      return await this.run(cwd, args, maxBuffer);
    } catch (error) {
      if (error instanceof GitError && error.kind === 'exit' && error.exitCode === 1) {
        return { stdout: error.stdout ?? Buffer.alloc(0), stderr: error.stderr };
      }
      throw error;
    }
  }

  /** Looks up several object names in one call. Names must not contain newlines. */
  async batchCheck(root: string, names: string[]): Promise<BatchCheckResult[]> {
    for (const n of names) {
      if (/[\r\n]/.test(n)) throw new Error('object name contains a newline');
    }
    const { stdout } = await this.run(root, batchCheckArgs(), SMALL_OUTPUT, names.map((n) => `${n}\n`).join(''));
    return parseBatchCheck(stdout.toString('utf8'), names.length);
  }

  /** Reads a blob's raw bytes (no textconv, no filters). */
  async readBlob(root: string, oid: string, maxBytes: number): Promise<Buffer> {
    const { stdout } = await this.run(root, readBlobArgs(oid), maxBytes + 1);
    return stdout;
  }

  /** [v1.1] `git diff -U0` between two blob OIDs. */
  async diffBlobs(root: string, oldOid: string, newOid: string, maxBytes: number): Promise<string> {
    const { stdout } = await this.runDiff(root, diffBlobsArgs(oldOid, newOid), 2 * maxBytes + SMALL_OUTPUT);
    return stdout.toString('utf8');
  }

  /** [v1.2] `git diff --no-index -U0` via temp files outside the clone. */
  async diffNoIndex(leftText: string, rightText: string, maxBytes: number): Promise<string> {
    const tmp = await mkdtemp(path.join(tmpdir(), 'ddl-diff-'));
    const leftFile = path.join(tmp, 'L');
    const rightFile = path.join(tmp, 'R');
    try {
      await writeFile(leftFile, leftText);
      await writeFile(rightFile, rightText);
      const { stdout } = await this.runDiff(tmp, diffNoIndexArgs(leftFile, rightFile), 2 * maxBytes + SMALL_OUTPUT);
      return stdout.toString('utf8');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }

  /**
   * Apply git's worktree→index conversion (clean filters / CRLF) without writing
   * the user's object database. Objects go to a temp `GIT_OBJECT_DIRECTORY`.
   */
  async cleanWorktree(root: string, relPath: string, raw: Buffer, maxBytes: number): Promise<Buffer> {
    assertRelPath(relPath);
    const tmp = await mkdtemp(path.join(tmpdir(), 'ddl-obj-'));
    const extraEnv = { GIT_OBJECT_DIRECTORY: tmp };
    try {
      const hashed = await this.run(root, hashObjectArgs(relPath), SMALL_OUTPUT, raw, extraEnv);
      const oid = hashed.stdout.toString('utf8').trim();
      const { stdout } = await this.run(root, readBlobArgs(oid), maxBytes + 1, undefined, extraEnv);
      return stdout;
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }

  /** `git rev-parse --verify --end-of-options <spec>`. Missing ref → `undefined`. */
  async revParseVerify(root: string, spec: string): Promise<string | undefined> {
    try {
      const { stdout } = await this.run(root, revParseVerifyArgs(spec), SMALL_OUTPUT);
      const sha = stdout.toString('utf8').trim();
      return sha.length > 0 ? sha : undefined;
    } catch (error) {
      if (error instanceof GitError && error.kind === 'exit') return undefined;
      throw error;
    }
  }

  async showToplevel(cwd: string): Promise<string> {
    const { stdout } = await this.run(cwd, showToplevelArgs(), SMALL_OUTPUT);
    return stdout.toString('utf8').trim();
  }

  /** `git diff --name-only -z …`. Exit 1 (sides differ) is success. */
  async nameOnly(root: string, args: string[]): Promise<string[]> {
    const { stdout } = await this.runDiff(root, args, SMALL_OUTPUT);
    return parseNulPaths(stdout);
  }

  /** Untracked, not ignored, repo-relative paths. */
  async listUntracked(root: string): Promise<string[]> {
    const { stdout } = await this.run(root, untrackedArgs(), SMALL_OUTPUT);
    return parseNulPaths(stdout);
  }
}
