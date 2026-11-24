# Spec: Deep Diff Links (VS Code extension)

Written for: the engineer who will build this extension, and the reviewer who will use it to read diffs from markdown reviews.

**Status:** v1, v1.1 (partial diffs and automatic editor scheme), and **[v1.2]** live sides (`HEAD`, `worktree`, `staged`, `stash`) implemented.
**Spec vs app version:** `v1` / `v1.1` / `v1.2` are feature slices in this document, not the extension semver (`package.json`).
**Name:** Deep Diff Links, extension id `oliviercado.deep-diff-links` (renamed from Commit Diff Links; see decisions 13 and 14).

---

## 1. Problem

Review documents (like `review-fcaac3532..f756bcd28.md`) point at code changes between two commits. Today the links either open a patch file, which is hard to read, or open the working-tree file, which shows the current state and no change. Reviewers want to click a link and see the **native VS Code diff editor** (red/green highlighting, side-by-side, inline toggle) comparing two versions of one file.

Those versions are often two commits the reviewer does not have checked out. They are also, **[v1.2]**, the checked-out commit (`HEAD`), the index (`staged`), the file on disk (`worktree`), or a stash. The extension must render the diff without checking anything out.

## 2. Goals

- G1. A markdown link opens the native VS Code diff editor for one file between two sides (two commits in v1; **[v1.2]** also `HEAD`, `worktree`, `staged`, and `stash`).
- G2. Works when the reviewer is on any branch, with a dirty working tree, and without checking out either commit.
- G3. Works when the commits exist in the local clone. If they don't, fail with an actionable message (not a stack trace).
- G4. Uses only the built-in `vscode.diff` UI. No custom webview, no custom highlighting.
- G5. Safe to click: a link cannot run arbitrary commands or read files outside the repository.
- G6. **[v1.1]** A link can name line ranges, such as `hooks.ts:25-30,120-160`. The diff then shows only the changes that touch those ranges, and every other change in the file looks unchanged. A link with no ranges shows the full diff, as in v1.
- G7. **[v1.2]** A live side (`HEAD`, `worktree`, `staged`, `stash`) tracks the repository as it is now. An open diff updates when that side changes. There is no snapshot mode and no way to pin live content in the URL.

## 3. Non-goals

- Fetching missing commits from the network automatically (the user runs `git fetch`; see §9).
- Showing a commit-range summary (one file per link; a summary view is a later feature).
- Rendering diffs for submodules or binary files beyond "binary, cannot display".
- Editing either side of the diff. The worktree side is **not** a `file://` URI.
- Supporting remote-only repositories (no clone = no feature).
- **[v1.1]** Splitting a change block. A block that overlaps a range is shown whole, even where it extends past the range.
- **[v1.1]** Ranges on the left (old) side, except for a deleted file (§5.2).
- **[v1.1]** Changing the user's settings. Folding of unchanged regions follows the user's `diffEditor.hideUnchangedRegions.enabled` setting.
- **[v1.2]** Snapshot links, blob oids in the URL, or freezing a live side at click time.
- **[v1.2]** Branch names, tags, remotes, `HEAD~1`, `stash@{<date>}`, or the stash index tree (`^2`).
- **[v1.2]** Writing objects into the user's object database (`git hash-object -w`).

## 4. Users and scenarios

