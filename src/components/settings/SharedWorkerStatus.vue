<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue';

import { getRepositoryAsync } from '../../composables/useRepository';
import type { WorkerStatus } from '../../db/protocol';
import type { MessageContentTimings, Repository } from '../../db/repository';

const worker = ref<WorkerStatus | null>(null);
const responseMs = ref<number | null>(null);
const messageTimings = ref<MessageContentTimings | null>(null);
const failure = ref<string | null>(null);
const resetting = ref(false);
const clock = ref(performance.now());
const checkedAt = ref(clock.value);
const checkingSince = ref<number | null>(null);
const repo = shallowRef<Repository | null>(null);
let lastAttemptAt = clock.value;
let stopped = false;
let timer: ReturnType<typeof setInterval> | null = null;

const uptime = computed(() => {
  if (!worker.value) return 'Checking…';
  let seconds = Math.floor((worker.value.uptimeMs + clock.value - checkedAt.value) / 1000);
  const days = Math.floor(seconds / 86400);
  seconds %= 86400;
  const hours = Math.floor(seconds / 3600);
  seconds %= 3600;
  const minutes = Math.floor(seconds / 60);
  seconds %= 60;
  return [days ? `${days}d` : '', hours || days ? `${hours}h` : '',
    minutes || hours || days ? `${minutes}m` : '', `${seconds}s`].filter(Boolean).join(' ');
});

function duration(ms: number | null | undefined): string {
  if (ms == null) return '—';
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

const response = computed(() => {
  if (checkingSince.value != null && clock.value - checkingSince.value >= 1000) {
    return `Waiting… ${duration(clock.value - checkingSince.value)}`;
  }
  if (responseMs.value != null) return `${duration(responseMs.value)} round trip`;
  return failure.value ? 'Unavailable' : 'Checking…';
});

async function checkWorker() {
  if (!repo.value || stopped || resetting.value || checkingSince.value != null) return;
  checkingSince.value = performance.now();
  try {
    const status = await repo.value.getWorkerStatus();
    if (stopped) return;
    const finishedAt = performance.now();
    responseMs.value = finishedAt - checkingSince.value;
    checkedAt.value = finishedAt;
    clock.value = finishedAt;
    worker.value = status;
    failure.value = null;
  } catch (error) {
    if (!stopped) {
      responseMs.value = null;
      failure.value = error instanceof Error ? error.message : 'Worker status is unavailable.';
    }
  } finally {
    lastAttemptAt = performance.now();
    checkingSince.value = null;
  }
}

async function resetWorker() {
  if (!repo.value || resetting.value) return;
  resetting.value = true;
  failure.value = null;
  try {
    await repo.value.restartWorker();
  } catch (error) {
    if (!stopped) {
      failure.value = error instanceof Error ? error.message : 'The worker could not be reset.';
      resetting.value = false;
    }
  }
}

onMounted(async () => {
  try {
    repo.value = await getRepositoryAsync();
    if (stopped) return;
    messageTimings.value = repo.value.getMessageContentTimings();
    void checkWorker();
    timer = setInterval(() => {
      clock.value = performance.now();
      messageTimings.value = repo.value!.getMessageContentTimings();
      if (clock.value - lastAttemptAt >= 5000) void checkWorker();
    }, 1000);
  } catch (error) {
    if (!stopped) failure.value = error instanceof Error ? error.message : 'Worker status is unavailable.';
  }
});

onBeforeUnmount(() => {
  stopped = true;
  if (timer != null) clearInterval(timer);
});
</script>

<template>
  <section class="worker-status" aria-labelledby="worker-status-title" data-worker-status>
    <div class="settings-dialog__row">
      <span id="worker-status-title" class="settings-dialog__row-title">Shared worker</span>
      <button
        type="button"
        class="settings-dialog__btn"
        :disabled="!repo || resetting"
        :aria-busy="resetting"
        data-reset-worker
        @click="resetWorker"
      >{{ resetting ? 'Resetting…' : 'Reset shared worker' }}</button>
    </div>
    <dl class="worker-status__stats">
      <div><dt>Running for</dt><dd data-worker-uptime>{{ uptime }}</dd></div>
      <div><dt>Responsiveness</dt><dd data-worker-response>{{ response }}</dd></div>
      <div><dt>Message content · latest</dt><dd data-message-latest>{{ duration(messageTimings?.lastMs) }}</dd></div>
      <div><dt>Average / slowest</dt><dd>{{ duration(messageTimings?.averageMs) }} / {{ duration(messageTimings?.slowestMs) }}</dd></div>
      <div v-if="messageTimings?.pending">
        <dt>Loading message content</dt>
        <dd>{{ messageTimings.pending }} pending · {{ duration(messageTimings.oldestPendingMs) }}</dd>
      </div>
    </dl>
    <p class="settings-dialog__row-hint worker-status__hint">
      Reset reloads every open Stormbox tab and may interrupt pending changes. Save draft edits first.
    </p>
    <p v-if="failure" class="settings-dialog__error" role="alert">{{ failure }}</p>
  </section>
</template>

<style scoped>
.worker-status {
  display: grid;
  gap: 10px;
}
.worker-status__stats {
  margin: 0;
  display: grid;
  gap: 6px;
  font-size: 13px;
}
.worker-status__stats > div {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 4px 16px;
}
.worker-status__stats dt {
  color: var(--muted);
}
.worker-status__stats dd {
  margin: 0;
  font-variant-numeric: tabular-nums;
}
.worker-status__hint {
  margin: 0;
}
</style>
