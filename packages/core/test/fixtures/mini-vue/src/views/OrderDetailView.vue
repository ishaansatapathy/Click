<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { useOrderStore } from '@/stores/order';

const route = useRoute();
const order = useOrderStore();
const isCurrent = computed(() => order.current?.id === route.params.id);
</script>

<template>
  <OrderSummary v-if="isCurrent && order.current" :order="order.current" />
  <p v-else>Order {{ route.params.id }} not loaded.</p>
</template>
