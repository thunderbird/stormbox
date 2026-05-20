import { describe, it, expect, afterEach } from 'vitest';

import {
  checkBrowserSupport,
  assertSupportedBrowser,
  UnsupportedBrowserError,
} from '../../../src/db/availability.js';

const ORIGINAL = {};

function shimGlobal(name, value) {
  if (!(name in ORIGINAL)) {
    ORIGINAL[name] = name in globalThis ? globalThis[name] : undefined;
  }
  if (value === undefined) {
    delete globalThis[name];
  } else {
    globalThis[name] = value;
  }
}

afterEach(() => {
  for (const [name, value] of Object.entries(ORIGINAL)) {
    if (value === undefined) {
      delete globalThis[name];
    } else {
      globalThis[name] = value;
    }
  }
  for (const k of Object.keys(ORIGINAL)) delete ORIGINAL[k];
});

describe('checkBrowserSupport', () => {
  it('reports SharedWorker as missing in plain Node environments', () => {
    const missing = checkBrowserSupport();
    expect(missing).not.toBeNull();
    expect(missing).toContain('SharedWorker');
  });

  it('returns null when every required global is present', () => {
    shimGlobal('SharedWorker', class {});
    shimGlobal('BroadcastChannel', class {});
    shimGlobal('MessageChannel', class {});
    shimGlobal('navigator', { storage: { getDirectory: async () => ({}) } });
    expect(checkBrowserSupport()).toBeNull();
  });

  it('flags missing OPFS support when navigator.storage.getDirectory is absent', () => {
    shimGlobal('SharedWorker', class {});
    shimGlobal('BroadcastChannel', class {});
    shimGlobal('MessageChannel', class {});
    shimGlobal('navigator', { storage: {} });
    expect(checkBrowserSupport()).toContain('Origin Private File System');
  });
});

describe('assertSupportedBrowser', () => {
  it('throws UnsupportedBrowserError naming the missing capabilities', () => {
    let caught;
    try {
      assertSupportedBrowser();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UnsupportedBrowserError);
    expect(caught.message).toMatch(/SharedWorker/);
    expect(Array.isArray(caught.missing)).toBe(true);
  });
});
