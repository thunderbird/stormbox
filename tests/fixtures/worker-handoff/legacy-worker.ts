import { loadWorker } from './load-worker';

// Emulate a release that uses normal locking and has no ownership protocol.
Object.defineProperty(navigator, 'userAgent', { value: 'Chrome/148.0' });
await loadWorker();
