import * as assert from 'assert';
import {
  Hunk,
  buildSyntheticLeft,
  isSelected,
  parseZeroContextDiff,
  planModified,
  planOneSided,
  splitLines,
} from '../../src/hunkSelector';

const h = (oldStart: number, oldCount: number, newStart: number, newCount: number): Hunk => ({ oldStart, oldCount, newStart, newCount });
const text = (...lines: string[]) => lines.map((l) => `${l}\n`).join('');

describe('[v1.1] hunkSelector', () => {
  describe('parseZeroContextDiff', () => {
    it('parses headers, defaulting omitted counts to 1', () => {
      const out = [
        'diff --git a/x b/y',
        'index 1..2 100644',
        '--- a/x',
        '+++ b/y',
        '@@ -3 +3 @@ function f() {',
        '-a',
        '+b',
        '@@ -10,0 +11,2 @@',
        '+c',
        '+d',
        '@@ -20,2 +22,0 @@',
        '-e',
        '-@@ -99 +99 @@ removed line that looks like a header',
      ].join('\n');
      assert.deepStrictEqual(parseZeroContextDiff(out), [h(3, 1, 3, 1), h(10, 0, 11, 2), h(20, 2, 22, 0)]);
    });
    it('no output means no blocks', () => assert.deepStrictEqual(parseZeroContextDiff(''), []));
  });

  describe('splitLines', () => {
    it('keeps endings, including CRLF and a missing final newline', () => {
      assert.deepStrictEqual(splitLines('a\r\nb\nc'), ['a\r\n', 'b\n', 'c']);
      assert.deepStrictEqual(splitLines(''), []);
    });
  });

  describe('isSelected', () => {
    it('modification overlapping a range', () => {
      assert.ok(isSelected(h(10, 3, 10, 3), [[12, 20]]));
      assert.ok(isSelected(h(10, 3, 10, 3), [[1, 10]]));
      assert.ok(!isSelected(h(10, 3, 10, 3), [[13, 20]]));
      assert.ok(!isSelected(h(10, 3, 10, 3), [[1, 9]]));
    });
    it('a block straddling a range is selected whole', () => {
      assert.ok(isSelected(h(5, 20, 5, 20), [[10, 11]]));
    });
    it('pure addition uses its new lines', () => {
      assert.ok(isSelected(h(100, 0, 101, 2), [[102, 102]]));
      assert.ok(!isSelected(h(100, 0, 101, 2), [[103, 110]]));
    });
    it('pure deletion: anchor inside a range, or one past its end', () => {
      // Deleted after new line 151, anchor 152.
      assert.ok(isSelected(h(150, 2, 151, 0), [[152, 160]]));
      assert.ok(isSelected(h(150, 2, 151, 0), [[140, 151]]));
      assert.ok(!isSelected(h(150, 2, 151, 0), [[140, 150]]));
      assert.ok(!isSelected(h(150, 2, 151, 0), [[153, 160]]));
    });
    it('deletion at the top of the file anchors on line 1', () => {
      assert.ok(isSelected(h(1, 2, 0, 0), [[1, 1]]));
    });
  });

  describe('buildSyntheticLeft', () => {
    const left = text('1', '2', '3', '4', '5');
    const right = text('1', 'two', '3', '4', 'x', '5');
    const hunks = [h(2, 1, 2, 1), h(4, 0, 5, 1)];
    it('nothing selected → equals right', () => assert.strictEqual(buildSyntheticLeft(left, right, hunks, [false, false]), right));
    it('everything selected → equals left', () => assert.strictEqual(buildSyntheticLeft(left, right, hunks, [true, true]), left));
    it('one selected → only that block differs', () => {
      assert.strictEqual(buildSyntheticLeft(left, right, hunks, [true, false]), text('1', '2', '3', '4', 'x', '5'));
      assert.strictEqual(buildSyntheticLeft(left, right, hunks, [false, true]), text('1', 'two', '3', '4', '5'));
    });
    it('deletion and missing final newline', () => {
      const l = '1\n2\n3';
      const r = '1\n3';
      assert.strictEqual(buildSyntheticLeft(l, r, [h(2, 1, 1, 0)], [false]), r);
      assert.strictEqual(buildSyntheticLeft(l, r, [h(2, 1, 1, 0)], [true]), l);
    });
  });

  describe('planModified', () => {
    const left = text('1', '2', '3', '4', '5');
    const right = text('1', 'two', '3', '4', 'x', '5');
    const diff = '@@ -2 +2 @@\n-2\n+two\n@@ -4,0 +5 @@\n+x\n';
    it('selects, builds and reveals the first selected block', () => {
      const p = planModified(left, right, diff, [[5, 5]]);
      assert.deepStrictEqual(p, { synthetic: 'left', text: text('1', 'two', '3', '4', '5'), selectedCount: 1, revealLine: 5 });
    });
    it('no selected block → identical sides, reveal clipped to the file', () => {
      const p = planModified(left, right, diff, [[400, 500]]);
      assert.strictEqual(p.selectedCount, 0);
      assert.strictEqual(p.text, right);
      assert.strictEqual(p.revealLine, 6);
    });
  });

  describe('planOneSided', () => {
    const file = text('a', 'b', 'c', 'd');
    it('added file: only selected lines show as added', () => {
      assert.deepStrictEqual(planOneSided(file, 'right', [[2, 3]]), { synthetic: 'left', text: text('a', 'd'), selectedCount: 2, revealLine: 2 });
    });
    it('deleted file: only selected lines show as removed', () => {
      assert.deepStrictEqual(planOneSided(file, 'left', [[2, 3]]), { synthetic: 'right', text: text('a', 'd'), selectedCount: 2, revealLine: 2 });
    });
    it('range past the end is clipped (U13)', () => {
      const p = planOneSided(file, 'right', [[3, 99]]);
      assert.strictEqual(p.selectedCount, 2);
      assert.strictEqual(planOneSided(file, 'right', [[50, 99]]).selectedCount, 0);
    });
  });
});
