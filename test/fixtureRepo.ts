/**
 * Builds a throwaway git repository with two known commits. Used by unit and integration tests.
 *
 *   C1: hooks.ts (100 lines), deleted.txt, binary.dat, big.txt, dir/a.txt
 *   C2: hooks.ts (line 80 changed), added.txt, deleted.txt removed, others unchanged
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface Fixture {
  root: string;
  c1: string;
  c2: string;
}

const lines = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_, i) => f(i + 1)).join('\n') + '\n';

export const HOOKS_V1 = lines(100, (i) => `export const line${i} = ${i};`);
export const HOOKS_V2 = lines(100, (i) => (i === 80 ? `export const line80 = 'changed';` : `export const line${i} = ${i};`));
export const ADDED = 'brand new file\n';

/**
 * [v1.1] blocks.ts: 200 lines in C1. C2 has four separate change blocks:
 *   - line 10 modified
 *   - lines 50-52 modified
 *   - two lines inserted after old line 100 (new lines 101-102)
 *   - old lines 150-151 deleted (anchor: new line 152)
 */
export const BLOCKS_V1 = lines(200, (i) => `const b${i} = ${i};`);
export const BLOCKS_V2 = (() => {
  const out: string[] = [];
  for (let i = 1; i <= 200; i++) {
    if (i === 150 || i === 151) continue;
    if (i === 10 || (i >= 50 && i <= 52)) out.push(`const b${i} = 'changed';`);
    else out.push(`const b${i} = ${i};`);
    if (i === 100) out.push('const inserted1 = 1;', 'const inserted2 = 2;');
  }
  return out.join('\n') + '\n';
})();
export const DELETED = 'this file goes away\n';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim();
}

function write(root: string, rel: string, content: string | Buffer) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

export function createFixtureRepo(root: string): Fixture {
  fs.mkdirSync(root, { recursive: true });
  git(root, 'init', '-q');
  write(root, 'hooks.ts', HOOKS_V1);
  write(root, 'deleted.txt', DELETED);
  write(root, 'binary.dat', Buffer.from([0x50, 0x4b, 0x00, 0x01, 0x02]));
  write(root, 'big.txt', 'x'.repeat(4096) + '\n');
  write(root, 'dir/a.txt', 'a\n');
  write(root, 'blocks.ts', BLOCKS_V1);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'C1');
  const c1 = git(root, 'rev-parse', 'HEAD');

  write(root, 'hooks.ts', HOOKS_V2);
  write(root, 'added.txt', ADDED);
  write(root, 'blocks.ts', BLOCKS_V2);
  fs.rmSync(path.join(root, 'deleted.txt'));
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'C2');
  const c2 = git(root, 'rev-parse', 'HEAD');
  return { root, c1, c2 };
}

export function gitOutput(cwd: string, ...args: string[]): string {
  return git(cwd, ...args);
}
