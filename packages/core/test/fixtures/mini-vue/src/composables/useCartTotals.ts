import { computed } from 'vue';
import { useCartStore } from '@/stores/cart';
import { useFormat } from './useFormat';

/** A composable that depends on a store and on another composable (multi-hop edges). */
export function useCartTotals() {
  const cart = useCartStore();
  const { price } = useFormat();
  const subtotal = computed(() => cart.items.reduce((s, i) => s + i.price * i.qty, 0));
  return { subtotal, label: computed(() => price(subtotal.value)) };
}
