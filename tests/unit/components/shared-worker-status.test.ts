// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';

const { repo, getRepositoryAsync } = vi.hoisted(() => ({
  repo: { getWorkerStatus: vi.fn(), getMessageContentTimings: vi.fn(), restartWorker: vi.fn() },
  getRepositoryAsync: vi.fn(),
}));
vi.mock('../../../src/composables/useRepository', () => ({ getRepositoryAsync }));

import SharedWorkerStatus from '../../../src/components/settings/SharedWorkerStatus.vue';

let wrapper: ReturnType<typeof mount>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(performance, 'now').mockReturnValue(1000);
  getRepositoryAsync.mockResolvedValue(repo);
  repo.getWorkerStatus.mockResolvedValue({ uptimeMs: 90061000, instanceId: 'one' });
  repo.getMessageContentTimings.mockReturnValue({ count: 3, lastMs: 125, averageMs: 210, slowestMs: 1500, pending: 0 });
  repo.restartWorker.mockResolvedValue(undefined);
});

afterEach(() => {
  wrapper?.unmount();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('staff worker status', () => {
  it('shows lifetime, round-trip and message-content timings, and cancels polling on unmount', async () => {
    wrapper = mount(SharedWorkerStatus);
    await flushPromises();
    expect(wrapper.get('[data-worker-uptime]').text()).toBe('1d 1h 1m 1s');
    expect(wrapper.get('[data-worker-response]').text()).toBe('0 ms round trip');
    expect(wrapper.get('[data-message-latest]').text()).toBe('125 ms');
    expect(wrapper.text()).toContain('210 ms / 1.50 s');
    expect(wrapper.find('[data-reset-worker]').exists()).toBe(false);
    vi.mocked(performance.now).mockReturnValue(6000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(repo.getWorkerStatus).toHaveBeenCalledTimes(2);
    wrapper.unmount();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(repo.getWorkerStatus).toHaveBeenCalledTimes(2);
  });

  it('shows a slow check without stacking requests', async () => {
    repo.getWorkerStatus.mockReturnValue(new Promise(() => {}));
    repo.getMessageContentTimings.mockReturnValue({ count: 0, pending: 1, oldestPendingMs: 2400 });
    wrapper = mount(SharedWorkerStatus);
    await flushPromises();
    vi.mocked(performance.now).mockReturnValue(11_000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(wrapper.get('[data-worker-response]').text()).toBe('Waiting… 10.00 s');
    expect(wrapper.text()).toContain('1 pending · 2.40 s');
    expect(repo.getWorkerStatus).toHaveBeenCalledOnce();
  });

  it('spaces failed probes five seconds apart, clears stale timing, and keeps uptime advancing', async () => {
    vi.mocked(performance.now).mockImplementation(() => Date.now());
    repo.getWorkerStatus.mockResolvedValueOnce({ uptimeMs: 1000, instanceId: 'one' });
    repo.getWorkerStatus.mockRejectedValue(new Error('Status failed'));
    wrapper = mount(SharedWorkerStatus);
    await flushPromises();
    await vi.advanceTimersByTimeAsync(5000);
    expect(repo.getWorkerStatus).toHaveBeenCalledTimes(2);
    expect(wrapper.get('[data-worker-response]').text()).toBe('Unavailable');
    expect(wrapper.get('[role="alert"]').text()).toBe('Status failed');
    expect(wrapper.get('[data-worker-uptime]').text()).toBe('6s');
    await vi.advanceTimersByTimeAsync(4000);
    expect(repo.getWorkerStatus).toHaveBeenCalledTimes(2);
    expect(wrapper.get('[data-worker-uptime]').text()).toBe('10s');
    repo.getWorkerStatus.mockResolvedValue({ uptimeMs: 11_000, instanceId: 'one' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(repo.getWorkerStatus).toHaveBeenCalledTimes(3);
    expect(wrapper.get('[data-worker-response]').text()).toBe('0 ms round trip');
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
  });

});
