import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';
import { applyLiveWorkspace, createFixtureRepo } from '../fixtureRepo';

async function main() {
  // When launched from inside VS Code, this leaks in and makes the test instance start as plain Node.
  delete process.env.ELECTRON_RUN_AS_NODE;
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cdl-int-')));
  try {
    const fx = createFixtureRepo(path.join(tmp, 'ws', 'fixture'));
    applyLiveWorkspace(fx.root);
    // Two folders sharing a basename (U9).
    fs.mkdirSync(path.join(tmp, 'one', 'dup'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'two', 'dup'), { recursive: true });

    const workspaceFile = path.join(tmp, 'test.code-workspace');
    fs.writeFileSync(
      workspaceFile,
      JSON.stringify({
        folders: [{ path: fx.root }, { path: path.join(tmp, 'one', 'dup') }, { path: path.join(tmp, 'two', 'dup') }],
        settings: { 'git.openRepositoryInParentFolders': 'never', 'deepDiffLinks.maxFileBytes': 3600 },
      }),
    );

    // Pre-approve the URI handler so "Allow extension to open this URI?" doesn't block tests
    // that go through the real link opener.
    const userData = path.join(tmp, 'user-data');
    fs.mkdirSync(path.join(userData, 'User'), { recursive: true });
    fs.writeFileSync(
      path.join(userData, 'User', 'settings.json'),
      JSON.stringify({ 'extensions.confirmedUriHandlerExtensionIds': ['oliviercado.deep-diff-links'] }),
    );

    // CDL_EDITOR=/Applications/Cursor.app/Contents/MacOS/Cursor runs the suite in Cursor instead of VS Code.
    const executable = process.env.CDL_EDITOR;

    await runTests({
      ...(executable ? { vscodeExecutablePath: executable } : {}),
      extensionDevelopmentPath: path.resolve(__dirname, '../../..'),
      extensionTestsPath: path.resolve(__dirname, './suite/index'),
      launchArgs: [workspaceFile, `--user-data-dir=${userData}`, '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes'],
      extensionTestsEnv: { CDL_FIXTURE: JSON.stringify(fx), CDL_TMP: tmp, CDL_GREP: process.env.CDL_GREP ?? '' },
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('Integration tests failed', error);
  process.exit(1);
});
