import { createApp } from 'vue';
import { createPinia } from 'pinia';
import '@thunderbirdops/services-ui/style.css';
import '../../../src/assets/styles.css';
import App from '../../../src/App.vue';
import { useAuthStore } from '../../../src/stores/auth-store';
import { DatabaseUnavailableError } from '../../../src/db/availability';
import { __setRepositoryForTests } from '../../../src/composables/useRepository';

const pinia = createPinia();
const auth = useAuthStore(pinia);
const ready = new Promise((resolve, reject) => {
  (window as any).testSettleDatabase = (fail: boolean) => {
    if (fail) reject(new DatabaseUnavailableError());
    else resolve({ subscribe: () => () => {} });
  };
});
__setRepositoryForTests(ready);
(window as any).testAuth = auth;
createApp(App).use(pinia).mount('#app');
