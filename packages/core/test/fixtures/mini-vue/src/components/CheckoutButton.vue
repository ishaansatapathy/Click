<script setup lang="ts">
import { storeToRefs } from 'pinia';
import { BaseButton } from '@/components';
import { useSubmit } from '@/composables/useSubmit';
import { useOrderStore } from '@/stores/order';

const emit = defineEmits(['submitted']);
const order = useOrderStore();
const { total } = storeToRefs(order);
const { isSubmitting, run } = useSubmit(() => order.submitOrder());

async function onClick(): Promise<void> {
  await run();
  emit('submitted');
}
</script>

<template>
  <BaseButton label="Place order" :loading="isSubmitting" :disabled="total === 0" @click="onClick" />
</template>