| # | Scenario | Expected |
|---|---|---|
| U1 | Reviewer clicks a link in a markdown preview | Diff editor opens, titled `<path> (<old7> ↔ <new7>)` |
| U2 | Reviewer is on `develop`, both commits are in the clone | Diff opens; checkout unchanged; working tree untouched |
| U3 | A commit is missing from the clone | Notification: "Commit `f756bcd28` not found. Run `git fetch` and try again." Nothing else happens |
| U4 | File was added in the new commit | Left side is empty; diff shows all lines added |
| U5 | File was deleted in the new commit | Right side is empty; diff shows all lines removed |
| U6 | Path does not exist on either side | Notification: "`<path>` is not present on either side." |
| U7 | Link carries a line number | Diff opens and the right side scrolls to that line |
| U10 | **[v1.1]** Link carries `lines=25-30,120-160` | Diff opens showing only the change blocks that touch right-side lines 25–30 or 120–160. Other changes are not highlighted. Title ends with `· lines 25-30, 120-160`. Right side scrolls to the first selected block |
| U11 | **[v1.1]** No change touches the given ranges | Diff opens with no highlighted changes, scrolled to the first range. Notification (info): "No changes in lines `25-30, 120-160` of `<path>`." |
| U12 | **[v1.1]** Ranges on a deleted file | Ranges apply to the left side. Only the selected lines show as removed |
| U13 | **[v1.1]** A range runs past the end of the file | Range is clipped to the file length. A range starting past the end selects nothing (see U11) |
| U14 | **[v1.2]** `left=HEAD&right=worktree` | Diff is uncommitted work (staged and unstaged) vs the checked-out commit. Title: `<path> (HEAD ↔ worktree)` |
| U15 | **[v1.2]** `left=staged&right=worktree` | Diff is unstaged edits only. Title: `<path> (staged ↔ worktree)` |
| U16 | **[v1.2]** `left=<sha>&right=staged` | Diff is the index vs that commit. Title: `<path> (<sha7> ↔ staged)` |
| U17 | **[v1.2]** `left=stash&right=worktree` | Diff is `stash@{0}`'s WIP tree vs the file on disk. Title: `<path> (stash@{0} ↔ worktree)` |
| U18 | **[v1.2]** `stash@{n}` does not exist | Notification: "Stash `stash@{n}` not found in `<repo>`." Nothing else happens |
| U19 | **[v1.2]** `HEAD` cannot be resolved (unborn branch) | Notification: "`HEAD` not found in `<repo>`." Nothing else happens |
| U20 | **[v1.2]** Open `worktree` diff; user saves the file | The open diff updates to the new disk content. No second click |
| U21 | **[v1.2]** Path is untracked, not staged, and missing from the other side | U6 (absent on both sides), unless the other side is `worktree` and the file exists on disk |
| U22 | **[v1.2]** Path is missing from the stash WIP tree but present in the untracked commit (`git stash -u`) | The stash side shows the untracked tree (`stash@{n}^3`) |

A SHA–SHA link behaves exactly as in v1 / v1.1 (U1–U13).

## 5. Link format

A link is a `vscode://` URI, which VS Code routes to the extension's URI handler. This works in the markdown preview without enabling command trust.

```
vscode://oliviercado.deep-diff-links/diff?repo=<repo-name>&left=<side>&right=<side>&path=<repo-relative-path>[&line=<n>][&lines=<ranges>]
```

`<side>` is a commit SHA or a **[v1.2]** live token (§5.1). `path` is always the same: a repo-relative file path. `left` / `right` choose which copy of that file to show.

Examples (as they would appear in the review):

```markdown
[hooks.ts:80](vscode://oliviercado.deep-diff-links/diff?repo=my-app&left=fcaac3532&right=f756bcd28&path=app/web/utils/hooks.ts&line=80)
[hooks.ts:25-30,120-160](vscode://oliviercado.deep-diff-links/diff?repo=my-app&left=fcaac3532&right=f756bcd28&path=app/web/utils/hooks.ts&lines=25-30,120-160)
[uncommitted](vscode://oliviercado.deep-diff-links/diff?repo=my-app&left=HEAD&right=worktree&path=app/web/utils/hooks.ts)
[unstaged](vscode://oliviercado.deep-diff-links/diff?repo=my-app&left=staged&right=worktree&path=app/web/utils/hooks.ts)
[index vs commit](vscode://oliviercado.deep-diff-links/diff?repo=my-app&left=fcaac3532&right=staged&path=app/web/utils/hooks.ts)
[stash vs local](vscode://oliviercado.deep-diff-links/diff?repo=my-app&left=stash&right=worktree&path=app/web/utils/hooks.ts)
```

In a markdown URL, `{` and `}` in `stash@{n}` must be percent-encoded (`stash%40%7B1%7D` for `stash@{1}`). The URI handler receives the decoded token.

