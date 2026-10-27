import { IDBBatchAtomicVFS, IDBContext } from '@journeyapps/wa-sqlite/src/examples/IDBBatchAtomicVFS';
import { SQLITE_OPEN_MAIN_DB } from '@journeyapps/wa-sqlite';
import { loadWorker } from './load-worker';

let armed = false;
let pauseNextWrite = false;
let recording = false;
let resume: (() => void) | undefined;
const ports = new Set<MessagePort>();
const events: Array<Record<string, unknown>> = [];
const vfs = IDBBatchAtomicVFS.prototype as any;
const write = vfs.jWrite;

// Insert the pause into the IDB queue without changing the VFS callback kind.
vfs.jWrite = function (...args: any[]) {
  const file = this.mapIdToFile.get(args[0]);
  if (armed && (file.flags & SQLITE_OPEN_MAIN_DB)) {
    armed = false;
    pauseNextWrite = true;
  }
  return write.apply(this, args);
};

const queue = IDBContext.prototype.q;
IDBContext.prototype.q = function (...args: any[]) {
  if (pauseNextWrite) {
    pauseNextWrite = false;
    queue.call(this, async () => {
      await new Promise<void>(resolve => {
        resume = resolve;
        for (const port of ports) port.postMessage({ type: 'fixture.before-main-write' });
      });
    }, args[1], args[2]);
  }
  return queue.apply(this, args);
};

for (const method of ['jRead', 'jWrite', 'jSync', 'jUnlock', 'jFileControl']) {
  const original = vfs[method];
  const record = (instance: any, phase: string, args: any[]) => {
    if (!recording) return;
    const file = instance.mapIdToFile.get(args[0]);
    events.push({ method, phase, file: file?.path, arg: typeof args[1] === 'number' ? args[1] : undefined });
  };
  // FacadeVFS detects AsyncFunction when registering SQLite callbacks.
  vfs[method] = original.constructor.name === 'AsyncFunction' ? async function (...args: any[]) {
    record(this, 'start', args);
    const result = await original.apply(this, args);
    record(this, 'end', args);
    return result;
  } : function (...args: any[]) {
    record(this, 'start', args);
    const result = original.apply(this, args);
    record(this, 'end', args);
    return result;
  };
}
const sync = IDBContext.prototype.sync;
IDBContext.prototype.sync = async function (durable: boolean) {
  if (recording) events.push({ method: 'IDBContext.sync', phase: 'start', durable });
  const result = await sync.call(this, durable);
  if (recording) events.push({ method: 'IDBContext.sync', phase: 'end', durable });
  return result;
};

await loadWorker(port => {
  ports.add(port);
  port.addEventListener('message', ({ data }) => {
    if (data?.type === 'fixture.arm-write') {
      armed = true;
      recording = true;
      events.length = 0;
      port.postMessage({ type: data.type });
    }
    if (data?.type === 'fixture.resume-write') resume?.();
    if (data?.type === 'fixture.storage-events') port.postMessage({ type: data.type, events });
  });
});
