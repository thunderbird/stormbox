declare const self: SharedWorkerGlobalScope;
self.addEventListener('connect', ({ ports }) => ports[0].start());
export {};
