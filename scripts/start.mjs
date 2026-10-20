// Build the TEST flavour (dist-test/, with the self-test and the other test hooks), then start it in Electron.
// Extra arguments go to the app: npm start -- --self-test
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAll } from './build.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const electronPath = createRequire(import.meta.url)('electron');

await buildAll({ flavour: 'test' });
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE; // would turn Electron into plain Node
const child = spawn(electronPath, [path.join(root, 'dist-test'), ...process.argv.slice(2)], { stdio: 'inherit', env });
child.on('exit', (code) => process.exit(code ?? 0));
