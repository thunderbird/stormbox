// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, h } from 'vue';

import { useDowntimeBanner } from '../../../src/composables/useDowntimeBanner';

const MESSAGES_URL = 'https://auth.example.org/resources/tbpro/login/en';
const MESSAGE = 'Scheduled maintenance 14:00–16:00 UTC.';

const fetchMock = vi.fn();
let warn: ReturnType<typeof vi.spyOn>;

function respond(messages: Record<string, string>, status = 200) {
  const body = Object.entries(messages).map(([key, value]) => ({ key, value }));
  fetchMock.mockResolvedValue(new Response(JSON.stringify(body), { status }));
}

async function loadBanner() {
  let result!: ReturnType<typeof useDowntimeBanner>;
  mount(defineComponent({
    setup() {
      result = useDowntimeBanner(MESSAGES_URL);
      return () => h('div');
    },
  }));
  await flushPromises();
  return result.banner.value;
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useDowntimeBanner', () => {
  it('returns the loginBanner message with its type', async () => {
    respond({ doLogIn: 'Sign in', loginBanner: ` We''re down. ${MESSAGE} `, loginBannerType: 'critical' });
    expect(await loadBanner()).toEqual({ type: 'critical', message: `We're down. ${MESSAGE}` });
  });

  it('shows nothing and stays silent when loginBanner is empty or missing', async () => {
    respond({ loginBanner: '  ', loginBannerType: 'warning' });
    expect(await loadBanner()).toBeNull();
    respond({ doLogIn: 'Sign in' });
    expect(await loadBanner()).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('shows nothing and warns once when the endpoint fails', async () => {
    respond({ loginBanner: MESSAGE }, 500);
    expect(await loadBanner()).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
  });

  it('falls back to a warning for an unknown loginBannerType', async () => {
    respond({ loginBanner: MESSAGE, loginBannerType: 'urgent' });
    expect(await loadBanner()).toEqual({ type: 'warning', message: MESSAGE });
  });
});
