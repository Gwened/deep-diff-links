# Deep Diff Links

**A deep-linkable diff viewer for code reviews in Visual Studio Code.**

Turn Markdown code-review comments into clickable, contextual Git diffs. Jump directly to the changes being discussed, even when you're on another branch, without disturbing your working tree.

**Just tell your favorite LLM to produce a guided review document with those links and save hours by reading what matters.**

## How it works

A review written in Markdown points at the exact change it's talking about:

```markdown
The debounce logic changed here: [hooks.ts:25-30,120-160](vscode://oliviercado.deep-diff-links/diff?repo=my-app&left=fcaac3532&right=f756bcd28&path=app/web/utils/hooks.ts&lines=25-30,120-160)
```

Click the link, in the Markdown preview or in the source, and the built-in diff editor opens:

- **It shows the change being discussed.** It opens that file between those two commits. With `lines`, only the change blocks in those lines are highlighted.
- **It works from any branch.** Neither commit needs to be checked out. Target content using SHAs is read straight from git history. `HEAD`, `worktree`, `staged` and `stash` sides follow the repository as it is now.
- **It leaves your work alone.** Nothing is checked out, stashed or written, so a dirty working tree is fine.

## Scope

This extension does one thing: open precise historical diffs from review documents written outside the editor. It deliberately has:

- No commit graph.
- No git history browser.
- No blame annotations.
- No branch, worktree or stash management.

It is not a replacement for GitLens or other general git tools, and it works alongside them. Feature requests outside this scope will be declined.

## Link format

```
vscode://oliviercado.deep-diff-links/diff?repo=<folder>&left=<side>&right=<side>&path=<repo-relative-path>[&line=<n>][&lines=<ranges>]
```

```markdown
[hooks.ts:80](vscode://oliviercado.deep-diff-links/diff?repo=my-app&left=fcaac3532&right=f756bcd28&path=app/web/utils/hooks.ts&line=80)
[hooks.ts:25-30,120-160](vscode://oliviercado.deep-diff-links/diff?repo=my-app&left=fcaac3532&right=f756bcd28&path=app/web/utils/hooks.ts&lines=25-30,120-160)
[uncommitted](vscode://oliviercado.deep-diff-links/diff?repo=my-app&left=HEAD&right=worktree&path=app/web/utils/hooks.ts)
```

| Parameter | Rules |
|---|---|
| `repo` | Basename of exactly one open workspace folder. |
| `left`, `right` | A **side**: lowercase hex commit SHA (7–40 characters), or `HEAD`, `worktree`, `staged`, `stash`, or `stash@{0}`–`stash@{99}`. Branches, tags and `HEAD~1` are rejected. Percent-encode `{` `}` in `stash@{n}` (`stash%40%7B1%7D`). |
| `path` | Repo-relative, forward slashes. No `..`, `.`, leading `/`, backslashes, control characters, or `` ` $ ; \| & < > " ' * ? ! ``. Percent-encode spaces and non-ASCII characters. |
| `line` | Optional positive integer; the right side opens with that line selected. |
| `lines` | Optional ranges such as `25-30,120-160` (right-side line numbers). Gives a **partial diff**: only the changes touching those lines are highlighted. Without it you get the full diff. |

### Partial diffs (`lines`)

- A change block is shown if it overlaps a range, and it is shown whole. A deletion counts if it sits inside a range or right after one.
- Other changes look unchanged, because the left side is rebuilt with them already applied. The title says `(partial)` and lists the ranges: `hooks.ts (fcaac35 (partial) ↔ f756bcd) · lines 25-30, 120-160`.
- For an added or deleted file, ranges pick individual lines. For a deleted file, line numbers refer to the old file.
- If nothing changed in the ranges, the diff still opens at the first range and you get an info message.
- Turn on `diffEditor.hideUnchangedRegions.enabled` to fold everything outside the selected blocks.

### Live sides (`HEAD`, `worktree`, `staged`, `stash`)

- `HEAD` is the checked-out commit, not the file on disk. `staged` is the index. `worktree` is the file on disk after git's clean filters / CRLF (not a `file://` URI, so it is not editable).
- `stash` is `stash@{0}`'s WIP tree; `stash@{n}` selects that stash. Untracked files from `git stash -u` are read from the untracked tree when they are missing from the WIP tree.
- Live sides update while the diff stays open. Commit SHAs stay frozen.

Write links with `vscode://`. They work from the Markdown preview or from Cmd/Ctrl-click in the Markdown source.

The first time you click a link, Visual Studio Code asks whether to let the extension open the URI. Tick "don't ask again" to skip that afterwards.

If a commit isn't in your clone, run `git fetch` and click again. The extension never touches the network.

## Install

Install from this Marketplace page, or:

```sh
code --install-extension oliviercado.deep-diff-links
```

You need the built-in Git extension enabled, and a trusted workspace.

## Settings

| Setting | Default | |
|---|---|---|
| `deepDiffLinks.maxFileBytes` | `10485760` | If either side is bigger than this, you get a notice instead of the diff. |

## Errors

Every failure shows a notification and writes a line to the **Deep Diff Links** output channel.

| Code | When |
|---|---|
| U3 | A commit isn't in the clone |
| U6 | The path isn't present on either side |
| U11 | Info only: no changes in the requested `lines` |
| U18 | That stash isn't in the repository |
| U19 | `HEAD` can't be resolved (unborn branch) |
| U8 / U9 | No workspace folder, or more than one, has the `repo` name |
| E1 | A parameter is invalid (the message names the parameter, never its value) |
| E2 | Git failed or timed out (10 s) |
| E3 | The built-in Git extension is disabled |
| E4 | The matched folder isn't a git repository |

Binary files show `Binary file, cannot display.` Submodule entries and directories get similar placeholders.

## License

Copyright (c) 2026 Olivier Cado. Released under the [MIT License](https://github.com/Gwened/deep-diff-links/blob/main/LICENSE).
