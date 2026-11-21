import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const target = fileURLToPath(new URL('../src-tauri/resources/server/', import.meta.url));
function npm(args, cwd) {
  const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
    cwd, stdio: 'inherit', shell: process.platform === 'win32',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// The server reads this manifest at runtime to answer GET /api/about, so the
// version must travel with the packaged package.json (lockstep with apps/server).
export function buildServerManifest(server) {
  return {
    name: 'knowlify-desktop-server',
    version: server.version,
    private: true,
    type: 'module',
    dependencies: server.dependencies,
    // Optional native runtime for local embeddings; a failure must not break the app.
    optionalDependencies: server.optionalDependencies ?? {},
  };
}

async function prepare() {
  npm(['run', 'build', '-w', '@knowlify/server'], root);
  await mkdir(target, { recursive: true });
  await rm(join(target, 'dist'), { recursive: true, force: true });
  await cp(join(root, 'apps/server/dist'), join(target, 'dist'), { recursive: true });
  const server = JSON.parse(await readFile(join(root, 'apps/server/package.json'), 'utf8'));
  await writeFile(join(target, 'package.json'), JSON.stringify(buildServerManifest(server), null, 2));
  // Install outside the workspace dependency tree, including the native SQLite and
  // embedding modules. Optional packages stay optional: the server falls back to
  // lexical search when they cannot be installed.
  npm(['install', '--omit=dev', '--include=optional', '--workspaces=false'], target);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await prepare();
}