**[v1.1] Editor scheme is automatic.** Each editor routes only links with its own scheme (`vscode://` in VS Code, `cursor://` in Cursor). Review files can use either scheme, and links work in both editors in both places a reviewer clicks:
- **Markdown preview.** The built-in markdown extension already rewrites `vscode://` and `vscode-insiders://` links to `vscode.env.uriScheme` (`_addLinkNormalizer`). The extension also contributes a markdown-it plugin (`markdown.markdownItPlugins`) that does the same for any scheme, so `cursor://` links work in VS Code too. VS Code's preview percent-encodes the query of its own-scheme links (`repo%3D…%26left%3D…`). This is harmless, because the URI handler receives the query decoded.
- **Markdown source editor** (Cmd/Ctrl-click). The markdown language server's link keeps the written scheme. A foreign scheme is then opened as a file and fails: `Unable to read file … (EntryNotFound)` in Cursor, `Unable to resolve resource` in VS Code. The extension registers a `DocumentLinkProvider` for markdown that returns a link over the same range with this editor's scheme. Tests in VS Code 1.147 and Cursor (VS Code 1.128 base) show the editor follows this link.
- Only links whose authority is this extension's id are touched. `http(s)`, `file` and other extensions' links are left alone. Own-scheme links get no extra link.

### 5.1 Parameters

| Name | Required | Rules |
|---|---|---|
| `repo` | yes | Must match the **name of exactly one workspace folder** (`basename` of the repo root). Zero matches: error U8. Two or more: error U9. |
| `left` | yes | A **side** (§5.1.1). |
| `right` | yes | Same rules as `left`. |
| `path` | yes | Repo-relative, forward slashes, no `..` segments, no leading `/`, no backslashes, no NUL. Same path for every kind of side. The name must be the name **in that side's tree** (after `git mv a.ts b.ts` that is staged but not committed, `staged` uses `b.ts` and `HEAD` still uses `a.ts`; a stash keeps the names from stash time). |
| `line` | no | Positive integer. Applies to the right side. |
| `lines` | no | **[v1.1]** Comma-separated ranges, each `<n>` or `<start>-<end>`, with positive integers and `start ≤ end`. Regex per range: `^[1-9][0-9]{0,8}(-[1-9][0-9]{0,8})?$`. At most 50 ranges. No spaces. Ranges may be in any order and may overlap; they are sorted and merged before use. |

`line` and `lines` may be combined. `line` sets the scroll position, and when it is absent, `lines` scrolls to the first selected block.

Error U8: "No workspace folder named `<repo>`. Open the review's repository in VS Code."

#### 5.1.1 [v1.2] Sides (`left` / `right`)

A side is exactly one of the following. Anything else is E1, including branch names, tags, `head`, `HEAD~1`, and `stash@{1.hour.ago}`.

