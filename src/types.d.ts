// esbuild's "binary" loader: importing a .png gives its bytes as a Uint8Array.
declare module '*.png' {
  const bytes: Uint8Array;
  export default bytes;
}

// esbuild define (scripts/build.mjs): true only in the TEST flavour of the app, false in the release build.
declare const __SAREEA_TEST_HOOKS__: boolean;
