<script setup lang="ts">
import { RouterLink, RouterView } from 'vue-router';
import { useCartStore } from '@/stores/cart';

const cart = useCartStore();
</script>

<template>
  <header>
    <RouterLink to="/">Shop</RouterLink>
    <RouterLink to="/checkout">Checkout ({{ cart.count }})</RouterLink>
  </header>
  <RouterView />
</template>
