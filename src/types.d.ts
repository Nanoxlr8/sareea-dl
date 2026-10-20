// esbuild's "binary" loader: importing a .png gives its bytes as a Uint8Array.
declare module '*.png' {
  const bytes: Uint8Array;
  export default bytes;
}
