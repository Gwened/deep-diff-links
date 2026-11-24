# Deep Diff Links

**A deep-linkable diff viewer for code reviews in VS Code and Cursor.**

Turn Markdown code-review comments into clickable, contextual Git diffs. Jump directly to the changes being discussed, even when you're on another branch, without disturbing your working tree.

**Just tell your favorite LLM to produce a guided review document with those links and save hours by reading what matters.**

## How it works

A review written in Markdown points at the exact change it's talking about:

```markdown
The debounce logic changed here: [hooks.ts:25-30,120-160](vscode://oliviercado.deep-diff-links/diff?repo=my-app&left=fcaac3532&right=f756bcd28&path=app/web/utils/hooks.ts&lines=25-30,120-160)
```

Click the link, in the Markdown preview or in the source, and the built-in diff editor opens:

- **It shows the change being discussed.** It opens that file between those two commits. With `lines`, only the change blocks in those lines are highlighted. Omit `path` to open every file that differs.
- **It works from any branch.** Neither commit needs to be checked out. Target content using SHAs is read straight from git history. `HEAD`, `worktree`, `staged` and `stash` sides follow the repository as it is now.
- **It leaves your work alone.** Nothing is checked out, stashed or written, so a dirty working tree is fine.
- **Compatible with your editor.** The same link opens in VS Code and in Cursor.

## Scope

This extension does one thing: open precise historical diffs from review documents written outside the editor. It deliberately has:

- No commit graph.
- No git history browser.
- No blame annotations.
- No branch, worktree or stash management.

It is not a replacement for GitLens or other general git tools, and it works alongside them. Feature requests outside this scope will be declined.

## Link format

```
vscode://oliviercado.deep-diff-links/diff?repo=<folder>&left=<side>&right=<side>[&path=<repo-relative-path>][&line=<n>][&lines=<ranges>]
```

```markdown
[hooks.ts:80](vscode://oliviercado.deep-diff-links/diff?repo=my-app&left=fcaac3532&right=f756bcd28&path=app/web/utils/hooks.ts&line=80)
[hooks.ts:25-30,120-160](vscode://oliviercado.deep-diff-links/diff?repo=my-app&left=fcaac3532&right=f756bcd28&path=app/web/utils/hooks.ts&lines=25-30,120-160)
[uncommitted](vscode://oliviercado.deep-diff-links/diff?repo=my-app&left=HEAD&right=worktree&path=app/web/utils/hooks.ts)
[unstaged](vscode://oliviercado.deep-diff-links/diff?repo=my-app&left=staged&right=worktree&path=app/web/utils/hooks.ts)
[all files](vscode://oliviercado.deep-diff-links/diff?repo=my-app&left=fcaac3532&right=f756bcd28)
[uncommitted, all files](vscode://oliviercado.deep-diff-links/diff?repo=my-app&left=HEAD&right=worktree)
```

| Parameter | Rules |
|---|---|
| `repo` | Basename of exactly one open workspace folder. |
| `left`, `right` | A **side**: lowercase hex commit SHA (7–40 characters), or `HEAD`, `worktree`, `staged`, `stash`, or `stash@{0}`–`stash@{99}`. Branches, tags and `HEAD~1` are rejected. Percent-encode `{` `}` in `stash@{n}` (`stash%40%7B1%7D`). |
| `path` | Optional. When set: repo-relative, forward slashes. No `..`, `.`, leading `/`, backslashes, control characters, or `` ` $ ; \| & < > " ' * ? ! ``. Percent-encode spaces and non-ASCII characters. When omitted: **multi-file diff** of every path that differs. |
| `line` | Optional positive integer; the right side opens with that line selected. Requires `path`. |
| `lines` | Optional ranges such as `25-30,120-160` (right-side line numbers). Gives a **partial diff**: only the changes touching those lines are highlighted. Without it you get the full diff. Requires `path`. |

### Partial diffs (`lines`)

- A change block is shown if it overlaps a range, and it is shown whole. A deletion counts if it sits inside a range or right after one.
- Other changes look unchanged, because the left side is rebuilt with them already applied. The title says `(partial)` and lists the ranges: `hooks.ts (fcaac35 (partial) ↔ f756bcd) · lines 25-30, 120-160`.
- For an added or deleted file, ranges pick individual lines. For a deleted file, line numbers refer to the old file.
- If nothing changed in the ranges, the diff still opens at the first range and you get an info message.
- Turn on `diffEditor.hideUnchangedRegions.enabled` to fold everything outside the selected blocks.

### Multi-file diffs (no `path`)

- The built-in multi-file diff opens, titled `fcaac35 ↔ f756bcd` or `HEAD ↔ worktree`.
- A `worktree` side includes untracked files. A `stash` side includes untracked files from `git stash -u`.
- The file list is taken at click time. Content of those files still updates while the diff stays open; new or removed paths need another click.
- `line` and `lines` cannot be used without `path`.

### Live sides (`HEAD`, `worktree`, `staged`, `stash`)

- `HEAD` is the checked-out commit, not the file on disk. `staged` is the index. `worktree` is the file on disk after git's clean filters / CRLF (not a `file://` URI, so it is not editable).
- `stash` is `stash@{0}`'s WIP tree; `stash@{n}` selects that stash. Untracked files from `git stash -u` are read from the untracked tree when they are missing from the WIP tree.
- Live sides update while the diff stays open (save the worktree file, or change the index / HEAD / stash). Commit SHAs stay frozen.
- In markdown URLs, write `stash@{1}` as `stash%40%7B1%7D`.

