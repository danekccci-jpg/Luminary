/**
 * Ambient type shim — tree-kill ships JS + optional types inconsistently across versions.
 */
declare module 'tree-kill' {
  function treeKill(
    pid: number,
    signal?: string | number,
    callback?: (error?: Error) => void
  ): void;
  export = treeKill;
}
