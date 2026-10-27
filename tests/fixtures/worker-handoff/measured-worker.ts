import { loadWorker } from './load-worker';

let requests = 0;
const request = navigator.locks.request.bind(navigator.locks);
navigator.locks.request = ((...args) => { requests++; return request(...args); }) as typeof request;
await loadWorker((port) => {
  port.addEventListener('message', ({ data }) => {
    if (data?.type === 'fixture.lock-count') port.postMessage({ type: data.type, requests });
  });
});
