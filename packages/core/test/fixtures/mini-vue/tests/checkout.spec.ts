import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it } from 'vitest';
import CheckoutButton from '@/components/CheckoutButton.vue';
import { useOrderStore } from '@/stores/order';

describe('CheckoutButton', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('is disabled when the order total is zero', () => {
    useOrderStore();
    const wrapper = mount(CheckoutButton);
    expect(wrapper.find('button').attributes('disabled')).toBeDefined();
  });
});
