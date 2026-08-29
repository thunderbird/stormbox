// @vitest-environment node

import { describe, expect, it } from 'vitest';

import {
  hasInternalProvenanceAttribute,
  stripInternalProvenanceHtml,
} from '../../../src/utils/compose-provenance';

describe('compose provenance attribute scanning', () => {
  it.each([
    '<br/ >',
    '<img src="a.png" / >',
    '<a href="x" / title="y">',
    '<div /',
    '<div>',
    '<p class="data-stormbox-origin">Ordinary attribute value</p>',
    '<code>data-stormbox-origin="example"</code>',
    'Prose data-stormbox-origin="example" without a tag',
    '<!-- <div data-stormbox-origin="comment"> -->',
  ])('finishes ordinary or malformed marker-free input: %s', (html) => {
    expect(hasInternalProvenanceAttribute(html)).toBe(false);
    expect(stripInternalProvenanceHtml(html)).toBe(html);
  });

  it.each([
    '<div data-stormbox-origin="signature">',
    '<IMG DATA-STORMBOX-ORIGIN-TOUCHED=true>',
    '<span data-stormbox-custom>',
    '<a href="x" / data-stormbox-after-slash="value">',
    '<div data-stormbox-truncated',
  ])('detects an actual internal attribute: %s', (html) => {
    expect(hasInternalProvenanceAttribute(html)).toBe(true);
    expect(stripInternalProvenanceHtml(html)).toBe(html);
  });

  it('terminates for bounded randomized malformed tag input', () => {
    let state = 0x5eed1234;
    const alphabet = '<>/ =\'"!-?abcdefghijklmnopqrstuvwxyzDATA_:\n\t';
    const next = () => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state;
    };

    for (let sample = 0; sample < 5_000; sample += 1) {
      const length = next() % 97;
      let value = '';
      for (let index = 0; index < length; index += 1) {
        value += alphabet[next() % alphabet.length];
      }
      expect(typeof hasInternalProvenanceAttribute(value)).toBe('boolean');
    }
  });
});
