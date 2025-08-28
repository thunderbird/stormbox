import { createApp } from "vue";
import { VueQueryPlugin, QueryClient } from "@tanstack/vue-query";
import App from "./App.vue";
import "./assets/styles.css";
import "quill/dist/quill.snow.css";

const app = createApp(App);
const queryClient = new QueryClient();
app.use(VueQueryPlugin, { queryClient });
app.mount("#app");
