import * as assert from 'assert';
import { findForeignLinks, rewriteHref } from '../../src/linkRewriter';

const A = 'oliviercado.deep-diff-links';
const Q = '/diff?repo=r&left=abcdef0&right=abcdef1&path=a.ts&lines=1-2,5';

describe('linkRewriter', () => {
  it('rewrites vscode:// to cursor:// in Cursor', () => {
    assert.strictEqual(rewriteHref(`vscode://${A}${Q}`, A, 'cursor'), `cursor://${A}${Q}`);
  });
  it('rewrites cursor:// to vscode:// in VS Code', () => {
    assert.strictEqual(rewriteHref(`cursor://${A}${Q}`, A, 'vscode'), `vscode://${A}${Q}`);
  });
  it('matches the extension id case-insensitively', () => {
    assert.strictEqual(rewriteHref(`vscode://OlivierCado.Deep-Diff-Links${Q}`, A, 'cursor'), `cursor://OlivierCado.Deep-Diff-Links${Q}`);
  });
  it('leaves other extensions, web links and relative links alone', () => {
    for (const href of [`vscode://other.ext${Q}`, `https://${A}${Q}`, `file://${A}/x`, './review.md', '#section', `vscode://${A}.evil${Q}`]) {
      assert.strictEqual(rewriteHref(href, A, 'cursor'), href);
    }
  });
});

describe('findForeignLinks', () => {
  it('finds links with another scheme, with offsets and rewritten targets', () => {
    const text = `See [x](vscode://${A}${Q}) and <cursor://${A}${Q}>.`;
    const links = findForeignLinks(text, A, 'cursor');
    assert.strictEqual(links.length, 1);
    assert.strictEqual(text.slice(links[0].start, links[0].end), `vscode://${A}${Q}`);
    assert.strictEqual(links[0].target, `cursor://${A}${Q}`);
  });
  it('ignores other extensions and look-alike authorities', () => {
    assert.deepStrictEqual(findForeignLinks(`vscode://other.ext/diff vscode://${A}x/diff https://${A}/diff`, A, 'cursor'), []);
  });
});

describe('findForeignLinks', () => {
  it('finds links with another scheme, with offsets and rewritten targets', () => {
    const text = `See [x](vscode://${A}${Q}) and <cursor://${A}${Q}>.`;
    const links = findForeignLinks(text, A, 'cursor');
    assert.strictEqual(links.length, 1);
    assert.strictEqual(text.slice(links[0].start, links[0].end), `vscode://${A}${Q}`);
    assert.strictEqual(links[0].target, `cursor://${A}${Q}`);
  });
  it('ignores other extensions and look-alike authorities', () => {
    assert.deepStrictEqual(findForeignLinks(`vscode://other.ext/diff vscode://${A}x/diff https://${A}/diff`, A, 'cursor'), []);
  });
});

describe('legacy authorities (former ids)', () => {
  const OLD = 'example.old-name';
  it('rewrites the authority, keeping or fixing the scheme', () => {
    assert.strictEqual(rewriteHref(`vscode://${OLD}${Q}`, A, 'vscode', [OLD]), `vscode://${A}${Q}`);
    assert.strictEqual(rewriteHref(`vscode://${OLD}${Q}`, A, 'cursor', [OLD]), `cursor://${A}${Q}`);
  });
  it('accepts several legacy ids (former publisher and former name)', () => {
    const legacy = [OLD, 'example.older-name'];
    assert.strictEqual(rewriteHref(`vscode://example.older-name${Q}`, A, 'vscode', legacy), `vscode://${A}${Q}`);
    assert.strictEqual(rewriteHref(`cursor://${OLD}${Q}`, A, 'vscode', legacy), `vscode://${A}${Q}`);
  });
  it('is ignored when not declared', () => {
    assert.strictEqual(rewriteHref(`vscode://${OLD}${Q}`, A, 'vscode'), `vscode://${OLD}${Q}`);
  });
  it('source-editor links include own-scheme legacy links', () => {
    const links = findForeignLinks(`[a](vscode://${OLD}${Q}) [b](vscode://${A}${Q})`, A, 'vscode', [OLD]);
    assert.deepStrictEqual(links.map((l) => l.target), [`vscode://${A}${Q}`]);
  });
});
