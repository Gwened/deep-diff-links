import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { DeepDiffLinksApi } from '../../../src/extension';
import {
  ADDED,
  BLOCKS_V1,
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
  gitOutput,
} from '../../fixtureRepo';

const fx: Fixture = JSON.parse(process.env.CDL_FIXTURE!);
const AUTHORITY = 'oliviercado.deep-diff-links';

function link(params: Record<string, string>, route = '/diff'): vscode.Uri {
  const query = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  return vscode.Uri.parse(`vscode://${AUTHORITY}${route}?${query}`);
}

const params = (over: Record<string, string> = {}) => ({
  repo: 'fixture',
  left: fx.c1.slice(0, 9),
  right: fx.c2.slice(0, 9),
  path: 'hooks.ts',
  ...over,
});

const tabCount = () => vscode.window.tabGroups.all.reduce((n, g) => n + g.tabs.length, 0);
const text = async (uri: vscode.Uri) => (await vscode.workspace.openTextDocument(uri)).getText();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('deep diff links (integration)', () => {
  let api: DeepDiffLinksApi;

  before(async () => {
    const ext = vscode.extensions.getExtension<DeepDiffLinksApi>(`oliviercado.deep-diff-links`);
    assert.ok(ext, 'extension is installed');
    api = await ext.activate();
  });

  afterEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  it('U1/U2: opens the built-in diff with title and both sides', async () => {
    const r = await api.handleUri(link(params()));
    assert.ok(r.ok, JSON.stringify(r));
    assert.strictEqual(r.title, `hooks.ts (${fx.c1.slice(0, 7)} ↔ ${fx.c2.slice(0, 7)})`);

    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    assert.ok(tab && tab.input instanceof vscode.TabInputTextDiff, 'active tab is a text diff');
    assert.strictEqual(tab.label, r.title);
    const input = tab.input as vscode.TabInputTextDiff;
    assert.strictEqual(input.original.authority, fx.c1, 'left uses the full SHA');
    assert.strictEqual(input.modified.authority, fx.c2, 'right uses the full SHA');
    assert.strictEqual(await text(input.original), HOOKS_V1);
    assert.strictEqual(await text(input.modified), HOOKS_V2);
  });

  it('U2/AC2: HEAD, index and dirty working tree are unchanged', async () => {
    const head = gitOutput(fx.root, 'rev-parse', 'HEAD');
    const status = gitOutput(fx.root, 'status', '--porcelain');
    const stash = gitOutput(fx.root, 'stash', 'list');
    const r = await api.handleUri(link(params()));
    assert.ok(r.ok);
    assert.strictEqual(gitOutput(fx.root, 'rev-parse', 'HEAD'), head);
    assert.strictEqual(gitOutput(fx.root, 'status', '--porcelain'), status);
    assert.strictEqual(fs.readFileSync(path.join(fx.root, 'hooks.ts'), 'utf8'), DIRTY_HOOKS);
    assert.strictEqual(gitOutput(fx.root, 'stash', 'list'), stash);
  });

  it('U3: missing commit shows an error and opens nothing', async () => {
    const before = tabCount();
    const r = await api.handleUri(link(params({ right: 'deadbeefdead' })));
    assert.ok(!r.ok);
    assert.strictEqual(r.code, 'U3');
    assert.strictEqual(r.message, 'Commit `deadbeefdead` not found in `fixture`. Run `git fetch` and try again.');
    assert.strictEqual(tabCount(), before);
  });

  it('U4: added file has an empty left side', async () => {
    const r = await api.handleUri(link(params({ path: 'added.txt' })));
    assert.ok(r.ok);
    assert.match(r.title, /\(absent\) ↔/);
    assert.strictEqual(await text(r.leftUri), '');
    assert.strictEqual(await text(r.rightUri), ADDED);
  });

  it('U5: deleted file has an empty right side', async () => {
    const r = await api.handleUri(link(params({ path: 'deleted.txt' })));
    assert.ok(r.ok);
    assert.match(r.title, /↔ [0-9a-f]{7} \(absent\)\)$/);
    assert.strictEqual(await text(r.leftUri), DELETED);
    assert.strictEqual(await text(r.rightUri), '');
  });

  it('U6: path in neither commit', async () => {
    const r = await api.handleUri(link(params({ path: 'nope/none.ts' })));
    assert.ok(!r.ok);
    assert.strictEqual(r.code, 'U6');
    assert.strictEqual(r.message, '`nope/none.ts` is not present on either side.');
  });

  it('U7: line parameter selects the line on the right side', async () => {
    const r = await api.handleUri(link(params({ line: '80' })));
    assert.ok(r.ok);
    let editor: vscode.TextEditor | undefined;
    for (let i = 0; i < 20 && !editor; i++) {
      editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === r.rightUri.toString());
      if (!editor) await sleep(100);
    }
    assert.ok(editor, 'right side editor is visible');
    assert.strictEqual(editor.selection.active.line, 79);
    assert.ok(editor.visibleRanges.some((range) => range.contains(new vscode.Position(79, 0))), 'line 80 is visible');
  });

  it('binary file shows a placeholder', async () => {
    const r = await api.handleUri(link(params({ path: 'binary.dat' })));
    assert.ok(r.ok);
    assert.strictEqual(await text(r.rightUri), 'Binary file, cannot display.');
  });

  it('file above maxFileBytes shows a notice instead of a diff', async () => {
    const before = tabCount();
    const r = await api.handleUri(link(params({ path: 'big.txt' })));
    assert.ok(!r.ok);
    assert.strictEqual(r.code, 'SIZE');
    assert.strictEqual(tabCount(), before);
  });

  it('U8: no workspace folder with that name', async () => {
    const r = await api.handleUri(link(params({ repo: 'elsewhere' })));
    assert.ok(!r.ok);
    assert.strictEqual(r.code, 'U8');
    assert.strictEqual(r.message, "No workspace folder named `elsewhere`. Open the review's repository in VS Code.");
  });

  it('U9: two workspace folders with the same name', async () => {
    const r = await api.handleUri(link(params({ repo: 'dup' })));
    assert.ok(!r.ok);
    assert.strictEqual(r.code, 'U9');
  });

  it('E1/AC3: shell metacharacters are rejected before anything runs', async () => {
    const cases: Array<Record<string, string>> = [{ path: 'a;touch pwned' }, { left: '$(id)' }, { repo: 'x`id`' }, { path: '../outside' }];
    for (const over of cases) {
      const r = await api.handleUri(link(params(over)));
      assert.ok(!r.ok);
      assert.strictEqual(r.code, 'E1', JSON.stringify(over));
      assert.match(r.message, /^Invalid link: `\w+` /);
    }
    assert.ok(!fs.existsSync(path.join(fx.root, 'pwned')));
  });

  it('E1: branch names are rejected', async () => {
    const r = await api.handleUri(link(params({ left: 'main' })));
    assert.ok(!r.ok && r.code === 'E1');
  });

  it('E1: unknown route', async () => {
    const r = await api.handleUri(link(params(), '/open'));
    assert.ok(!r.ok && r.code === 'E1');
  });

  describe('[v1.1] partial diffs', () => {
    const changedLines = (a: string, b: string) => {
      const x = a.split('\n');
      const y = b.split('\n');
      return { left: x.length, right: y.length, differ: x.length !== y.length || x.some((l, i) => l !== y[i]) };
    };
    const rightEditor = async (uri: vscode.Uri) => {
      for (let i = 0; i < 20; i++) {
        const e = vscode.window.visibleTextEditors.find((ed) => ed.document.uri.toString() === uri.toString());
        if (e) return e;
        await sleep(100);
      }
      return assert.fail('right side editor is not visible');
    };

    it('U10: only the selected block differs; title and reveal', async () => {
      const r = await api.handleUri(link(params({ path: 'blocks.ts', lines: '50-52' })));
      assert.ok(r.ok, JSON.stringify(r));
      assert.strictEqual(r.title, `blocks.ts (${fx.c1.slice(0, 7)} (partial) ↔ ${fx.c2.slice(0, 7)}) · lines 50-52`);
      assert.strictEqual(r.notice, undefined);
      const left = await text(r.leftUri);
      assert.strictEqual(await text(r.rightUri), BLOCKS_V2);
      // The synthetic left equals the right everywhere except lines 50-52, which keep old content.
      const expected = BLOCKS_V2.split('\n')
        .map((l) => l.replace(/^const b(5[0-2]) = 'changed';$/, 'const b$1 = $1;'))
        .join('\n');
      assert.strictEqual(left, expected);
      const tab = vscode.window.tabGroups.activeTabGroup.activeTab!;
      assert.ok(tab.input instanceof vscode.TabInputTextDiff);
      assert.strictEqual(tab.label, r.title);
      assert.strictEqual((await rightEditor(r.rightUri)).selection.active.line, 49);
    });

    it('U10: several ranges, merged and sorted in the title; deletion at a range edge', async () => {
      const r = await api.handleUri(link(params({ path: 'blocks.ts', lines: '140-151,10,9' })));
      assert.ok(r.ok, JSON.stringify(r));
      assert.match(r.title, / · lines 9-10, 140-151$/);
      const left = await text(r.leftUri);
      // Line 10 change kept, deletion of old 150-151 kept, the 50-52 and insertion blocks applied.
      const l = left.split('\n');
      assert.strictEqual(l[9], 'const b10 = 10;');
      assert.ok(l.includes('const b150 = 150;') && l.includes('const b151 = 151;'));
      assert.ok(l.includes("const b50 = 'changed';") && l.includes('const inserted1 = 1;'));
    });

    it('U11: no change in the ranges → identical sides and an info notice', async () => {
      const r = await api.handleUri(link(params({ path: 'blocks.ts', lines: '20-30' })));
      assert.ok(r.ok);
      assert.deepStrictEqual(r.notice, { code: 'U11', message: 'No changes in lines `20-30` of `blocks.ts`.' });
      assert.ok(!changedLines(await text(r.leftUri), await text(r.rightUri)).differ);
      assert.strictEqual((await rightEditor(r.rightUri)).selection.active.line, 19);
    });

    it('U12: deleted file, ranges apply to the left side', async () => {
      const r = await api.handleUri(link(params({ path: 'deleted.txt', lines: '1' })));
      assert.ok(r.ok);
      assert.match(r.title, /↔ [0-9a-f]{7} \(absent, partial\)\) · lines 1$/);
      assert.strictEqual(await text(r.leftUri), DELETED);
      assert.strictEqual(await text(r.rightUri), '');
    });

    it('added file: only the selected lines show as added', async () => {
      const added = await api.handleUri(link(params({ path: 'added.txt', lines: '1' })));
      assert.ok(added.ok);
      assert.match(added.title, /\(absent, partial\) ↔/);
      assert.strictEqual(await text(added.leftUri), '');
      assert.strictEqual(await text(added.rightUri), ADDED);
    });

    it('U13: a range past the end of the file selects nothing', async () => {
      const r = await api.handleUri(link(params({ path: 'blocks.ts', lines: '900-950' })));
      assert.ok(r.ok);
      assert.strictEqual(r.notice?.code, 'U11');
      assert.strictEqual((await rightEditor(r.rightUri)).selection.active.line, 199, 'clipped to the last line (200)');
    });

    it('ranges are ignored for binary files', async () => {
      const r = await api.handleUri(link(params({ path: 'binary.dat', lines: '1' })));
      assert.ok(r.ok);
      assert.ok(!r.title.includes('lines'));
      assert.strictEqual(await text(r.rightUri), 'Binary file, cannot display.');
    });

    it('AC8: without lines, the full diff is unchanged', async () => {
      const r = await api.handleUri(link(params({ path: 'blocks.ts' })));
      assert.ok(r.ok);
      assert.strictEqual(r.title, `blocks.ts (${fx.c1.slice(0, 7)} ↔ ${fx.c2.slice(0, 7)})`);
      assert.strictEqual(await text(r.leftUri), BLOCKS_V1);
    });

    it('E1: invalid lines', async () => {
      const r = await api.handleUri(link(params({ lines: '30-25' })));
      assert.ok(!r.ok && r.code === 'E1' && r.message.startsWith('Invalid link: `lines`'));
    });
  });

  describe('links clicked in the markdown source editor', () => {
    const ownScheme = vscode.env.uriScheme;
    const foreignScheme = ownScheme === 'vscode' ? 'cursor' : 'vscode';

    /**
     * Opens a markdown file containing `href`, puts the cursor on the link, and returns the link
     * the editor would follow. Under VS Code it also runs "Open Link" (the same path as a click).
     * Cursor's test mode reloads the window whenever a cursor:// link is opened, so there only
     * the link target is checked.
     */
    async function clickInSource(href: string): Promise<{ target?: string; diff?: vscode.TabInputTextDiff }> {
      const file = path.join(process.env.CDL_TMP!, `review-${Date.now()}.md`);
      const prefix = 'See [hooks.ts:80](';
      fs.writeFileSync(file, `# Review\n\n${prefix}${href}) for details.\n`);
      const doc = await vscode.workspace.openTextDocument(file);
      const editor = await vscode.window.showTextDocument(doc);
      const pos = new vscode.Position(2, prefix.length + 5);
      editor.selection = new vscode.Selection(pos, pos);
      // Wait for all link providers, including the markdown language server.
      let atCursor: vscode.DocumentLink[] = [];
      for (let i = 0; i < 50 && atCursor.length === 0; i++) {
        await sleep(200);
        const links = (await vscode.commands.executeCommand<vscode.DocumentLink[]>('vscode.executeLinkProvider', doc.uri)) ?? [];
        atCursor = links.filter((l) => l.range.contains(pos));
      }
      const target = atCursor[0]?.target?.toString(true);
      if (ownScheme !== 'vscode') return { target };
      await vscode.commands.executeCommand('editor.action.openLink');
      for (let i = 0; i < 30; i++) {
        const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
        if (input instanceof vscode.TabInputTextDiff && input.modified.scheme === 'deep-diff') return { target, diff: input };
        await sleep(200);
      }
      return { target };
    }

    const href = (scheme: string) =>
      `${scheme}://${AUTHORITY}/diff?repo=fixture&left=${fx.c1.slice(0, 9)}&right=${fx.c2.slice(0, 9)}&path=hooks.ts&line=80`;

    for (const [name, scheme] of [['own', ownScheme], ['foreign', foreignScheme]] as const) {
      it(`${name} scheme (${scheme}://) is followed with this editor's scheme and opens the diff`, async () => {
        const { target, diff } = await clickInSource(href(scheme));
        assert.strictEqual(target, href(ownScheme));
        if (ownScheme === 'vscode') {
          assert.ok(diff, 'diff opened');
          assert.strictEqual(diff.modified.authority, fx.c2);
        }
      });
    }
  });

  it('markdown preview rewrites link schemes to this editor', async () => {
    const md = [
      `[a](cursor://${AUTHORITY}/diff?repo=fixture&left=abcdef0&right=abcdef1&path=a.ts)`,
      `[b](vscode://${AUTHORITY}/diff?repo=fixture&left=abcdef0&right=abcdef1&path=b.ts)`,
      `[c](cursor://other.extension/x)`,
    ].join('\n\n');
    const html = await vscode.commands.executeCommand<string>('markdown.api.render', md);
    const own = vscode.env.uriScheme;
    // The built-in preview percent-encodes the query of its own-scheme links; the URI handler
    // receives it decoded either way, so compare decoded hrefs.
    const hrefs = [...html.matchAll(/ href="([^"]*)"/g)].map((m) => decodeURIComponent(m[1].replace(/&amp;/g, '&')));
    assert.deepStrictEqual(hrefs, [
      `${own}://${AUTHORITY}/diff?repo=fixture&left=abcdef0&right=abcdef1&path=a.ts`,
      `${own}://${AUTHORITY}/diff?repo=fixture&left=abcdef0&right=abcdef1&path=b.ts`,
      'cursor://other.extension/x',
    ]);
  });

  describe('[v1.2] live sides', () => {
    const objectFiles = () => {
      const dir = path.join(fx.root, '.git', 'objects');
      const walk = (d: string): string[] =>
        fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
          const p = path.join(d, e.name);
          if (e.name === 'pack' || e.name === 'info') return [];
          return e.isDirectory() ? walk(p) : [p];
        });
      return walk(dir).sort();
    };

    it('U14: HEAD ↔ worktree', async () => {
      const r = await api.handleUri(link(params({ left: 'HEAD', right: 'worktree', path: 'hooks.ts' })));
      assert.ok(r.ok, JSON.stringify(r));
      assert.strictEqual(r.title, 'hooks.ts (HEAD ↔ worktree)');
      assert.strictEqual(r.leftUri.authority, 'HEAD');
      assert.strictEqual(r.rightUri.authority, 'worktree');
      assert.strictEqual(r.rightUri.scheme, 'deep-diff');
      assert.strictEqual(await text(r.leftUri), HOOKS_V2);
      assert.strictEqual(await text(r.rightUri), DIRTY_HOOKS);
    });

    it('U15: staged ↔ worktree (unstaged only)', async () => {
      const r = await api.handleUri(link(params({ left: 'staged', right: 'worktree', path: 'added.txt' })));
      assert.ok(r.ok, JSON.stringify(r));
      assert.strictEqual(r.title, 'added.txt (staged ↔ worktree)');
      assert.strictEqual(await text(r.leftUri), STAGED_ADDED);
      assert.strictEqual(await text(r.rightUri), WORKTREE_ADDED);
    });

    it('U16: commit ↔ staged', async () => {
      const r = await api.handleUri(link(params({ left: fx.c2.slice(0, 9), right: 'staged', path: 'added.txt' })));
      assert.ok(r.ok, JSON.stringify(r));
      assert.strictEqual(r.title, `added.txt (${fx.c2.slice(0, 7)} ↔ staged)`);
      assert.strictEqual(await text(r.leftUri), ADDED);
      assert.strictEqual(await text(r.rightUri), STAGED_ADDED);
    });

    it('U17: stash ↔ worktree', async () => {
      const r = await api.handleUri(link(params({ left: 'stash', right: 'worktree', path: 'blocks.ts' })));
      assert.ok(r.ok, JSON.stringify(r));
      assert.strictEqual(r.title, 'blocks.ts (stash@{0} ↔ worktree)');
      assert.strictEqual(r.leftUri.authority, 'stash.0');
      assert.strictEqual(await text(r.leftUri), STASHED_BLOCKS);
      assert.strictEqual(await text(r.rightUri), BLOCKS_V2);
    });

    it('U18: missing stash', async () => {
      const before = tabCount();
      const r = await api.handleUri(link(params({ left: 'stash@{99}', right: 'worktree', path: 'hooks.ts' })));
      assert.ok(!r.ok);
      assert.strictEqual(r.code, 'U18');
      assert.strictEqual(r.message, 'Stash `stash@{99}` not found in `fixture`.');
      assert.strictEqual(tabCount(), before);
    });

    it('U21: untracked worktree vs missing HEAD is not U6', async () => {
      const r = await api.handleUri(link(params({ left: 'HEAD', right: 'worktree', path: 'untracked.txt' })));
      assert.ok(r.ok, JSON.stringify(r));
      assert.strictEqual(await text(r.leftUri), '');
      assert.strictEqual(await text(r.rightUri), 'untracked\n');
    });

    it('U22: stash -u untracked file via ^3', async () => {
      const r = await api.handleUri(link(params({ left: 'stash@{0}', right: 'worktree', path: 'untracked-in-stash.txt' })));
      assert.ok(r.ok, JSON.stringify(r));
      assert.strictEqual(await text(r.leftUri), STASH_UNTRACKED);
      assert.strictEqual(await text(r.rightUri), '');
    });

    it('U20: saving the worktree file updates the open diff', async () => {
      const r = await api.handleUri(link(params({ left: 'HEAD', right: 'worktree', path: 'hooks.ts' })));
      assert.ok(r.ok);
      assert.strictEqual(await text(r.rightUri), DIRTY_HOOKS);
      const next = 'saved from U20\n';
      fs.writeFileSync(path.join(fx.root, 'hooks.ts'), next);
      let got = '';
      for (let i = 0; i < 40; i++) {
        got = await text(r.rightUri);
        if (got === next) break;
        await sleep(100);
      }
      fs.writeFileSync(path.join(fx.root, 'hooks.ts'), DIRTY_HOOKS);
      assert.strictEqual(got, next);
    });

    it('partial lines between HEAD and worktree', async () => {
      const r = await api.handleUri(link(params({ left: 'HEAD', right: 'worktree', path: 'hooks.ts', lines: '1' })));
      assert.ok(r.ok, JSON.stringify(r));
      assert.strictEqual(r.title, 'hooks.ts (HEAD (partial) ↔ worktree) · lines 1');
      assert.strictEqual(await text(r.rightUri), DIRTY_HOOKS);
    });

    it('AC10: SHA–SHA title still uses 7-character SHAs', async () => {
      const r = await api.handleUri(link(params()));
      assert.ok(r.ok);
      assert.strictEqual(r.title, `hooks.ts (${fx.c1.slice(0, 7)} ↔ ${fx.c2.slice(0, 7)})`);
      assert.strictEqual(r.leftUri.authority, fx.c1);
    });

    it('AC2: live diff does not mutate status or the object database', async () => {
      const status = gitOutput(fx.root, 'status', '--porcelain');
      const before = objectFiles();
      const r = await api.handleUri(link(params({ left: 'HEAD', right: 'worktree', path: 'hooks.ts', lines: '1' })));
      assert.ok(r.ok);
      assert.strictEqual(gitOutput(fx.root, 'status', '--porcelain'), status);
      assert.deepStrictEqual(objectFiles(), before);
    });
  });

  describe('multi-file (no path)', () => {
    it('opens every file that differs between two commits', async () => {
      const r = await api.handleUri(link({ repo: 'fixture', left: fx.c1.slice(0, 9), right: fx.c2.slice(0, 9) }));
      assert.ok(r.ok, JSON.stringify(r));
      assert.strictEqual(r.title, `${fx.c1.slice(0, 7)} ↔ ${fx.c2.slice(0, 7)}`);
      assert.deepStrictEqual(r.files, ['added.txt', 'blocks.ts', 'deleted.txt', 'hooks.ts']);
      assert.ok(tabCount() >= 1);
    });

    it('HEAD ↔ worktree includes untracked files', async () => {
      const r = await api.handleUri(link({ repo: 'fixture', left: 'HEAD', right: 'worktree' }));
      assert.ok(r.ok, JSON.stringify(r));
      assert.strictEqual(r.title, 'HEAD ↔ worktree');
      assert.ok(r.files?.includes('untracked.txt'));
      assert.ok(r.files?.includes('hooks.ts'));
    });

    it('identical sides list no files', async () => {
      const before = tabCount();
      const r = await api.handleUri(link({ repo: 'fixture', left: 'worktree', right: 'worktree' }));
      assert.ok(!r.ok);
      assert.strictEqual(r.code, 'U23');
      assert.strictEqual(r.message, 'No files differ between `worktree` and `worktree`.');
      assert.strictEqual(tabCount(), before);
    });
  });

  it('AC4: no webview is contributed', () => {
    const pkg = vscode.extensions.getExtension('oliviercado.deep-diff-links')!.packageJSON;
    assert.strictEqual(pkg.contributes.customEditors, undefined);
    assert.strictEqual(pkg.contributes.views, undefined);
  });
});
