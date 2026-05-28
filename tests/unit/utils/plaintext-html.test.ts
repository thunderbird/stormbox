/**
 * Unit tests for the plaintext -> display HTML converter.
 *
 * This mirrors how Thunderbird Desktop presents text/plain bodies: the
 * original line breaks and whitespace are preserved (the host renders
 * with white-space: pre-wrap), URLs and mail addresses become links (via
 * linkify-string, which also escapes the text), and `>`-prefixed quotes
 * become nested <blockquote> elements with the markers stripped, styled
 * with a coloured bar per nesting level. See issue #25.
 */

import { describe, it, expect } from 'vitest';

import { plaintextToHtml } from '../../../src/utils/plaintext-html';

describe('plaintextToHtml', () => {
  it('returns an empty string for empty/nullish input', () => {
    expect(plaintextToHtml('')).toBe('');
    expect(plaintextToHtml(null)).toBe('');
    expect(plaintextToHtml(undefined)).toBe('');
  });

  it('preserves line breaks as newline separators', () => {
    expect(plaintextToHtml('line one\nline two')).toBe('line one\nline two');
  });

  it('normalizes CRLF and lone CR to LF', () => {
    expect(plaintextToHtml('a\r\nb\rc')).toBe('a\nb\nc');
  });

  it('escapes HTML-significant characters', () => {
    const out = plaintextToHtml('<b>tag & ampersand');
    expect(out).toBe('&lt;b&gt;tag &amp; ampersand');
  });

  it('linkifies http(s) URLs without swallowing trailing punctuation', () => {
    const out = plaintextToHtml('see https://example.com/path.');
    expect(out).toContain('href="https://example.com/path"');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).toContain('>https://example.com/path</a>');
    expect(out.endsWith('.')).toBe(true);
  });

  it('linkifies bare www. hosts with an https scheme', () => {
    const out = plaintextToHtml('go to www.example.com now');
    expect(out).toContain('href="https://www.example.com"');
    expect(out).toContain('>www.example.com</a>');
  });

  it('linkifies email addresses via mailto:', () => {
    const out = plaintextToHtml('mail a@b.com please');
    expect(out).toContain('href="mailto:a@b.com"');
    expect(out).toContain('>a@b.com</a>');
  });

  it('wraps quoted lines in a blockquote and strips the > markers', () => {
    const out = plaintextToHtml('> quoted line\nnormal line');
    expect(out).toBe(
      '<blockquote class="pt-quote pt-quote--l1">quoted line</blockquote>normal line',
    );
  });

  it('joins consecutive quoted lines inside one blockquote', () => {
    const out = plaintextToHtml('> line one\n> line two');
    expect(out).toBe(
      '<blockquote class="pt-quote pt-quote--l1">line one\nline two</blockquote>',
    );
  });

  it('nests deeper quotes with the level-2 class', () => {
    const out = plaintextToHtml('> a\n>> b');
    expect(out).toBe(
      '<blockquote class="pt-quote pt-quote--l1">a'
      + '<blockquote class="pt-quote pt-quote--l2">b</blockquote>'
      + '</blockquote>',
    );
  });

  it('linkifies inside a quoted line', () => {
    const out = plaintextToHtml('> see https://example.com/q');
    expect(out).toContain('<blockquote class="pt-quote pt-quote--l1">');
    expect(out).toContain('href="https://example.com/q"');
    expect(out).not.toContain('&gt;');
  });

  it('does not allow markup injection through a crafted line', () => {
    const out = plaintextToHtml('x"><img src=x onerror=alert(1)> http://e.com');
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img');
    // the trailing real URL is still linkified
    expect(out).toContain('href="http://e.com"');
  });
});
