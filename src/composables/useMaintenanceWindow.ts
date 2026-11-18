import { useTimeoutFn } from '@vueuse/core';
import { ref } from 'vue';
import { isProdWebmailHostname } from '../defines';

export const THUNDERMAIL_STATUS_URL = 'https://status.tb.pro/';

const startsAt = Date.parse('2026-11-20T01:00:00Z');
const endsAt = Date.parse('2026-11-20T05:00:00Z');
const maxTimeoutMs = 2_147_483_647;

export function useMaintenanceWindow({
  durationMs = endsAt - startsAt,
  paddingMs = 0,
}: { durationMs?: number; paddingMs?: number } = {}) {
  const windowStart = startsAt - paddingMs;
  const windowEnd = startsAt + durationMs + paddingMs;
  const phase = ref<'upcoming' | 'ongoing' | 'ended' | null>(null);
  const { start } = useTimeoutFn(update, () => {
    const boundary = phase.value === 'upcoming' ? windowStart : windowEnd;
    return Math.min(boundary - Date.now(), maxTimeoutMs);
  }, { immediate: false });

  function update() {
    const now = Date.now();
    phase.value = now < windowStart ? 'upcoming' : now < windowEnd ? 'ongoing' : 'ended';
    if (phase.value !== 'ended') start();
  }

  if (isProdWebmailHostname() || import.meta.env.DEV) update();
  return phase;
}
