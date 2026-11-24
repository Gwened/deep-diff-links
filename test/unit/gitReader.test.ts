import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  Exec,
  ExecFailure,
  GIT_TIMEOUT_MS,
  GitError,
  GitReader,
  batchCheckArgs,
  commitSpec,
  defaultExec,
  diffBlobsArgs,
  diffNoIndexArgs,
  hashObjectArgs,
  headCommitSpec,
  indexPathSpec,
  mapExecFailure,
  parseBatchCheck,
  pathSpec,
  readBlobArgs,
  revParseVerifyArgs,
  stashCommitSpec,
  stashPathSpec,
  stashUntrackedPathSpec,
} from '../../src/gitReader';
import { BINARY_TEXT, isBinary, readFileAtCommit, readFileAtSide, resolveCommits, sideText } from '../../src/fileAtCommit';
import { SideReadError } from '../../src/errors';
import {
  ADDED,
  BLOCKS_V2,
  DELETED,
  DIRTY_HOOKS,
  Fixture,
  HOOKS_V1,
  HOOKS_V2,
  STAGED_ADDED,
  STASHED_BLOCKS,
  STASH_UNTRACKED,
  WORKTREE_ADDED,
  applyLiveWorkspace,
  createFixtureRepo,
} from '../fixtureRepo';
import { parseZeroContextDiff, planModified } from '../../src/hunkSelector';

const failure = (props: Partial<ExecFailure>): ExecFailure => Object.assign(new Error('boom'), props);

