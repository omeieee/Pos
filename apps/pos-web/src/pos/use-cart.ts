import { useServices } from '../ui/hooks.ts';
import type { CartMode, CartStore } from './cart-store.ts';

/** The cart of the screen: the counter's, or the one for Grab and LINE MAN orders keyed in by hand. */
export function useCart(mode: CartMode = 'storefront'): CartStore {
  const { cart, platformCart } = useServices();
  return mode === 'platform' ? platformCart : cart;
}
