/**
 * Browser integration constants and pure helpers shared by the app (Settings buttons), the host build and
 * the tests: host name, the one extension ID we trust, the host manifest, the registry keys. No Electron,
 * no I/O. The host itself is host/SareeaHost.cs; its constants are generated from this file.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';

export const HOST_NAME = 'com.sareea.dl';

/** The native-messaging host program (host/SareeaHost.cs), installed next to the app exe. */
export const HOST_EXE_NAME = 'sareea-dl-host.exe';
export const APP_EXE_NAME = 'Sareea DL.exe';

/**
 * The extension's stable ID. It is derived from the public key in extension/manifest.json ("key"); a unit
 * test recomputes it from the manifest so the two can never drift apart. The matching private key is in
 * secrets/ (gitignored) and is not needed to run the extension.
 */
export const EXTENSION_ID = 'jiakdemamdonheikpingfkfmgnehjedp';

/** What Chrome and Edge pass to a native host as its first argument: the calling extension's origin. The host accepts only this. */
export const ALLOWED_ORIGIN = `chrome-extension://${EXTENSION_ID}/`;

/** Largest message the host accepts from the browser. */
export const MAX_NATIVE_MESSAGE_BYTES = 1024 * 1024;

export type BrowserKind = 'chrome' | 'edge';
export const BROWSERS: readonly BrowserKind[] = ['chrome', 'edge'];

/** Where each browser looks for per-user native-messaging hosts. The default value is the manifest path. */
export const REGISTRY_KEYS: Record<BrowserKind, string> = {
  chrome: `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`,
  edge: `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${HOST_NAME}`,
};

export interface HostManifest {
  name: string;
  description: string;
  path: string;
  type: 'stdio';
  allowed_origins: string[];
}

/** The JSON file the browsers read. `path` must be absolute; allowed_origins lists only our extension. */
export function buildHostManifest(exePath: string): HostManifest {
  if (!path.win32.isAbsolute(exePath)) throw new Error('the host path must be absolute');
  return {
    name: HOST_NAME,
    description: 'Sareea DL browser integration',
    path: exePath,
    type: 'stdio',
    allowed_origins: [ALLOWED_ORIGIN],
  };
}

export function serializeHostManifest(exePath: string): string {
  return JSON.stringify(buildHostManifest(exePath), null, 2) + '\n';
}

export function hostManifestPath(dataDir: string): string {
  return path.win32.join(dataDir, 'native-messaging', `${HOST_NAME}.json`);
}

/** Extension ID for a public key (SPKI DER, base64): sha256, first 16 bytes, hex digits 0-f mapped to a-p. */
export function extensionIdFromPublicKey(base64Key: string): string {
  const hex = createHash('sha256').update(Buffer.from(base64Key, 'base64')).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode('a'.charCodeAt(0) + parseInt(c, 16))).join('');
}

/**
 * Test hook: when SAREEA_DL_TEST_DIR is set, the app keeps its data there and uses its own pipe name,
 * so an end-to-end test never touches the real profile or a running copy of the app.
 */
export function testDirFromEnv(env: Record<string, string | undefined>): string | null {
  const d = env.SAREEA_DL_TEST_DIR;
  return d && path.win32.isAbsolute(d) ? d : null;
}

export function pipeSuffixForTestDir(dir: string | null): string {
  if (!dir) return '';
  return '-test-' + createHash('sha1').update(dir.toLowerCase()).digest('hex').slice(0, 10);
}
