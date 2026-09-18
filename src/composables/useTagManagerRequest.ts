import { ref } from 'vue';

/**
 * Deep surfaces (a tag picker inside a list column, the sidebar's Tags
 * heading) ask for the tag manager dialog through this shared request;
 * the app shell owns the dialog and opens it on each request.
 */
const requested = ref(0);

export function requestTagManager(): void {
  requested.value += 1;
}

export function useTagManagerRequest() {
  return { requested };
}
