export interface OrderItem {
  sku: string;
  unitPrice: number;
  quantity: number;
}

export interface CreateOrderInput {
  customerId: string;
  items: OrderItem[];
  promoCode?: string;
}

export interface Order {
  id: string;
  customerId: string;
  items: OrderItem[];
  promoCode: string | null;
  subtotal: number;
  discountAmount: number;
  tax: number;
  shipping: number;
  total: number;
  createdAt: string;
}
