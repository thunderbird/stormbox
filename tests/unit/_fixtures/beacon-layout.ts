/**
 * happy-dom does no layout, so beacon anchors are given viewport rects by
 * selector here and `elementFromPoint` resolves to the element whose rect
 * contains the point. `requestAnimationFrame` runs on the microtask queue so
 * `flushPromises()` settles a measurement.
 */

export interface LayoutRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export type LayoutRects = Record<string, LayoutRect>;

function toDomRect(rect: LayoutRect): DOMRect {
  return {
    x: rect.left,
    y: rect.top,
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height,
    toJSON() { return this; },
  } as DOMRect;
}

const EMPTY_RECT: LayoutRect = {
  left: 0, top: 0, width: 0, height: 0,
};

export function stubBeaconLayout(initial: LayoutRects = {}) {
  let rects: LayoutRects = { ...initial };
  // Elements matching these selectors sit on top of everything else.
  let covers: string[] = [];

  const originalRect = Element.prototype.getBoundingClientRect;
  const originalFromPoint = document.elementFromPoint;
  const originalRaf = window.requestAnimationFrame;
  const originalCaf = window.cancelAnimationFrame;

  function rectFor(element: Element): LayoutRect {
    for (const [selector, rect] of Object.entries(rects)) {
      if (element.matches(selector)) return rect;
    }
    return EMPTY_RECT;
  }

  Element.prototype.getBoundingClientRect = function getBoundingClientRect(this: Element) {
    return toDomRect(rectFor(this));
  };

  document.elementFromPoint = (x: number, y: number) => {
    const candidates = [...covers, ...Object.keys(rects)];
    for (const selector of candidates) {
      for (const element of document.querySelectorAll(selector)) {
        const rect = rectFor(element);
        if (covers.includes(selector) || (
          x >= rect.left && x <= rect.left + rect.width
          && y >= rect.top && y <= rect.top + rect.height
        )) {
          return element;
        }
      }
    }
    return null;
  };

  let nextFrame = 1;
  const cancelled = new Set<number>();
  window.requestAnimationFrame = (callback: FrameRequestCallback) => {
    const id = nextFrame++;
    void Promise.resolve().then(() => {
      if (!cancelled.delete(id)) callback(performance.now());
    });
    return id;
  };
  window.cancelAnimationFrame = (id: number) => {
    cancelled.add(id);
  };

  return {
    setRects(next: LayoutRects) {
      rects = { ...next };
    },
    setRect(selector: string, rect: LayoutRect | null) {
      if (rect) rects[selector] = rect;
      else delete rects[selector];
    },
    /** Elements matching `selector` cover every anchor they overlap. */
    cover(selector: string | null) {
      covers = selector ? [selector] : [];
    },
    restore() {
      Element.prototype.getBoundingClientRect = originalRect;
      document.elementFromPoint = originalFromPoint;
      window.requestAnimationFrame = originalRaf;
      window.cancelAnimationFrame = originalCaf;
    },
  };
}

export type BeaconLayoutStub = ReturnType<typeof stubBeaconLayout>;
