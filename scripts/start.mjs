// Build, then start the app in Electron. Extra arguments go to the app: npm start -- --self-test
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAll } from './build.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const electronPath = createRequire(import.meta.url)('electron');

await buildAll();
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE; // would turn Electron into plain Node
const child = spawn(electronPath, [root, ...process.argv.slice(2)], { stdio: 'inherit', env });
child.on('exit', (code) => process.exit(code ?? 0));
