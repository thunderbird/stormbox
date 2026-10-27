import { createApp, h, ref } from 'vue';
import { createPinia } from 'pinia';
import '@thunderbirdops/services-ui/style.css';
import '../../../src/assets/styles.css';
import LoginGate from '../../../src/components/LoginGate.vue';
import { connectRepository } from '../../../src/db/repository';
import { useAuthStore } from '../../../src/stores/auth-store';
import { AUTH_STATE } from '../../../src/constants/states';
import { BROADCAST_CHANNEL } from '../../../src/db/protocol';
import productionWorkerUrl from '../../../src/db/shared-worker.ts?sharedworker&url';
import frozenWorkerUrl from './frozen-worker.ts?sharedworker&url';
import legacyWorkerUrl from './legacy-worker.ts?sharedworker&url';
import measuredWorkerUrl from './measured-worker.ts?sharedworker&url';
import silentWorkerUrl from './silent-worker.ts?sharedworker&url';
import delayedRetirementWorkerUrl from './delayed-retirement-worker.ts?sharedworker&url';
import storageProbeWorkerUrl from './storage-probe-worker.ts?sharedworker&url';

const query = new URLSearchParams(location.search);
const version = query.get('version') || 'one';
const workerUrl = new URL(query.has('storage-probe') ? storageProbeWorkerUrl : query.has('delay-retirement') ? delayedRetirementWorkerUrl : query.has('silent') ? silentWorkerUrl : query.has('measure') ? measuredWorkerUrl : query.has('legacy') ? legacyWorkerUrl
  : query.has('frozen') ? frozenWorkerUrl : productionWorkerUrl, location.href);
workerUrl.searchParams.set('fixture-version', version);
const connected = ref(false);
const pinia = createPinia();
const app = createApp({ render: () => connected.value ? h('p', { 'data-connected': '' }, 'Database connected') : h(LoginGate) });
app.use(pinia);
const auth = useAuthStore(pinia);
auth.status = AUTH_STATE.CONNECTING;
app.mount('#app');

const worker = new SharedWorker(workerUrl, { type: 'module', name: 'stormbox-db' });
worker.addEventListener('error', (error: ErrorEvent) => { console.error('Fixture worker failed:', error.message); });
(window as any).testWorker = worker;
(window as any).testChannelName = BROADCAST_CHANNEL;
(window as any).testReady = connectRepository({
  worker,
  workerUrl: query.has('legacy') ? undefined : workerUrl,
  onWorkerRestart: () => {
    const next = localStorage.getItem('fixture.latestVersion') || version;
    location.replace(`${location.pathname}?version=${encodeURIComponent(next)}`);
  },
}).then((repo) => {
  (window as any).testRepo = repo;
  connected.value = true;
  return true;
}).catch((error) => {
  auth.reportDatabaseError(error);
  return false;
});
