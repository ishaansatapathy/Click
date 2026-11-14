import { ref, type Ref } from 'vue';

/** Wrap an async action with an in-flight flag, so buttons can show a loading state. */
export function useSubmit<T>(fn: () => Promise<T>): { isSubmitting: Ref<boolean>; run: () => Promise<T> } {
  const isSubmitting = ref(false);
  async function run(): Promise<T> {
    isSubmitting.value = true;
    try {
      return await fn();
    } finally {
      isSubmitting.value = false;
    }
  }
  return { isSubmitting, run };
}
