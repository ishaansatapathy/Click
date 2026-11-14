export interface OrderItem {
  sku: string;
  name: string;
  price: number;
  qty: number;
}

export interface Order {
  id: string;
  items: OrderItem[];
  status: 'draft' | 'submitted' | 'paid';
}

export type OrderStatus = Order['status'];