describe('GitReader arguments', () => {
  it('builds argument arrays, never strings', () => {
    assert.deepStrictEqual(batchCheckArgs(), ['cat-file', '--batch-check']);
    assert.deepStrictEqual(readBlobArgs('ab'.repeat(20)), ['cat-file', 'blob', 'ab'.repeat(20)]);
    assert.deepStrictEqual(diffBlobsArgs('a', 'b'), ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--text', '--diff-algorithm=myers', '-U0', 'a', 'b']);
    assert.deepStrictEqual(diffNoIndexArgs('/tmp/L', '/tmp/R'), [
      'diff',
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',
      '--text',
      '--diff-algorithm=myers',
      '-U0',
      '--no-index',
      '--',
      '/tmp/L',
      '/tmp/R',
    ]);
    assert.deepStrictEqual(revParseVerifyArgs('HEAD^{commit}'), ['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}']);
    assert.deepStrictEqual(hashObjectArgs('a/b.ts'), ['hash-object', '-w', '--path=a/b.ts', '--stdin']);
    assert.strictEqual(commitSpec('abcdef0'), 'abcdef0^{commit}');
    assert.strictEqual(headCommitSpec(), 'HEAD^{commit}');
    assert.strictEqual(stashCommitSpec(0), 'stash@{0}^{commit}');
    assert.strictEqual(pathSpec('abcdef0', 'a/b.ts'), 'abcdef0:a/b.ts');
    assert.strictEqual(indexPathSpec('a/b.ts'), ':0:a/b.ts');
    assert.strictEqual(stashPathSpec(1, 'a.ts'), 'stash@{1}:a.ts');
    assert.strictEqual(stashUntrackedPathSpec(1, 'a.ts'), 'stash@{1}^3:a.ts');
  });

  it('pathSpec refuses traversal even if the validator was bypassed', () => {
    assert.throws(() => pathSpec('abcdef0', '../x'));
    assert.throws(() => pathSpec('abcdef0', '/etc/passwd'));
    assert.throws(() => indexPathSpec('../x'));
    assert.throws(() => stashUntrackedPathSpec(0, '/etc/passwd'));
  });

  it('passes cwd, timeout, stdin and args to exec', async () => {
    const calls: Array<{ file: string; args: string[]; opts: Parameters<Exec>[2] }> = [];
    const exec: Exec = async (file, args, opts) => {
      calls.push({ file, args, opts });
      return { stdout: Buffer.from(`${'a'.repeat(40)} commit 10\n`), stderr: '' };
    };
    const reader = new GitReader('/usr/bin/git', exec);
    await reader.batchCheck('/repo', ['abcdef0^{commit}']);
    assert.strictEqual(calls[0].file, '/usr/bin/git');
    assert.deepStrictEqual(calls[0].args, ['cat-file', '--batch-check']);
    assert.strictEqual(calls[0].opts.cwd, '/repo');
    assert.strictEqual(calls[0].opts.timeout, GIT_TIMEOUT_MS);
    assert.strictEqual(calls[0].opts.input, 'abcdef0^{commit}\n');
  });

  it('rejects object names containing newlines', async () => {
    const reader = new GitReader('git', async () => ({ stdout: Buffer.alloc(0), stderr: '' }));
    await assert.rejects(reader.batchCheck('/r', ['a\nb']));
  });
});

describe('GitReader error mapping (E2)', () => {
  it('timeout', () => {
    const e = mapExecFailure(['x'], failure({ killed: true, signal: 'SIGTERM' }));
    assert.strictEqual(e.kind, 'timeout');
  });
  it('non-zero exit', () => {
    const e = mapExecFailure(['x'], failure({ code: 128, stderr: 'fatal: bad' }));
    assert.strictEqual(e.kind, 'exit');
    assert.strictEqual(e.exitCode, 128);
    assert.match(e.message, /fatal: bad/);
  });
  it('output too large', () => {
    assert.strictEqual(mapExecFailure(['x'], failure({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' })).kind, 'output-too-large');
  });
  it('git missing', () => {
    assert.strictEqual(mapExecFailure(['x'], failure({ code: 'ENOENT' })).kind, 'spawn');
  });
  it('reader surfaces GitError', async () => {
    const reader = new GitReader('git', async () => {
      throw failure({ code: 1, stderr: 'nope' });
    });
    await assert.rejects(reader.readBlob('/r', 'a'.repeat(40), 10), (e: unknown) => e instanceof GitError && e.kind === 'exit');
  });
  it('a real timeout is reported as timeout', async function () {
    if (process.platform === 'win32') this.skip();
    // Use /bin/sh as the "git" binary so the call hangs; GitReader must kill it and map to timeout.
    const hang: Exec = (file, _args, opts) => defaultExec(file, ['-c', 'sleep 5'], opts);
    const hanging = new GitReader('/bin/sh', hang, 100);
    await assert.rejects(hanging.readBlob(os.tmpdir(), 'a'.repeat(40), 10), (e: unknown) => e instanceof GitError && e.kind === 'timeout');
  });
});

describe('parseBatchCheck', () => {
  it('parses found, missing and ambiguous', () => {
    const out = `${'a'.repeat(40)} blob 12\nabc:x missing\nabc ambiguous\n`;
    assert.deepStrictEqual(parseBatchCheck(out, 3), [
      { status: 'found', oid: 'a'.repeat(40), type: 'blob', size: 12 },
      { status: 'missing' },
      { status: 'ambiguous' },
    ]);
  });
  it('rejects a short read', () => assert.throws(() => parseBatchCheck('', 1)));
});

describe('binary detection', () => {
  it('NUL in the first 8 KB is binary', () => assert.ok(isBinary(Buffer.from([1, 0, 2]))));
  it('plain text is not', () => assert.ok(!isBinary(Buffer.from('hello\nworld'))));
  it('NUL after 8 KB is not checked', () => {
    const b = Buffer.alloc(9000, 0x61);
    b[8500] = 0;
    assert.ok(!isBinary(b));
  });
  it('empty is text', () => assert.ok(!isBinary(Buffer.alloc(0))));
});

describe('reading a fixture repo', function () {
  this.timeout(20_000);
  let fx: Fixture;
  let tmp: string;
  const reader = new GitReader('git');
  const MAX = 10 * 1024 * 1024;

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cdl-unit-'));
    fx = createFixtureRepo(path.join(tmp, 'fixture'));
  });
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('resolves short SHAs to full SHAs', async () => {
    const r = await resolveCommits(reader, fx.root, [fx.c1.slice(0, 9), fx.c2]);
    assert.deepStrictEqual(r, [
      { status: 'found', sha: fx.c1 },
      { status: 'found', sha: fx.c2 },
    ]);
  });

  it('reports a missing commit', async () => {
    const [r] = await resolveCommits(reader, fx.root, ['deadbeefdeadbeef']);
    assert.deepStrictEqual(r, { status: 'missing' });
  });

  it('a blob SHA is not a commit', async () => {
    const [entry] = await reader.batchCheck(fx.root, [`${fx.c1}:hooks.ts`]);
    assert.ok(entry.status === 'found');
    const [r] = await resolveCommits(reader, fx.root, [entry.oid]);
    assert.deepStrictEqual(r, { status: 'missing' });
  });

  const textOf = async (sha: string, file: string) => {
    const side = await readFileAtCommit(reader, fx.root, sha, file, MAX);
    assert.strictEqual(side.kind, 'text');
    if (side.kind !== 'text' || side.oid === undefined) return assert.fail();
    return { text: side.text, oid: side.oid };
  };

  it('reads both versions of a modified file', async () => {
    assert.strictEqual((await textOf(fx.c1, 'hooks.ts')).text, HOOKS_V1);
    assert.strictEqual((await textOf(fx.c2, 'hooks.ts')).text, HOOKS_V2);
  });

  it('[v1.1] git diff -U0 between blobs reports each block', async () => {
    const a = await textOf(fx.c1, 'blocks.ts');
    const b = await textOf(fx.c2, 'blocks.ts');
    const hunks = parseZeroContextDiff(await reader.diffBlobs(fx.root, a.oid, b.oid, MAX));
    assert.deepStrictEqual(hunks, [
      { oldStart: 10, oldCount: 1, newStart: 10, newCount: 1 },
      { oldStart: 50, oldCount: 3, newStart: 50, newCount: 3 },
      { oldStart: 100, oldCount: 0, newStart: 101, newCount: 2 },
      { oldStart: 150, oldCount: 2, newStart: 151, newCount: 0 },
    ]);
    const plan = planModified(a.text, b.text, await reader.diffBlobs(fx.root, a.oid, b.oid, MAX), [[50, 52]]);
    assert.strictEqual(plan.selectedCount, 1);
    // Only lines 50-52 differ from the right side: they keep their old content.
    const expected = BLOCKS_V2.split('\n')
      .map((l) => l.replace(/^const b(5[0-2]) = 'changed';$/, 'const b$1 = $1;'))
      .join('\n');
    assert.strictEqual(plan.text, expected);
  });

  it('added file is absent on the left', async () => {
    assert.deepStrictEqual(await readFileAtCommit(reader, fx.root, fx.c1, 'added.txt', MAX), { kind: 'absent' });
    assert.strictEqual((await textOf(fx.c2, 'added.txt')).text, ADDED);
  });

  it('deleted file is absent on the right', async () => {
    assert.strictEqual((await textOf(fx.c1, 'deleted.txt')).text, DELETED);
    assert.deepStrictEqual(await readFileAtCommit(reader, fx.root, fx.c2, 'deleted.txt', MAX), { kind: 'absent' });
  });

  it('binary file', async () => {
    const side = await readFileAtCommit(reader, fx.root, fx.c2, 'binary.dat', MAX);
    assert.deepStrictEqual(side, { kind: 'binary' });
    assert.strictEqual(sideText(side), BINARY_TEXT);
  });

  it('directory', async () => {
    assert.deepStrictEqual(await readFileAtCommit(reader, fx.root, fx.c2, 'dir', MAX), { kind: 'directory' });
  });

  it('file above the size limit', async () => {
    assert.deepStrictEqual(await readFileAtCommit(reader, fx.root, fx.c2, 'big.txt', 100), { kind: 'tooLarge', size: 4097 });
  });

  it('nonexistent path', async () => {
    assert.deepStrictEqual(await readFileAtCommit(reader, fx.root, fx.c2, 'nope/none.ts', MAX), { kind: 'absent' });
  });
});

describe('[v1.2] live sides in a fixture repo', function () {
  this.timeout(20_000);
  let fx: Fixture;
  let tmp: string;
  const reader = new GitReader('git');
  const MAX = 10 * 1024 * 1024;
  const objects = (root: string) => {
    const dir = path.join(root, '.git', 'objects');
    const walk = (d: string): string[] =>
      fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(d, e.name);
        if (e.name === 'pack' || e.name === 'info') return [];
        return e.isDirectory() ? walk(p) : [p];
      });
    return walk(dir).sort();
  };

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cdl-live-'));
    fx = createFixtureRepo(path.join(tmp, 'fixture'));
    applyLiveWorkspace(fx.root);
  });
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('HEAD is the checked-out commit, not the dirty file', async () => {
    const side = await readFileAtSide(reader, fx.root, 'HEAD', 'hooks.ts', MAX);
    assert.strictEqual(side.kind, 'text');
    if (side.kind === 'text') assert.strictEqual(side.text, HOOKS_V2);
  });

  it('worktree is the file on disk after git clean conversion', async () => {
    const side = await readFileAtSide(reader, fx.root, 'worktree', 'hooks.ts', MAX);
    assert.strictEqual(side.kind, 'text');
    if (side.kind === 'text') {
      assert.strictEqual(side.text, DIRTY_HOOKS);
      assert.strictEqual(side.oid, undefined);
    }
  });

  it('staged is the index, not HEAD or worktree', async () => {
    const side = await readFileAtSide(reader, fx.root, 'staged', 'added.txt', MAX);
    assert.strictEqual(side.kind, 'text');
    if (side.kind === 'text') assert.strictEqual(side.text, STAGED_ADDED);
    const wt = await readFileAtSide(reader, fx.root, 'worktree', 'added.txt', MAX);
    assert.strictEqual(wt.kind, 'text');
    if (wt.kind === 'text') assert.strictEqual(wt.text, WORKTREE_ADDED);
  });

  it('stash@{0} is the WIP tree', async () => {
    const side = await readFileAtSide(reader, fx.root, 'stash.0', 'blocks.ts', MAX);
    assert.strictEqual(side.kind, 'text');
    if (side.kind === 'text') assert.strictEqual(side.text, STASHED_BLOCKS);
  });

  it('U22: untracked file from git stash -u is read from ^3', async () => {
    const side = await readFileAtSide(reader, fx.root, 'stash.0', 'untracked-in-stash.txt', MAX);
    assert.strictEqual(side.kind, 'text');
    if (side.kind === 'text') assert.strictEqual(side.text, STASH_UNTRACKED);
  });

  it('U18: missing stash', async () => {
    await assert.rejects(readFileAtSide(reader, fx.root, 'stash.99', 'hooks.ts', MAX), (e: unknown) => e instanceof SideReadError && e.code === 'U18');
  });

  it('untracked worktree file is present; missing elsewhere is absent', async () => {
    const wt = await readFileAtSide(reader, fx.root, 'worktree', 'untracked.txt', MAX);
    assert.strictEqual(wt.kind, 'text');
    assert.deepStrictEqual(await readFileAtSide(reader, fx.root, 'HEAD', 'untracked.txt', MAX), { kind: 'absent' });
    assert.deepStrictEqual(await readFileAtSide(reader, fx.root, 'staged', 'untracked.txt', MAX), { kind: 'absent' });
  });

  it('does not write to the user object database', async () => {
    const before = objects(fx.root);
    await readFileAtSide(reader, fx.root, 'worktree', 'hooks.ts', MAX);
    await reader.diffNoIndex('a\n', 'b\n', MAX);
    assert.deepStrictEqual(objects(fx.root), before);
  });

  it('diff --no-index reports a one-line change', async () => {
    const out = await reader.diffNoIndex('a\n', 'b\n', MAX);
    assert.match(out, /@@ -1 \+1 @@/);
  });

  it('symlink that escapes the repo is E1', async function () {
    if (process.platform === 'win32') this.skip();
    const outside = path.join(tmp, 'outside.txt');
    fs.writeFileSync(outside, 'secret\n');
    fs.symlinkSync(outside, path.join(fx.root, 'escape.txt'));
    await assert.rejects(readFileAtSide(reader, fx.root, 'worktree', 'escape.txt', MAX), (e: unknown) => e instanceof SideReadError && e.code === 'E1');
  });

  it('rev-parse --verify finds HEAD and not a fake stash', async () => {
    const head = await reader.revParseVerify(fx.root, 'HEAD^{commit}');
    assert.strictEqual(head, fx.c2);
    assert.strictEqual(await reader.revParseVerify(fx.root, 'stash@{99}^{commit}'), undefined);
  });
});
