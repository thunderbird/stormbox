import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  createContactMapKey,
  createContactUid,
  isContactUid,
} from '../../../src/utils/contact-uid';
import { createIdentityOperationId } from '../../../src/utils/identity-fields';
import { randomToken } from '../../../src/utils/random-token';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('randomToken', () => {
  it('uses randomUUID when available', () => {
    const randomUUID = vi.fn(() => '123e4567-e89b-42d3-a456-426614174000');
    const getRandomValues = vi.fn();
    vi.stubGlobal('crypto', { randomUUID, getRandomValues });

    expect(randomToken()).toBe('123e4567-e89b-42d3-a456-426614174000');
    expect(randomUUID).toHaveBeenCalledOnce();
    expect(getRandomValues).not.toHaveBeenCalled();
  });

  it('formats getRandomValues bytes as a version-4 UUID', () => {
    const getRandomValues = vi.fn((bytes: Uint8Array) => {
      bytes.set(Array.from({ length: 16 }, (_, index) => index));
      return bytes;
    });
    vi.stubGlobal('crypto', { getRandomValues });

    expect(randomToken()).toBe('00010203-0405-4607-8809-0a0b0c0d0e0f');
  });

  it('continues to getRandomValues when randomUUID throws', () => {
    const getRandomValues = vi.fn((bytes: Uint8Array) => bytes.fill(0xaa));
    vi.stubGlobal('crypto', {
      randomUUID: vi.fn(() => {
        throw new Error('unavailable');
      }),
      getRandomValues,
    });

    expect(randomToken()).toMatch(UUID_PATTERN);
    expect(getRandomValues).toHaveBeenCalledOnce();
  });

  it('uses distinct timestamp tokens without Web Crypto', () => {
    vi.stubGlobal('crypto', undefined);
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    const first = randomToken();
    const second = randomToken();

    expect(first).toMatch(UUID_PATTERN);
    expect(second).toMatch(UUID_PATTERN);
    expect(second).not.toBe(first);
  });

  it('keeps domain prefixes and UUID-shaped contact identifiers', () => {
    vi.stubGlobal('crypto', {
      randomUUID: () => '123e4567-e89b-42d3-a456-426614174000',
    });

    expect(createIdentityOperationId())
      .toBe('identity-123e4567-e89b-42d3-a456-426614174000');
    expect(createContactMapKey('email'))
      .toBe('email-123e4567-e89b-42d3-a456-426614174000');
    expect(isContactUid(createContactUid())).toBe(true);
  });
});
