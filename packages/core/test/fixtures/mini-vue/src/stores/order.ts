import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type { Order } from '@/types/order';
import { sumMinor } from '@/utils/money';

// Setup-style store: state = refs, getters = computed, actions = functions.
export const useOrderStore = defineStore('order', () => {
  const current = ref<Order | null>(null);
  const isSubmitting = ref(false);

  const total = computed(() => sumMinor((current.value?.items ?? []).map((i) => i.price * i.qty)));

  async function submitOrder(): Promise<void> {
    if (!current.value) return;
    isSubmitting.value = true;
    try {
      await fetch('/api/orders', { method: 'POST', body: JSON.stringify(current.value) });
      current.value.status = 'submitted';
    } finally {
      isSubmitting.value = false;
    }
  }

  function load(order: Order): void {
    current.value = order;
  }

  return { current, isSubmitting, total, submitOrder, load };
});
