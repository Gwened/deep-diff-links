/**
 * [v1.1] Partial diffs (spec §5.2, §6.1). Pure functions, no VS Code imports.
 *
 * The diff editor stays the built-in one. A partial diff is made by replacing one side
 * with a synthetic document in which every change outside the requested ranges is
 * already applied, so VS Code only highlights the selected change blocks.
 */
import type { LineRange } from './validator';

/** One `@@ -a,b +c,d @@` block from `git diff -U0`. Counts default to 1, as in git. */
export interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm;

export function parseZeroContextDiff(output: string): Hunk[] {
  const hunks: Hunk[] = [];
  for (const m of output.matchAll(HUNK_RE)) {
    hunks.push({
      oldStart: Number(m[1]),
      oldCount: m[2] === undefined ? 1 : Number(m[2]),
      newStart: Number(m[3]),
      newCount: m[4] === undefined ? 1 : Number(m[4]),
    });
  }
  return hunks;
}

/** Splits text into lines, each keeping its line ending (`\n` or `\r\n`). */
export function splitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

const inAnyRange = (line: number, ranges: LineRange[]) => ranges.some(([s, e]) => line >= s && line <= e);

/**
 * A block is selected when it overlaps a range on the right side (§5.2).
 * A pure deletion (`+c,0`) has no right-side lines; its anchor is line c+1, and it is
 * selected when the anchor is inside a range or one past a range's end.
 */
export function isSelected(h: Hunk, ranges: LineRange[]): boolean {
  if (h.newCount > 0) {
    const first = h.newStart;
    const last = h.newStart + h.newCount - 1;
    return ranges.some(([s, e]) => first <= e && last >= s);
  }
  const anchor = h.newStart + 1;
  return ranges.some(([s, e]) => anchor >= s && anchor <= e + 1);
}

/**
 * Left document with every unselected block replaced by its right-side content.
 * Selected blocks keep their old content, so they are the only differences left.
 */
export function buildSyntheticLeft(leftText: string, rightText: string, hunks: Hunk[], selected: boolean[]): string {
  const left = splitLines(leftText);
  const right = splitLines(rightText);
  const out: string[] = [];
  let pos = 0;
  hunks.forEach((h, i) => {
    // With a zero count, git reports the line *before* the change.
    const oldIdx = h.oldCount === 0 ? h.oldStart : h.oldStart - 1;
    const newIdx = h.newCount === 0 ? h.newStart : h.newStart - 1;
    out.push(...left.slice(pos, oldIdx));
    out.push(...(selected[i] ? left.slice(oldIdx, oldIdx + h.oldCount) : right.slice(newIdx, newIdx + h.newCount)));
    pos = oldIdx + h.oldCount;
  });
  out.push(...left.slice(pos));
  return out.join('');
}

export interface PartialPlan {
  /** Which side of the diff is replaced by `text`. */
  synthetic: 'left' | 'right';
  text: string;
  /** Number of selected blocks (both texts) or selected lines (added/deleted file). 0 → U11. */
  selectedCount: number;
  /** 1-based line on the right-hand (modified) editor to reveal. */
  revealLine: number;
}

const clampLine = (line: number, lineCount: number) => Math.max(1, Math.min(line, Math.max(lineCount, 1)));

/** File modified between the commits: synthetic left from the `-U0` blocks. */
export function planModified(leftText: string, rightText: string, diffOutput: string, ranges: LineRange[]): PartialPlan {
  const hunks = parseZeroContextDiff(diffOutput);
  const selected = hunks.map((h) => isSelected(h, ranges));
  const rightCount = splitLines(rightText).length;
  const first = hunks.find((_, i) => selected[i]);
  const reveal = first ? (first.newCount > 0 ? first.newStart : first.newStart + 1) : ranges[0][0];
  return {
    synthetic: 'left',
    text: buildSyntheticLeft(leftText, rightText, hunks, selected),
    selectedCount: selected.filter(Boolean).length,
    revealLine: clampLine(reveal, rightCount),
  };
}

/**
 * Added or deleted file (§6.1 mirror). The whole file is one block, so ranges select
 * individual lines instead: the synthetic side is the existing side minus the selected
 * lines, and only those lines show as added (or removed).
 */
export function planOneSided(existingText: string, existing: 'left' | 'right', ranges: LineRange[]): PartialPlan {
  const lines = splitLines(existingText);
  const kept: string[] = [];
  let selectedCount = 0;
  let firstSelected: number | undefined;
  lines.forEach((line, i) => {
    if (inAnyRange(i + 1, ranges)) {
      selectedCount++;
      firstSelected ??= i + 1;
    } else {
      kept.push(line);
    }
  });
  const synthetic = existing === 'right' ? 'left' : 'right';
  // The modified (right) editor shows the real file when it exists, else the synthetic one,
  // where the removed lines would have been at index firstSelected - 1.
  const rightCount = existing === 'right' ? lines.length : kept.length;
  const reveal = firstSelected ?? ranges[0][0];
  return { synthetic, text: kept.join(''), selectedCount, revealLine: clampLine(reveal, rightCount) };
}
