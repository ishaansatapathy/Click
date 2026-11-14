<script setup lang="ts">
const props = withDefaults(defineProps<{ label?: string; disabled?: boolean; loading?: boolean }>(), {
  label: '',
  disabled: false,
  loading: false,
});
const emit = defineEmits<{ (e: 'click', ev: MouseEvent): void }>();
</script>

<template>
  <button :disabled="props.disabled || props.loading" @click="emit('click', $event)">
    <span v-if="props.loading" class="spinner" />
    <slot>{{ props.label }}</slot>
  </button>
</template>
