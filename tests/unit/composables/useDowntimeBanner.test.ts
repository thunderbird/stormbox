// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, h } from 'vue';

import { useDowntimeBanner } from '../../../src/composables/useDowntimeBanner';

const BANNER_URL = 'https://accounts.example.org/api/v1/status/banner/';
const MESSAGE = 'Scheduled maintenance 14:00–16:00 UTC.';

const fetchMock = vi.fn();
let warn: ReturnType<typeof vi.spyOn>;

function respond(body: unknown, status = 200) {
  fetchMock.mockResolvedValue(new Response(JSON.stringify(body), { status }));
}

function enabled(overrides: Record<string, unknown> = {}) {
  return { enabled: true, type: 'warning', message: MESSAGE, link: null, ...overrides };
}

async function loadBanner(url = BANNER_URL) {
  let result!: ReturnType<typeof useDowntimeBanner>;
  mount(defineComponent({
    setup() {
      result = useDowntimeBanner(url);
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
  it('does not fetch without a url', async () => {
    expect(await loadBanner('')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns an enabled banner with its link', async () => {
    respond(enabled({ link: { text: 'Status', href: 'https://status.example.org/' } }));
    expect(await loadBanner()).toEqual({
      type: 'warning',
      message: MESSAGE,
      link: { text: 'Status', href: 'https://status.example.org/' },
    });
  });

  it('shows nothing once the banner has ended', async () => {
    respond(enabled({ ends: new Date(Date.now() - 60_000).toISOString() }));
    expect(await loadBanner()).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
  });

  it('shows nothing and warns once when the endpoint fails', async () => {
    respond({ detail: 'error' }, 500);
    expect(await loadBanner()).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
  });

  it('drops a link that is not http(s) and keeps the banner', async () => {
    respond(enabled({ link: { text: 'Status', href: 'javascript:alert(1)' } }));
    expect(await loadBanner()).toMatchObject({ message: MESSAGE, link: null });
  });
});
