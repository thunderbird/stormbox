// @vitest-environment happy-dom

import {
  afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';

import FireworksOverlay from '../../../../src/features/kanban/celebration/FireworksOverlay.vue';

function fakeContext() {
  return {
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    beginPath: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    globalCompositeOperation: '',
    fillStyle: '',
    globalAlpha: 1,
  } as unknown as CanvasRenderingContext2D;
}

let getContext: ReturnType<typeof vi.fn>;
let raf: ReturnType<typeof vi.fn>;

function setReducedMotion(matches: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: query.includes('prefers-reduced-motion') && matches,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })),
  });
}

beforeEach(() => {
  getContext = vi.fn(() => fakeContext());
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value: getContext,
  });
  raf = vi.fn(() => 1);
  vi.stubGlobal('requestAnimationFrame', raf);
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('FireworksOverlay', () => {
  it('draws on a full-viewport canvas and keeps animating while the show runs', async () => {
    setReducedMotion(false);
    const wrapper = mount(FireworksOverlay, { attachTo: document.body });
    await flushPromises();

    expect(document.body.querySelector('[data-kanban-fireworks]')).not.toBeNull();
    expect(getContext).toHaveBeenCalledWith('2d');
    expect(raf).toHaveBeenCalled();
    expect(wrapper.emitted('done')).toBeUndefined();
    wrapper.unmount();
  });

  it('skips the show entirely under prefers-reduced-motion', async () => {
    // Matches the app's other animated surfaces, which all honour the
    // media query; the audio still plays so the moment is not lost.
    setReducedMotion(true);
    const wrapper = mount(FireworksOverlay, { attachTo: document.body });
    await flushPromises();

    expect(wrapper.emitted('done')).toHaveLength(1);
    expect(getContext).not.toHaveBeenCalled();
    expect(raf).not.toHaveBeenCalled();
    wrapper.unmount();
  });
});
