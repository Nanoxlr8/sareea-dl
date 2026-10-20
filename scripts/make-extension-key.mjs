// Generates the extension's signing key pair locally, once.
//   * the PRIVATE key goes to secrets/extension-private-key.pem (gitignored, never committed, never shipped);
//   * the PUBLIC key goes into extension/manifest.json as "key", which gives the extension a stable ID
//     in Chrome and Edge. Only the public key is in the repo.
// Run: node scripts/make-extension-key.mjs        (refuses to overwrite an existing key; use --force to replace it)
// If you replace the key the extension ID changes: also update EXTENSION_ID in src/app/browser-integration.ts
// (a unit test checks that the two agree).
import { createHash, generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pemPath = path.join(root, 'secrets', 'extension-private-key.pem');
const manifestPath = path.join(root, 'extension', 'manifest.json');

/** Extension ID from the public key (SPKI DER): first 16 bytes of its SHA-256, hex digits mapped 0-f -> a-p. */
export function extensionIdFromPublicKeyBase64(b64) {
  const hex = createHash('sha256').update(Buffer.from(b64, 'base64')).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode('a'.charCodeAt(0) + parseInt(c, 16))).join('');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (fs.existsSync(pemPath) && !process.argv.includes('--force')) {
    console.error('secrets/extension-private-key.pem already exists. Use --force to replace it (the extension ID will change).');
    process.exit(1);
  }
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  fs.mkdirSync(path.dirname(pemPath), { recursive: true });
  fs.writeFileSync(pemPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const b64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.key = b64;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log('extension ID:', extensionIdFromPublicKeyBase64(b64));
  console.log('private key written to secrets/extension-private-key.pem (gitignored)');
}
