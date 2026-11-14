<script setup lang="ts">
import { useFormat } from '@/composables/useFormat';
import type { Order } from '@/types/order';

defineProps<{ order: Order }>();
defineSlots<{ footer(): unknown }>();
const { price } = useFormat();
</script>

<template>
  <section class="summary">
    <p v-for="item in order.items" :key="item.sku">{{ item.name }} × {{ item.qty }}: {{ price(item.price * item.qty) }}</p>
    <footer><slot name="footer" /></footer>
  </section>
</template>
