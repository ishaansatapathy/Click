<script setup lang="ts">
import { useCartStore } from '@/stores/cart';
import { useCartTotals } from '@/composables/useCartTotals';

const cart = useCartStore();
const { label } = useCartTotals();
</script>

<template>
  <main>
    <!-- CartItem is auto-imported (components.d.ts); no import above. -->
    <ul>
      <cart-item v-for="item in cart.items" :key="item.sku" :item="item" @remove="cart.removeItem" />
    </ul>
    <p>Subtotal: {{ label }}</p>
  </main>
</template>
