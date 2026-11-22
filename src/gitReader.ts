/**
 * Thin wrapper around the git CLI. No VS Code imports.
 *
 * - Always `execFile` with an argument array; never a shell or a command string.
 * - Read-only plumbing commands only (`cat-file`, `rev-parse`).
 * - 10 s timeout per call, bounded output.
 */
import { execFile } from 'child_process';

export const GIT_TIMEOUT_MS = 10_000;
const SMALL_OUTPUT = 1024 * 1024;

export interface ExecOptions {
  cwd: string;
  timeout: number;
  maxBuffer: number;
  input?: string;
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
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
      },
      (error, stdout, stderr) => {
        const stderrText = stderr ? stderr.toString('utf8') : '';
        if (error) {
          reject(Object.assign(error, { stderr: stderrText }));
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
  ) {
    super(`git ${args.join(' ')} failed (${kind}${exitCode !== undefined ? ` ${exitCode}` : ''}): ${stderr.trim()}`);
    this.name = 'GitError';
  }
}

export function mapExecFailure(args: string[], error: ExecFailure): GitError {
  const stderr = error.stderr ?? '';
  if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return new GitError('output-too-large', args, stderr);
  if (error.killed || error.signal === 'SIGTERM') return new GitError('timeout', args, stderr);
  if (typeof error.code === 'number') return new GitError('exit', args, stderr, error.code);
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
export const diffBlobsArgs = (oldOid: string, newOid: string): string[] => [
  'diff',
  '--no-color',
  '--no-ext-diff',
  '--no-textconv',
  '--text',
  '--diff-algorithm=myers',
  '-U0',
  oldOid,
  newOid,
];
/** Object name for "this SHA, peeled to a commit". */
export const commitSpec = (sha: string): string => `${sha}^{commit}`;
/** Object name for "this path in this commit". `path` must already be validated as repo-relative. */
export const pathSpec = (sha: string, path: string): string => {
  if (path.startsWith('/') || path.split('/').includes('..')) {
    throw new Error('pathSpec requires a validated repo-relative path');
  }
  return `${sha}:${path}`;
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

  private async run(cwd: string, args: string[], maxBuffer: number, input?: string): Promise<ExecOutput> {
    try {
      return await this.exec(this.gitPath, args, { cwd, timeout: this.timeoutMs, maxBuffer, input });
    } catch (error) {
      throw mapExecFailure(args, error as ExecFailure);
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
    const { stdout } = await this.run(root, diffBlobsArgs(oldOid, newOid), 2 * maxBytes + SMALL_OUTPUT);
    return stdout.toString('utf8');
  }

  async showToplevel(cwd: string): Promise<string> {
    const { stdout } = await this.run(cwd, showToplevelArgs(), SMALL_OUTPUT);
    return stdout.toString('utf8').trim();
  }
}
