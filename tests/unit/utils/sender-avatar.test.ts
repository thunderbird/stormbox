import { describe, expect, it } from 'vitest';

import {
  avatarImageUrlForDomain,
  extractEmail,
  normalizeDomain,
  senderAvatarFor,
  senderDomainFromText,
  senderInitials,
} from '../../../src/utils/sender-avatar.js';

describe('sender-avatar', () => {
  it('extracts sender email and normalizes its domain', () => {
    expect(extractEmail('"UPS Tracking" <Tracking@UPS.COM>')).toBe('tracking@ups.com');
    expect(senderDomainFromText('"UPS Tracking" <Tracking@UPS.COM>')).toBe('ups.com');
  });

  it('rejects domains that could turn the proxy into a URL fetcher', () => {
    expect(normalizeDomain('https://example.com/favicon.ico')).toBe('');
    expect(normalizeDomain('example.com:443')).toBe('');
    expect(normalizeDomain('localhost')).toBe('');
    expect(normalizeDomain('127.0.0.1')).toBe('');
    expect(normalizeDomain('example.com/path')).toBe('');
  });

  it('builds proxied image URLs only when configured', () => {
    expect(avatarImageUrlForDomain('Example.COM.', '')).toBe('');
    expect(avatarImageUrlForDomain('Example.COM.', 'https://proxy.example/sender-avatar/')).toBe(
      'https://proxy.example/sender-avatar/example.com?v=3',
    );
  });

  it('returns initials and fallback style alongside optional image URL', () => {
    const avatar = senderAvatarFor('Concierge Services <notice@example.com>', 'https://proxy.example/sender-avatar');
    expect(avatar).toMatchObject({
      domain: 'example.com',
      imageUrl: 'https://proxy.example/sender-avatar/example.com?v=3',
      initials: 'CS',
    });
    expect(avatar.style.background).toMatch(/^hsl\(/);
    expect(senderInitials('UPS <tracking@ups.com>')).toBe('UP');
  });
});