| Token | Live? | Copy of `path` | Git source |
|---|---|---|---|
| `^[0-9a-f]{7,40}$` | no | File in that commit | `<sha>:<path>` |
| `HEAD` | yes | File in the checked-out commit | `HEAD:<path>` after `HEAD^{commit}` |
| `worktree` | yes | File on disk, dirty or clean | Working tree (git's view of the file, §6.2) |
| `staged` | yes | File in the index | `:0:<path>` |
| `stash` | yes | File in the latest stash WIP tree | Same as `stash@{0}` |
| `stash@{n}` | yes | File in that stash's WIP tree | `stash@{n}:<path>`, then `stash@{n}^3:<path>` if missing (U22) |

`n` is an integer from 0 to 99 inclusive. No leading zeros except `stash@{0}`. Regex: `^stash(@\{([0-9]|[1-9][0-9])\})?$`.

`HEAD` is not the local file. The three git copies of one path are: the last commit (`HEAD` or a SHA), the index (`staged`), and the disk (`worktree`). Typical pairs:

- `HEAD` ↔ `worktree` — everything not committed (U14)
- `HEAD` ↔ `staged` — only what is staged
- `staged` ↔ `worktree` — only unstaged edits (U15)

A SHA on a commit side stays frozen after later commits. `HEAD` always means the current branch tip (or detached commit).

Keywords cannot collide with SHAs (`HEAD`, `worktree`, `staged`, `stash` are not lowercase hex).

### 5.2 [v1.1] Which side `lines` refers to

- Line numbers refer to the **right (new) side**, which is what a reviewer reads in "this behaviour has been modified: hooks.ts:25-30".
- If the file is absent on the right (deleted file, U5), the numbers refer to the left side.
- A change block is **selected** when it overlaps a range:
  - A block that adds or modifies lines is selected if its right-side lines intersect a range.
  - A pure deletion has no right-side lines. It is selected if its anchor (the right-side line just after the removed lines) is inside a range, or is one past the end of a range. So a deletion at the edge of a range is included.

### 5.3 Why `vscode://` and not `command:`

- `command:` links in markdown are disabled by default and need `isTrusted`. Review files are often opened from repos the user did not write.
- A URI handler is a single, validated entry point that we control.

## 6. Behavior

1. The URI handler parses and validates parameters (§5.1). On failure: show error, stop.
2. Resolve the repository: the workspace folder whose basename equals `repo`. Obtain its `Repository` object from the built-in Git extension API.
3. Resolve each side (§6.2). On failure: the matching U-error, stop.
4. Build two URIs with a custom scheme, `deep-diff://` (§7.2). Each side is served by a `TextDocumentContentProvider`.
5. Call `vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title, { preview: true, selection })`.
6. If `line` is set, scroll the right side to that line (use `selection` in the options, or reveal after the editor opens).

Titles: `<path> (<leftLabel> ↔ <rightLabel>)`. A commit SHA is shown as 7 hex characters. Live tokens use `HEAD`, `worktree`, `staged`, and `stash@{n}` (`stash` displays as `stash@{0}`). **[v1.1]** With `lines`: append ` · lines 25-30, 120-160`, showing the ranges after merging.

### 6.1 [v1.1] Partial diff

The diff editor stays the built-in one (G4). The extension changes the **left document**, not the editor:

1. Read both sides as in §6.2.
2. Get the change blocks with `git diff --no-color --no-ext-diff --no-textconv -U0`. When both sides have a blob oid already in the object database, pass those oids. **[v1.2]** Otherwise write two temp files **outside** the repository and run `git diff --no-index -U0 -- <tmp-left> <tmp-right>`, then delete the temps. Never `git hash-object -w`. Each `@@ -a,b +c,d @@` header is one block.
3. Mark the blocks selected by the ranges (§5.2).
4. Build a **synthetic left document**: start from the left file and apply every block that is *not* selected, so that region already matches the right side. Selected blocks keep their old content.
5. Open `vscode.diff(syntheticLeft, right, …)`. VS Code then highlights only the selected blocks. If the user has `diffEditor.hideUnchangedRegions.enabled` turned on, everything else folds away.
6. If no block is selected, open the diff anyway (the two sides are now identical), scroll to the first range, and show U11.

For an added or deleted file, the whole file is a single block, so whole-block selection would ignore the ranges. Ranges select individual lines instead:
- **Deleted file** (ranges refer to the left side): the right document is synthetic. It is the left file without the selected lines, so only those show as removed.
- **Added file**: the left document is synthetic. It is the right file without the selected lines, so only those show as added.

The synthetic side is a view, not a commit. Its tab label must say so (§7.2), so nobody mistakes it for the file at `<leftLabel>`.

### 6.2 [v1.2] Resolving a side

**Commit SHA.** Verify it exists: `git cat-file --batch-check` on `<sha>^{commit}` (same as v1). Expand to 40 hex characters. Missing → U3. Then read `<sha>:<path>` as in v1. Immutable; cache as today.

**`HEAD`.** `git rev-parse --verify --end-of-options HEAD^{commit}`. Failure → U19. Then read like a commit, but the virtual URI keeps the identity `HEAD` (not the resolved SHA), so a later commit can refresh the open diff.

**`staged`.** `git cat-file --batch-check` on `:0:<path>` with the already-validated path. Missing (untracked, or never added) → empty side. Staged deletion → empty side. Staged add → that blob. Classify blob / tree / commit (submodule) as in v1.

**`worktree`.** Resolve `path` under the repo root, then `realpath`. If the result is not inside the realpath of the repo root, E1 (symlink escape). If the path is absent on disk → empty side. If it is a directory, submodule, binary, or over `maxFileBytes`, same placeholders as v1. Read the file **the way git does for `git diff`** (clean filters / CRLF), not as a raw `file://` buffer, so the diff matches `git diff`. Do not open `file://` (editing is a non-goal).

**`stash` / `stash@{n}`.** `git rev-parse --verify --end-of-options stash@{n}^{commit}`. Failure → U18. Read `stash@{n}:<path>` (WIP tree, including staged-at-stash-time content that git records there). If that path is missing, and `stash@{n}^3` exists, read `stash@{n}^3:<path>` (untracked files from `git stash -u`) (U22). Still missing → empty side. The virtual URI keeps `stash@{n}`, not the resolved SHA.

A missing path on one side is an empty document (U4 / U5). Missing on both is U6. No `git checkout`, `git stash` application, or write inside the clone.

### 6.3 [v1.2] Live updates

VS Code caches a `TextDocumentContentProvider` document until `onDidChange` fires. Commit-SHA sides stay cached for the window (immutable). Live sides are **not** cached as immutable content.

While a live URI is open:

- `worktree`: a file watcher on that path fires `onDidChange` on save, create, or delete.
- `HEAD`, `staged`, `stash`: the Git extension's repository state change fires `onDidChange`.

Do not poll, and do not run git on a timer. If no live URI is open, do not watch. Re-resolve the live token on each `provideTextDocumentContent`; do not reuse a SHA captured at click time.

## 7. Architecture

### 7.1 Components

| Component | Responsibility |
|---|---|
| `UriHandler` | Entry point for `vscode://…/diff`. Parses params, validates, calls the opener. |
| `Validator` | Pure functions for §5.1 rules. No VS Code imports, unit-testable. |
| `RepoResolver` | Maps `repo` name → `Repository` from the built-in Git extension API. |
| `GitReader` | Wraps git calls (`cat-file`, `rev-parse`, `show`). Uses `execFile` with argument arrays only. No shell. **[v1.2]** Also `rev-parse --verify --end-of-options` for `HEAD` and `stash@{n}`, index pathspecs, and `diff --no-index` for partial diffs that lack blob oids. |
| `CommitContentProvider` | `TextDocumentContentProvider` for the `deep-diff://` scheme. Returns file content for a side, or empty string if the path is absent. **[v1.2]** Live sides re-read and emit `onDidChange`. |
| `DiffOpener` | Builds URIs, calls `vscode.diff`, handles the line reveal. |
| `LinkRewriter` | **[v1.1]** markdown-it plugin that rewrites this extension's link scheme to the running editor's (§5). Pure, unit-testable. |
| `HunkSelector` | **[v1.1]** Pure functions. Parses `-U0` diff output into blocks, merges ranges, selects blocks (§5.2) and builds the synthetic side (§6.1). No VS Code imports, unit-testable. |

### 7.2 Content provider

- Scheme: `deep-diff`.
- URI layout, commit side (unchanged): `deep-diff://<sha40>/<path>?repo=<repo-root-encoded>`. The `authority` is the SHA, `path` is the file path, and the repo root travels in the query so the provider knows which repository to read.
- **[v1.2]** Live side: `deep-diff://<token>/<path>?<json>`. `authority` is `HEAD`, `worktree`, `staged`, or `stash.N` (`N` is 0–99; `stash` → `stash.0`). Braces are not used in the authority. VS Code treats the authority like a hostname and may lowercase it (`HEAD` → `head`); the provider accepts both. The query JSON still carries `repo` and `git`, and for a synthetic side the two side identities plus `lines`. The URI path stays `/<path>` so language detection works.
- `provideTextDocumentContent(uri)`:
  - Resolves the side as in §6.2 and returns the text, or `""` if absent.
  - Commit SHA: caches by `(repo, sha, path)` for the lifetime of the window. Commits are immutable, so that cache needs no invalidation.
  - **[v1.2]** Live sides: do not use that immutable cache. Failed reads are still not cached.
- Binary detection: if the output contains a NUL byte in the first 8 KB, return the text `Binary file, cannot display.`
- **[v1.1]** Synthetic side: the URI query carries both sides and the merged ranges, for example `…?{"repo":…,"git":…,"partial":{"left":"<sha40>","right":"<sha40>","lines":"25-30,120-160"}}`. **[v1.2]** `left` / `right` in `partial` are side identities (sha40 or live token), not SHAs only. The cache key includes them for commit-only partials. Live partials recompute. The provider rebuilds the document from the query when a tab is restored. The partial label goes in the diff title: `hooks.ts (fcaac35 (partial) ↔ f756bcd) · lines 25-30`, or `(absent, partial)` for an added or deleted file, or `hooks.ts (HEAD (partial) ↔ worktree) · lines 25-30`.
- **[v1.1]** Ranges are ignored for binary files, submodules and directories. Those sides show their v1 placeholder text.

### 7.3 Git access

- Prefer the built-in Git extension API (`repo.show(ref, path)`, `repo.getCommit(ref)`) where it exists. Fall back to `execFile('git', args, { cwd })` only when the API lacks a method.
- Never build a command string. Always pass arrays. Argument values come from validated input only.
- **[v1.2]** `rev-parse` always includes `--verify --end-of-options`. The following argument is only a validated token (`HEAD^{commit}` or `stash@{n}^{commit}`).
- Timeouts: 10 seconds per git call. Output cap: 10 MB per file.

## 8. Error handling

No error is silently swallowed. Every failure produces:
1. A user-visible notification with a clear message and, where possible, the fix.
2. A log line in the extension's output channel with the full error and the link parameters.

| Code | Condition | Message |
|---|---|---|
| U3 | Commit not in clone | "Commit `<sha>` not found in `<repo>`. Run `git fetch` and try again." |
| U6 | Path absent from both sides | "`<path>` is not present on either side." |
| U8 | No matching workspace folder | "No workspace folder named `<repo>`. Open the review's repository in VS Code." |
| U9 | More than one workspace folder matches | "More than one workspace folder is named `<repo>`. Rename or remove one, then try again." |
| E1 | Invalid parameter | "Invalid link: `<param>` …" (names the parameter, not the value) |
| E2 | git timeout or non-zero exit | "Git failed reading `<side>:<path>`. See the output channel." (`<side>` is the 7-character SHA or the live token) |
| E3 | Git extension not available | "The built-in Git extension is disabled. Enable it to use deep diff links." |
| U11 | **[v1.1]** No change touches the ranges (info, diff still opens) | "No changes in lines `<ranges>` of `<path>`." |
| U18 | **[v1.2]** Stash missing | "Stash `stash@{n}` not found in `<repo>`." |
| U19 | **[v1.2]** `HEAD` missing | "`HEAD` not found in `<repo>`." |

`lines` validation failures use E1, as in "Invalid link: `lines` …". Live-token validation failures use E1 on `left` or `right`.

U6's message changed in v1.2 (was "is not in either commit"). SHA–SHA links use the new wording.

## 9. Security

- The extension runs only when a user clicks a link. It never runs on file open or on a schedule. **[v1.2]** File watchers and Git state listeners run only while a live diff URI is open.
- All parameters are validated before use (§5.1). Anything failing validation is rejected, not sanitized.
- Path traversal is blocked by the validator (no `..`, no absolute paths) and again in `GitReader` by requiring that git receives a relative `<path>`. **[v1.2]** Worktree reads `realpath` the file and require it to stay under the repo root.
- No network access. The extension does not fetch. Users run `git fetch` themselves.
- Sensitive content: the extension only shows content already in the local repository (commits, index, stash objects, or a file inside the repo). It does not write files into the clone or cache to disk outside VS Code's in-memory cache. **[v1.2]** Temp files for `git diff --no-index` live outside the repository and are deleted after the call.
- **[v1.2]** `rev-parse` is not a general ref resolver. Only `HEAD` and `stash@{0}`–`stash@{99}` are passed.

## 10. Packaging and configuration

- Language: TypeScript, bundled with `esbuild`.
- Distribution: internal `.vsix`, built with `vsce package` and shared within the team. No Marketplace publishing in v1.
- Activation: `onUri`. The extension does not activate at startup. **[v1.1]** It also activates on `onLanguage:markdown` (for the source-editor link provider), and when the markdown extension loads its preview plugin. Those activations only register providers and run no git commands.
- Extension dependencies: `vscode.git` (built-in). Declare it as an extension dependency so a missing dependency is reported at install time.
- Settings (v1, minimal):
  - `deepDiffLinks.maxFileBytes` (default `10485760`): above this size, show a notice instead of the diff.

## 11. Testing

Unit tests (no VS Code runtime):
- `Validator`: every rule in §5.1, including rejection of branch names, `..`, absolute paths, uppercase SHAs, 6-character SHAs, and 41-character SHAs.
- `GitReader`: argument arrays are built correctly; timeout and non-zero exit are mapped to E2.
- Binary detection.
- **[v1.1]** `Validator` for `lines`: single line, ranges, unordered and overlapping input, `0`, `5-3`, spaces, empty items (`1,,2`), trailing comma, 51 ranges.
- **[v1.1]** `HunkSelector`: parsing `-U0` headers, including `+c` with no count and `-a,0`/`+c,0`; overlap rules for modifications, additions, and pure deletions at a range edge; a block that straddles a range is kept whole; synthetic left equals right when nothing is selected and equals the real left when everything is selected; ranges clipped past end of file; deleted-file mirror (§6.1).
- **[v1.2]** `Validator` for sides: `HEAD`, `worktree`, `staged`, `stash`, `stash@{0}`, `stash@{99}` accepted; `head`, `HEAD~1`, `main`, `stash@{100}`, `stash@{01}`, `stash@{1.hour.ago}`, `stash^2` rejected. SHA rules unchanged.

Integration tests (`@vscode/test-electron`), using a fixture repo with two known commits:
- Link opens a diff with the expected title and both sides' content (U1, U2).
- Commit missing → U3 notification, no editor opened (U3).
- Added file → empty left side (U4). Deleted file → empty right side (U5).
- Path absent from both → U6.
- Line parameter reveals the expected line (U7).
- Dirty working tree is unchanged after opening a diff.
- Workspace folder not found → U8. Two folders with the same name → U9.
- **[v1.1]** Scheme: the preview renders foreign and own-scheme links with this editor's scheme. In the source editor, the link at the cursor targets this editor's scheme, and "Open Link" (`editor.action.openLink`, the click path) opens the diff. The click step runs under VS Code only, because Cursor's extension-test mode reloads the window when a `cursor://` link opens. Run the suite in Cursor with `CDL_EDITOR=/Applications/Cursor.app/Contents/MacOS/Cursor`.
- **[v1.1]** Fixture with at least three separate change blocks: `lines` covering one block opens a diff whose left document differs from the right only in that block (U10). Ranges with no changes produce U11 and identical sides. Deleted file with `lines` (U12). Range past end of file (U13). The title includes the merged ranges.
- **[v1.2]** Fixture with a dirty worktree, a staged change, and `stash@{0}`: U14–U17 open diffs with the expected titles and content. Missing stash → U18. SHA–SHA links still match v1 content and titles (7-character SHAs). Saving the worktree file updates an open `worktree` diff (U20). `lines` between `HEAD` and `worktree` still filters blocks. After opening a live diff, `git status --porcelain` is unchanged and no extra objects appear under `.git/objects`.

Manual test: click the links in `review-fcaac3532..f756bcd28.md` in the markdown preview and confirm each opens the matching diff.

## 12. Acceptance criteria

- [ ] AC1. Every U-scenario in §4 behaves as listed.
- [ ] AC2. No `git checkout`, `git stash`, or file write is performed in the user's repository. Temp files for `--no-index` are outside the clone and deleted.
- [ ] AC3. A link with a shell metacharacter in any parameter is rejected with E1 and runs nothing.
- [ ] AC4. The diff editor is the built-in one (`vscode.diff`), and the extension contributes no webview.
- [ ] AC5. All error paths in §8 show a notification and a log entry.
- [ ] AC6. Unit and integration tests pass in CI on Linux, macOS and Windows.
- [ ] AC7. The `.vsix` installs on a clean VS Code, and the links in the review open diffs with no setup beyond `vscode.git` being enabled.
- [ ] AC8. **[v1.1]** A link without `lines` behaves exactly as in v1 (same title, same content, same cache entries).
- [ ] AC9. **[v1.1]** With `lines`, the diff editor highlights only the selected blocks, and a synthetic side is always labelled as partial.
- [x] AC10. **[v1.2]** A SHA–SHA link is unchanged from v1.1 (title still uses 7-character SHAs, content and cache keys unchanged).
- [x] AC11. **[v1.2]** Live sides re-read on `onDidChange`; an open `worktree` diff updates on save (U20).
- [x] AC12. **[v1.2]** The worktree side is not a `file://` URI and is not editable.

## 13. Decisions

Resolved on review. These replace the earlier open questions.

1. **Distribution.** Internal only, as a `.vsix` file shared within the team. No Marketplace listing for v1. The publisher name is still a placeholder in the link format (§5) until the `.vsix` is built.
2. **Multi-root workspaces.** The `repo` parameter must match exactly one workspace folder by basename. If zero match, U8. If two or more match, U9 (below) and nothing opens.
3. **Large diffs.** The default `deepDiffLinks.maxFileBytes` of 10 MB (§10) is accepted.
4. **Remote commit fetch.** Out of scope. The extension stays offline (§9). The U3 message tells the user to run `git fetch`.
5. **Link scope.** v1 is file-centric: one link opens one file's diff. Multi-file views for a commit pair are not in v1.

Consequences for the sections above:
- §5.1 `repo` rule: unique match required.
- §8 adds U9: "More than one workspace folder is named `<repo>`. Rename or remove one, then try again."
- §10 packaging: build a `.vsix` with `vsce package`. No Marketplace publishing step.
- §12 AC7 (new): the `.vsix` installs on a clean VS Code and the links in the review open diffs without any other setup beyond `vscode.git` being enabled.

### 13.1 [v1.1] Partial diffs

6. **Filter, not emphasis.** "Partial" means changes outside the ranges are hidden: they show as unchanged. The alternative, a full diff with the ranges merely highlighted on top, was rejected because it doesn't reduce what the reviewer has to read.
7. **New parameter `lines`, not an extended `line`.** `line` keeps its v1 meaning (scroll only), so existing links don't change behaviour.
8. **Whole blocks.** A block is shown whole if it overlaps a range. Splitting blocks at range edges would show diffs that never existed between the two commits.
9. **Right side by default.** Ranges refer to the new file, except for a deleted file.
10. **Block boundaries come from `git diff -U0`.** This avoids bundling a diff library. VS Code's own diff of the synthetic side may draw block edges slightly differently, which is acceptable.
11. **Added and deleted files select lines, not blocks** (§6.1). Otherwise any range would select the whole file.
12. **Scheme rewriting in the preview and the source editor** (§5). One review file works in VS Code and Cursor.

### 13.2 Rename (0.3.0)

13. **Renamed to Deep Diff Links.** The extension id, link address, setting key (`deepDiffLinks.maxFileBytes`), output channel and internal scheme (`deep-diff://`) all changed. A display-name-only rename would have left `commit-diff-links` in every link. At the time, links using the former id were rewritten to the new one in Markdown (§5). That support was later dropped (decision 14).

14. **Publisher `oliviercado` (0.4.0).** The extension id is `oliviercado.deep-diff-links`. The source repository is https://github.com/Gwened/deep-diff-links. Former ids are no longer rewritten, so links must use the current id. The rewriting mechanism stays (`LEGACY_IDS` in `src/extension.ts`, empty) in case the id changes again.

### 13.3 [v1.2] Live sides

15. **Keywords in `left` / `right`, not extra parameters.** `path` stays the file. The side token chooses the copy (commit, `HEAD`, index, disk, stash).
16. **Live only; no snapshot.** A URL cannot freeze worktree or index bytes. Open diffs refresh. Commit SHAs remain immutable.
17. **`HEAD` is in, branches and tags stay out.** `HEAD` is the one moving commit ref worth supporting (uncommitted vs tip). `main` and tags are still E1 so review links cannot silently retarget.
18. **Stash is the WIP tree.** `stash` / `stash@{n}` read `stash@{n}:path`, then `^3` if needed for `git stash -u`. The index-at-stash-time tree (`^2`) is out of scope.
19. **`stash@{n}` in the link, `stash.N` in the `deep-diff://` authority.** Braces are encoded in markdown URLs and are invalid as a URI authority. `n` is 0–99.
20. **No object-db writes.** Partial diffs that lack blob oids use `git diff --no-index` and temp files outside the clone.
21. **Worktree matches `git diff`, not the editor buffer.** Clean filters / CRLF apply. Not `file://`, so the side is not editable (G4, non-goals).

## 14. Milestones

1. Validator and URI parsing, with unit tests.
2. GitReader and CommitContentProvider, with unit tests on a fixture repo.
3. DiffOpener and UriHandler, wired end to end. Manual test on a real review file.
4. Integration test suite and error messages (§8).
5. Packaging, CI, and a README showing the link format.
6. **[v1.1]** `lines` validation and `HunkSelector`, with unit tests.
7. **[v1.1]** Synthetic side in the content provider, partial titles, U11, and integration tests (U10–U13).
8. **[v1.2]** Side tokens in the validator; `HEAD` / `staged` / `stash` / `worktree` reads in `GitReader`; live URIs; U14–U19, U21–U22.
9. **[v1.2]** `onDidChange` for live sides (U20), `diff --no-index` for partial live diffs, AC10–AC12.
