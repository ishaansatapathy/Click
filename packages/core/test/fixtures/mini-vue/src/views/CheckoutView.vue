<script setup lang="ts">
import { useRouter } from 'vue-router';
import CheckoutButton from '@/components/CheckoutButton.vue';
import { useOrderStore } from '@/stores/order';

const order = useOrderStore();
const router = useRouter();

function onSubmitted(): void {
  void router.push({ name: 'order-detail', params: { id: order.current?.id ?? '' } });
}
</script>

<template>
  <OrderSummary v-if="order.current" :order="order.current">
    <template #footer>
      <CheckoutButton @submitted="onSubmitted" />
    </template>
  </OrderSummary>
</template>
