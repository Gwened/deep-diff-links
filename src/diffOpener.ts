import * as vscode from 'vscode';
import { CommitContentProvider, PartialRef, SideRef, toUri } from './contentProvider';
import { LinkError, SideReadError, messages } from './errors';
import { FileSide } from './fileAtCommit';
import { PartialPlan } from './hunkSelector';
import { LineRange, formatRanges, formatSideLabel } from './validator';

export interface DiffRequest {
  repoName: string;
  root: string;
  gitPath: string;
  /** `deep-diff://` authority: sha40 or live token. */
  left: string;
  right: string;
  path: string;
  line?: number;
  ranges?: LineRange[];
}

export interface DiffOpened {
  title: string;
  leftUri: vscode.Uri;
  rightUri: vscode.Uri;
  /** [v1.1] Set when the diff opened with an informational notice (U11). */
  notice?: { code: 'U11'; message: string };
}

interface SideLabel {
  id: string;
  absent?: boolean;
  partial?: boolean;
}

function label({ id, absent, partial }: SideLabel): string {
  const tags = [absent && 'absent', partial && 'partial'].filter(Boolean);
  return tags.length ? `${formatSideLabel(id)} (${tags.join(', ')})` : formatSideLabel(id);
}

export function diffTitle(path: string, left: SideLabel, right: SideLabel, ranges?: LineRange[]): string {
  const base = `${path} (${label(left)} ↔ ${label(right)})`;
  return ranges ? `${base} · lines ${formatRanges(ranges)}` : base;
}

export class DiffOpener {
  constructor(
    private readonly provider: CommitContentProvider,
    private readonly maxBytes: () => number,
  ) {}

  private async guard<T>(side: string, path: string, work: Promise<T>): Promise<T> {
    try {
      return await work;
    } catch (error) {
      if (error instanceof LinkError) throw error;
      if (error instanceof SideReadError) throw new LinkError(error.code, error.message, error.detail);
      throw new LinkError('E2', messages.gitFailed(side, path), error);
    }
  }

  /** Reads both sides (validating U6 and size), then opens the built-in diff editor. */
  async open(req: DiffRequest): Promise<DiffOpened> {
    const leftRef: SideRef = { root: req.root, gitPath: req.gitPath, side: req.left, path: req.path };
    const rightRef: SideRef = { ...leftRef, side: req.right };
    const [left, right] = await Promise.all([
      this.guard(req.left, req.path, this.provider.read(leftRef)),
      this.guard(req.right, req.path, this.provider.read(rightRef)),
    ]);

    if (left.kind === 'absent' && right.kind === 'absent') {
      throw new LinkError('U6', messages.pathInNeither(req.path));
    }
    for (const [side, id] of [[left, req.left], [right, req.right]] as const) {
      if (side.kind === 'tooLarge') {
        throw new LinkError('SIZE', messages.tooLarge(req.path, id, side.size, this.maxBytes()));
      }
    }

    let plan: PartialPlan | undefined;
    let partialRef: PartialRef | undefined;
    if (req.ranges) {
      partialRef = { root: req.root, gitPath: req.gitPath, left: req.left, right: req.right, path: req.path, lines: formatRanges(req.ranges, ',') };
      plan = (await this.guard(req.left, req.path, this.provider.readPartial(partialRef))).plan;
    }

    const leftUri = toUri(leftRef, plan?.synthetic === 'left' ? partialRef : undefined);
    const rightUri = toUri(rightRef, plan?.synthetic === 'right' ? partialRef : undefined);
    this.provider.watch(leftUri);
    this.provider.watch(rightUri);
    const title = diffTitle(
      req.path,
      { id: req.left, absent: isAbsent(left), partial: plan?.synthetic === 'left' },
      { id: req.right, absent: isAbsent(right), partial: plan?.synthetic === 'right' },
      plan ? req.ranges : undefined,
    );

    const options: vscode.TextDocumentShowOptions = { preview: true };
    const reveal = req.line ?? plan?.revealLine;
    if (reveal !== undefined) {
      const pos = new vscode.Position(reveal - 1, 0);
      options.selection = new vscode.Range(pos, pos);
    }
    await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title, options);

    if (plan && plan.selectedCount === 0 && req.ranges) {
      const message = messages.noChangesInRanges(formatRanges(req.ranges), req.path);
      void vscode.window.showInformationMessage(message);
      return { title, leftUri, rightUri, notice: { code: 'U11', message } };
    }
    return { title, leftUri, rightUri };
  }
}

const isAbsent = (side: FileSide) => side.kind === 'absent';
