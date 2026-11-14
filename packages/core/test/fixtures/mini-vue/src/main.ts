import { createPinia } from 'pinia';
import { createApp } from 'vue';
import App from './App.vue';
import { BaseButton } from '@/components';
import { router } from './router';

const app = createApp(App);
app.use(createPinia());
app.use(router);
// Globally registered: usable as <BaseButton> in any template without an import.
app.component('BaseButton', BaseButton);
app.mount('#app');
