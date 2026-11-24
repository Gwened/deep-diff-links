# Changelog

All notable changes to Deep Diff Links are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [0.5.0] - 2026-11-24

### Added
- **Live sides.** `left` and `right` may be `HEAD`, `worktree`, `staged`, `stash`, or `stash@{0}`–`stash@{99}` as well as a commit SHA. Open diffs refresh when that side changes (for example after saving the worktree file).

### Changed
- A path missing from both sides now says it is not present on either *side* (not either *commit*).

## [0.4.1] - 2026-11-24

### Changed
- Visual Studio Marketplace and Open VSX packages now ship store-specific README and changelog files. The GitHub README is no longer packed into either VSIX.

## [0.4.0] - 2026-11-22

### Changed
- **Publisher is now `oliviercado`.** The extension ID is `oliviercado.deep-diff-links`, so links start with `vscode://oliviercado.deep-diff-links/diff?…`. Uninstall the previous extension before installing this one.

### Removed
- Links using earlier extension IDs are no longer rewritten. Update them to `oliviercado.deep-diff-links`.

## [0.3.1] - 2026-11-22

### Added
- Icon, MIT license, `AUTHORS`, repository metadata and this changelog.

### Changed
- The `.vsix` now ships the license, changelog and icon. It still excludes sources, tests and source maps.

## [0.3.0] - 2026-11-22

### Changed
- **Renamed from Commit Diff Links to Deep Diff Links.** The extension ID and link address changed from `<publisher>.commit-diff-links` to `<publisher>.deep-diff-links`. The setting is now `deepDiffLinks.maxFileBytes`, and the output channel is "Deep Diff Links".

### Deprecated
- Links using the old address still worked when clicked in Markdown (preview or source editor), where they were rewritten to the new ID. Removed in 0.4.0.

## [0.2.1] - 2026-11-22

### Fixed
- In the Markdown source editor, a link written with another editor's scheme (`vscode://` in Cursor, `cursor://` in VS Code) now opens the diff. Previously it failed with `EntryNotFound` or `Unable to resolve resource`.

## [0.2.0] - 2026-11-22

### Added
- **Partial diffs.** `lines=25-30,120-160` highlights only the change blocks that touch those lines. Other changes show as unchanged. Added and deleted files select individual lines.
- Info notice when no change touches the requested lines.
- The Markdown preview rewrites link schemes to the running editor, so `cursor://` links work in VS Code.

## [0.1.0] - 2026-11-22

### Added
- `vscode://…/diff` links open the built-in diff editor for one file between two commits, without checking anything out or touching the working tree.
- `line` parameter to scroll to a line.
- Strict validation of every link parameter. Shell metacharacters, path traversal and branch names are rejected.
- Clear error messages for a missing commit, a missing path, an unknown or ambiguous workspace folder, git failures, and a disabled Git extension.
- Placeholder text for binary files, submodules and directories, and a size limit (`maxFileBytes`).

[0.5.0]: https://github.com/Gwened/deep-diff-links/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/Gwened/deep-diff-links/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/Gwened/deep-diff-links/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/Gwened/deep-diff-links/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/Gwened/deep-diff-links/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/Gwened/deep-diff-links/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/Gwened/deep-diff-links/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Gwened/deep-diff-links/releases/tag/v0.1.0
