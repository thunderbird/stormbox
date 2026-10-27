import '../../../src/db/shared-worker';

declare const self: SharedWorkerGlobalScope;
self.addEventListener('connect', ({ ports }) => {
  ports[0].addEventListener('message', ({ data }) => {
    if (data?.type === 'fixture.freeze') {
      ports[0].postMessage({ type: 'fixture.frozen' });
      // The fixture deliberately prevents both RPC handlers and timers running.
      for (;;) { /* busy */ }
    }
  });
});
