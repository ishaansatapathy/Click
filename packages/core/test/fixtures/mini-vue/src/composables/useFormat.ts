import { formatPrice } from '@/utils/money';

export const useFormat = () => {
  const price = (minor: number) => formatPrice(minor);
  return { price };
};
