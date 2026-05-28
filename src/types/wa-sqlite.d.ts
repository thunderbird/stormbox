/**
 * Local augmentation for `@journeyapps/wa-sqlite`.
 *
 * The package ships a `.d.ts` for `IDBBatchAtomicVFS` that pre-dates
 * the static async `create()` factory the runtime code actually
 * exposes (see `node_modules/@journeyapps/wa-sqlite/src/examples/IDBBatchAtomicVFS.js`,
 * which defines `static async create(name, module, options)`). The
 * shipped type only declares a constructor and is missing the
 * factory, so `IDBBatchAtomicVFS.create(...)` fails with
 * `TS2339: Property 'create' does not exist on type 'typeof IDBBatchAtomicVFS'`
 * even though the runtime call is correct.
 *
 * TypeScript merges a `namespace` with a `class` of the same name to
 * add static members. We declare a matching namespace inside the
 * module so the static `create` factory becomes visible without
 * having to redeclare the entire class shape. Remove when upstream
 * `@journeyapps/wa-sqlite` ships an updated declaration that
 * matches its current runtime API.
 */

declare module '@journeyapps/wa-sqlite/src/examples/IDBBatchAtomicVFS.js' {
  export interface IDBBatchAtomicVFSOptions {
    /**
     * Web Locks API policy controlling whether this VFS holds an
     * exclusive or shared lock on the underlying database name.
     * Stormbox uses `'exclusive'` because the SharedWorker is the
     * only writer per origin and we want to avoid the per-call lock
     * churn that `'shared'` causes.
     */
    lockPolicy?: 'exclusive' | 'shared';
    /**
     * Optional override for the IndexedDB database name. Defaults
     * to the VFS `name` argument when omitted.
     */
    idbName?: string;
  }

  export namespace IDBBatchAtomicVFS {
    /**
     * Async factory matching the runtime API in the JS source. The
     * factory constructs the VFS and awaits its internal
     * `isReady()` so SQLite never sees a half-initialised handle.
     */
    function create(
      name: string,
      module: unknown,
      options?: IDBBatchAtomicVFSOptions,
    ): Promise<import('@journeyapps/wa-sqlite/src/examples/IDBBatchAtomicVFS').IDBBatchAtomicVFS>;
  }
}
