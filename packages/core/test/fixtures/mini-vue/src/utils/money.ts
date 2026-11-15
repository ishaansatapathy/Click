import type { Order } from '@/types/order';

/** Format an amount in minor units (paise/cents) for display. */
export function formatPrice(minor: number, currency = 'INR'): string {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency }).format(minor / 100);
}

export const sumMinor = (values: number[]): number => values.reduce((a, b) => a + b, 0);

/** Total of an order in minor units. */
export function orderTotal(order: Order): number {
  return sumMinor(order.items.map((i) => i.price * i.qty));
}
