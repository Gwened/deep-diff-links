/** Minimal subset of the built-in Git extension API (vscode.git, API version 1). */
import { Event, Uri } from 'vscode';

export type APIState = 'uninitialized' | 'initialized';

export interface RepositoryState {
  readonly onDidChange: Event<void>;
}

export interface Repository {
  readonly rootUri: Uri;
  readonly state: RepositoryState;
}

export interface API {
  readonly state: APIState;
  readonly onDidChangeState: Event<APIState>;
  readonly git: { readonly path: string };
  readonly repositories: Repository[];
  getRepository(uri: Uri): Repository | null;
}

export interface GitExtension {
  readonly enabled: boolean;
  readonly onDidChangeEnablement: Event<boolean>;
  getAPI(version: 1): API;
}