**VS Code and Cursor.** Write links with `vscode://` or `cursor://`. They work in both editors, from the markdown preview or from Cmd/Ctrl-click in the markdown source. The extension points them at the editor you're in.

**Cursor.** The tab Preview button does not open `vscode://` links ([bug](https://forum.cursor.com/t/links-of-md-files-are-not-working-on-preview-mode/154174)). Use **Markdown: Open Preview**, click in the source, or write `cursor://`.

The first time you click a link, VS Code asks whether to let the extension open the URI. Tick "don't ask again" to skip that afterwards.

If a commit isn't in your clone, run `git fetch` and click again. The extension never touches the network.

## Install

```sh
npm ci
npm run package:vscode        # deep-diff-links-<version>-vscode.vsix    (Visual Studio Marketplace)
npm run package:openvsx       # deep-diff-links-<version>-openvsx.vsix   (Open VSX)
code --install-extension deep-diff-links-0.5.0-vscode.vsix
cursor --install-extension deep-diff-links-0.5.0-openvsx.vsix
```

Store listings are `docs/readme-vscode-marketplace.md` and `docs/readme-open-vsx.md`. This GitHub README is not packed into either VSIX.

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
| U23 | A multi-file link, and no files differ |
| U11 | Info only: no changes in the requested `lines` |
| U18 | That stash isn't in the repository |
| U19 | `HEAD` can't be resolved (unborn branch) |
| U8 / U9 | No workspace folder, or more than one, has the `repo` name |
| E1 | A parameter is invalid (the message names the parameter, never its value) |
| E2 | Git failed or timed out (10 s) |
| E3 | The built-in Git extension is disabled |
| E4 | The matched folder isn't a git repository |

Binary files show `Binary file, cannot display.` Submodule entries and directories get similar placeholders.

## Development

```sh
npm run test:unit          # validator, git argument building, error mapping, fixture-repo reads
npm run test:integration   # downloads VS Code and runs the suite against a generated fixture repo
CDL_EDITOR=/Applications/Cursor.app/Contents/MacOS/Cursor node out/test/integration/runTest.js   # same suite in Cursor
CDL_GREP='source editor' npm run test:integration                                               # run a subset
```

The link address is the extension id, `<publisher>.<name>` from `package.json`. If either changes, add the old id to `LEGACY_IDS` in `src/extension.ts` so old links keep working from Markdown.

### Layout

| File | Role |
|---|---|
| `src/validator.ts` | Pure §5.1 checks |
| `src/gitReader.ts` | `execFile` wrapper (argument arrays, timeouts, error mapping) |
| `src/fileAtCommit.ts` | Commit and live-side resolution, file reads, binary detection |
| `src/repoResolver.ts` | `repo` → workspace folder → repository root, via the Git extension API |
| `src/contentProvider.ts` | `deep-diff://` scheme; SHA cache; live sides emit `onDidChange` |
| `src/hunkSelector.ts` | Partial diffs: `-U0` block parsing, selection, synthetic side |
| `src/changedFiles.ts` | Multi-file links: which paths differ between two sides |
| `src/linkRewriter.ts` | Rewrites links to the running editor's scheme, in the preview (markdown-it plugin) and the source editor (link provider) |
| `src/diffOpener.ts` | Reads both sides, checks U6 and size, then calls `vscode.diff` or the multi-file editor |
| `src/uriHandler.ts` | Entry point; turns every failure into a notification and a log line |

## License

Copyright (c) 2026 Olivier Cado. Released under the [MIT License](LICENSE). See [AUTHORS](AUTHORS) and the [changelog](CHANGELOG.md).
