/**
 * Type declarations for dynamic imports of onnxruntime-web internals.
 *
 * onnxruntime-web is an optional peer dependency.  These declarations
 * satisfy the TypeScript compiler for dynamic JSON import assertions
 * used to auto-detect the installed version at runtime.
 *
 * @module
 * @internal
 */

declare module 'onnxruntime-web/package.json' {
  const pkg: { version: string };
  export default pkg;
}
