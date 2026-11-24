import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { endOf, listChangedFiles, nameOnlyArgs } from '../../src/changedFiles';
import { GitReader, parseNulPaths } from '../../src/gitReader';
import { applyLiveWorkspace, createFixtureRepo, Fixture } from '../fixtureRepo';
import { parseSide } from '../../src/validator';

const tree = (spec: string) => ({ kind: 'tree' as const, spec });

describe('nameOnlyArgs', () => {
  it('two commits', () => {
    assert.deepStrictEqual(nameOnlyArgs(tree('aaa'), tree('bbb')), [
      'diff',
      '--name-only',
      '-z',
      '--end-of-options',
      'aaa',
      'bbb',
    ]);
  });
  it('commit vs staged uses --cached', () => {
    assert.deepStrictEqual(nameOnlyArgs(tree('HEAD'), { kind: 'staged' }), [
      'diff',
      '--name-only',
      '-z',
      '--cached',
      '--end-of-options',
      'HEAD',
    ]);
  });
  it('staged vs worktree is a bare diff', () => {
    assert.deepStrictEqual(nameOnlyArgs({ kind: 'staged' }, { kind: 'worktree' }), ['diff', '--name-only', '-z']);
  });
  it('commit vs worktree', () => {
    assert.deepStrictEqual(nameOnlyArgs(tree('HEAD'), { kind: 'worktree' }), [
      'diff',
      '--name-only',
      '-z',
      '--end-of-options',
      'HEAD',
    ]);
  });
  it('identical live sides list nothing', () => {
    assert.strictEqual(nameOnlyArgs({ kind: 'worktree' }, { kind: 'worktree' }), undefined);
    assert.strictEqual(nameOnlyArgs({ kind: 'staged' }, { kind: 'staged' }), undefined);
    assert.strictEqual(nameOnlyArgs(tree('HEAD'), tree('HEAD')), undefined);
  });
  it('endOf maps tokens to git ends', () => {
    assert.deepStrictEqual(endOf(parseSide('abcdef0')!), tree('abcdef0'));
    assert.deepStrictEqual(endOf(parseSide('HEAD')!), tree('HEAD'));
    assert.deepStrictEqual(endOf(parseSide('stash@{2}')!), tree('stash@{2}'));
    assert.deepStrictEqual(endOf(parseSide('staged')!), { kind: 'staged' });
    assert.deepStrictEqual(endOf(parseSide('worktree')!), { kind: 'worktree' });
  });
});

describe('parseNulPaths', () => {
  it('splits on NUL and drops empties', () => {
    assert.deepStrictEqual(parseNulPaths(Buffer.from('a.ts\0b/c.ts\0')), ['a.ts', 'b/c.ts']);
    assert.deepStrictEqual(parseNulPaths(Buffer.alloc(0)), []);
  });
});

describe('listChangedFiles', function () {
  this.timeout(20_000);
  let fx: Fixture;
  let tmp: string;
  const reader = new GitReader('git');

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cdl-files-'));
    fx = createFixtureRepo(path.join(tmp, 'fixture'));
  });
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('C1 vs C2 is the files that changed between those commits', async () => {
    const files = await listChangedFiles(reader, fx.root, fx.c1, fx.c2);
    assert.deepStrictEqual(files, ['added.txt', 'blocks.ts', 'deleted.txt', 'hooks.ts']);
  });

  it('HEAD vs worktree includes untracked files', async () => {
    applyLiveWorkspace(fx.root);
    const files = await listChangedFiles(reader, fx.root, 'HEAD', 'worktree');
    assert.ok(files.includes('hooks.ts'));
    assert.ok(files.includes('added.txt'));
    assert.ok(files.includes('untracked.txt'));
    assert.ok(!files.includes('blocks.ts'), 'stashed blocks.ts matches HEAD on disk');
  });

  it('stash vs worktree includes the untracked stash tree (U22)', async () => {
    const files = await listChangedFiles(reader, fx.root, 'stash.0', 'worktree');
    assert.ok(files.includes('blocks.ts'));
    assert.ok(files.includes('untracked-in-stash.txt'));
  });

  it('the same live side differs in no files', async () => {
    assert.deepStrictEqual(await listChangedFiles(reader, fx.root, 'worktree', 'worktree'), []);
    assert.deepStrictEqual(await listChangedFiles(reader, fx.root, 'HEAD', 'head'), []);
  });
});
