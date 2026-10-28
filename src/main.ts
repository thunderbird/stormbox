import { createApp } from 'vue';
import { createPinia } from 'pinia';

import { i18n } from './i18n';
import App from './App.vue';
// services-ui tokens/components first; our own styles win collisions
// because they live on :root (higher specificity than services-ui's html).
import '@thunderbirdops/services-ui/style.css';
import '@vuepic/vue-datepicker/dist/main.css';
import './assets/styles.css';
import './assets/bolt-theme.css';

const app = createApp(App);
app.use(createPinia());
app.use(i18n);
app.mount('#app');
