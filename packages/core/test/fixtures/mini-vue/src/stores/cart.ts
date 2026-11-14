import { defineStore } from 'pinia';
import type { OrderItem } from '@/types/order';

// Options-style store with an explicit id field.
export const useCartStore = defineStore({
  id: 'cart',
  state: () => ({ items: [] as OrderItem[] }),
  getters: {
    count: (state) => state.items.reduce((n, i) => n + i.qty, 0),
  },
  actions: {
    addItem(item: OrderItem) {
      this.items.push(item);
    },
    removeItem(sku: string) {
      this.items = this.items.filter((i) => i.sku !== sku);
    },
  },
});
