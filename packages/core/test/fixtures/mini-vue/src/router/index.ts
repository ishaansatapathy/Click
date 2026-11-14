import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import HomeView from '@/views/HomeView.vue';

export const routes: RouteRecordRaw[] = [
  { path: '/', name: 'home', component: HomeView },
  {
    path: '/orders',
    name: 'orders',
    component: () => import('@/views/OrdersView.vue'),
    children: [
      // Nested + lazy: full path is /orders/:id
      { path: ':id', name: 'order-detail', component: () => import('@/views/OrderDetailView.vue') },
    ],
  },
  { path: '/checkout', name: 'checkout', component: () => import('@/views/CheckoutView.vue') },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
});
