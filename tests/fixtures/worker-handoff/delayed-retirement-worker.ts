import { loadWorker } from './load-worker';

const schedule = self.setTimeout.bind(self);
// Model delivery of an RPC error before the retirement timer's task runs.
self.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) =>
  schedule(handler, delay === 0 && typeof handler === 'function' && handler.name === 'restart'
    ? 250 : delay, ...args)) as typeof setTimeout;

void loadWorker();
