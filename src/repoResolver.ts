import * as path from 'path';
import * as vscode from 'vscode';
import { LinkError, messages } from './errors';
import type { API, GitExtension } from './git';
import { GitReader } from './gitReader';

export interface ResolvedRepo {
  /** Absolute path of the repository root (top level of the work tree). */
  root: string;
  /** Path to the git executable chosen by the Git extension. */
  gitPath: string;
}

const API_INIT_TIMEOUT_MS = 5_000;

export async function getGitApi(): Promise<API> {
  const ext = vscode.extensions.getExtension<GitExtension>('vscode.git');
  if (!ext) throw new LinkError('E3', messages.gitDisabled(), 'vscode.git extension not found');
  let exports: GitExtension;
  try {
    exports = ext.isActive ? ext.exports : await ext.activate();
  } catch (error) {
    throw new LinkError('E3', messages.gitDisabled(), error);
  }
  if (!exports || !exports.enabled) throw new LinkError('E3', messages.gitDisabled(), 'git.enabled is false');
  const api = exports.getAPI(1);
  if (api.state !== 'initialized') {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        sub.dispose();
        resolve();
      }, API_INIT_TIMEOUT_MS);
      const sub = api.onDidChangeState((state) => {
        if (state === 'initialized') {
          clearTimeout(timer);
          sub.dispose();
          resolve();
        }
      });
    });
  }
  return api;
}

/** Workspace folders whose basename equals `name` exactly. */
export function foldersNamed(name: string): readonly vscode.WorkspaceFolder[] {
  return (vscode.workspace.workspaceFolders ?? []).filter((f) => path.posix.basename(f.uri.path) === name);
}

/** Maps the link's `repo` parameter to a repository root (spec §6 step 2, §13.2). */
export async function resolveRepo(name: string): Promise<ResolvedRepo> {
  const matches = foldersNamed(name);
  if (matches.length === 0) throw new LinkError('U8', messages.noFolder(name));
  if (matches.length > 1) {
    throw new LinkError('U9', messages.manyFolders(name), matches.map((f) => f.uri.fsPath));
  }
  const folder = matches[0];

  const api = await getGitApi();
  const gitPath = api.git.path;
  const repo = api.getRepository(folder.uri);
  if (repo) return { root: repo.rootUri.fsPath, gitPath };

  // The Git extension may not have opened this folder (e.g. still scanning). Ask git directly.
  try {
    const root = await new GitReader(gitPath).showToplevel(folder.uri.fsPath);
    if (root) return { root: path.normalize(root), gitPath };
  } catch (error) {
    throw new LinkError('E4', messages.notARepo(name), error);
  }
  throw new LinkError('E4', messages.notARepo(name));
}

function samePath(a: string, b: string): boolean {
  return path.normalize(a) === path.normalize(b);
}

/** Subscribe to Git-extension repo state. `undefined` if this folder is not an open Git repository. */
export async function watchRepoState(root: string, listener: () => void): Promise<vscode.Disposable | undefined> {
  const api = await getGitApi();
  const repo =
    api.getRepository(vscode.Uri.file(root)) ??
    api.repositories.find((r) => samePath(r.rootUri.fsPath, root));
  if (!repo) return undefined;
  return repo.state.onDidChange(listener);
}
