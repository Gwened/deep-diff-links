import { formatSideLabel } from './validator';

/** Error codes from spec §8 (plus E4, see README). */
export type ErrorCode = 'U3' | 'U6' | 'U8' | 'U9' | 'U18' | 'U19' | 'E1' | 'E2' | 'E3' | 'E4' | 'SIZE';

/** A side-read failure that is not a generic git crash (symlink escape, missing HEAD/stash). */
export class SideReadError extends Error {
  constructor(
    readonly code: 'E1' | 'U18' | 'U19',
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'SideReadError';
  }
}

/**
 * A failure that must be shown to the user. `message` is the user-facing text;
 * `detail` is extra context for the output channel only.
 */
export class LinkError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'LinkError';
  }
}

export const short = (sha: string): string => formatSideLabel(sha);

export const messages = {
  commitNotFound: (sha: string, repo: string) =>
    `Commit \`${sha}\` not found in \`${repo}\`. Run \`git fetch\` and try again.`,
  pathInNeither: (path: string) => `\`${path}\` is not present on either side.`,
  noFolder: (repo: string) =>
    `No workspace folder named \`${repo}\`. Open the review's repository in VS Code.`,
  manyFolders: (repo: string) =>
    `More than one workspace folder is named \`${repo}\`. Rename or remove one, then try again.`,
  invalid: (param: string, reason: string) => `Invalid link: \`${param}\` ${reason}.`,
  gitFailed: (side: string, path: string) =>
    `Git failed reading \`${formatSideLabel(side)}:${path}\`. See the output channel.`,
  gitFailedCommit: (sha: string) => `Git failed reading commit \`${sha}\`. See the output channel.`,
  gitDisabled: () =>
    'The built-in Git extension is disabled. Enable it to use deep diff links.',
  notARepo: (repo: string) =>
    `Workspace folder \`${repo}\` is not a git repository.`,
  noChangesInRanges: (ranges: string, path: string) => `No changes in lines \`${ranges}\` of \`${path}\`.`,
  tooLarge: (path: string, side: string, size: number, max: number) =>
    `\`${path}\` at \`${formatSideLabel(side)}\` is ${size} bytes, above the ${max}-byte limit (deepDiffLinks.maxFileBytes). The diff was not opened.`,
  stashNotFound: (stash: string, repo: string) => `Stash \`${stash}\` not found in \`${repo}\`.`,
  headNotFound: (repo: string) => `\`HEAD\` not found in \`${repo}\`.`,
  pathEscapesRepo: () => 'must stay inside the repository',
};
