import { createApp } from 'vue';
import { createPinia } from 'pinia';

import App from './App.vue';
// services-ui tokens/components first; our own styles win collisions
// because they live on :root (higher specificity than services-ui's html).
import '@thunderbirdops/services-ui/style.css';
import './assets/styles.css';

const app = createApp(App);
app.use(createPinia());
app.mount('#app');
