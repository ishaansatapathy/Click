<script lang="ts">
// Options API component: props and emits declared as options, not macros.
import { defineComponent, type PropType } from 'vue';
import type { OrderItem } from '@/types/order';

export default defineComponent({
  name: 'CartItem',
  props: {
    item: { type: Object as PropType<OrderItem>, required: true },
  },
  emits: ['remove'],
});
</script>

<template>
  <li>
    {{ item.name }} × {{ item.qty }}
    <button @click="$emit('remove', item.sku)">Remove</button>
  </li>
</template>
