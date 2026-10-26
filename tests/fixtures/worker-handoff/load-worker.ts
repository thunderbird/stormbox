/** Retain connect events while installing instrumentation before the real entry. */
export async function loadWorker(onConnect?: (port: MessagePort) => void) {
  const scope = self as unknown as SharedWorkerGlobalScope;
  const pending: MessagePort[][] = [];
  const capture = (event: MessageEvent) => {
    pending.push([...event.ports]);
    event.stopImmediatePropagation();
  };
  scope.addEventListener('connect', capture);
  await import('../../../src/db/shared-worker');
  scope.removeEventListener('connect', capture);
  if (onConnect) scope.addEventListener('connect', ({ ports }) => onConnect(ports[0]));
  for (const ports of pending) scope.dispatchEvent(new MessageEvent('connect', { ports }));
}
