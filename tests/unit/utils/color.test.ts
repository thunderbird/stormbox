/**
 * Unit tests for the CSS colour parser and the Thunderbird-compatible
 * luminance / contrast / transparency helpers used by the dark-mode email
 * adapter. Pure functions — no DOM required.
 */

import { describe, it, expect } from 'vitest';
import {
  parseCssColor,
  luminance,
  contrast,
  isTransparent,
  isValidColor,
  colorChroma,
  lightenColorForContrast,
} from '../../../src/utils/color';

describe('parseCssColor', () => {
  it('parses 3- and 6-digit hex', () => {
    expect(parseCssColor('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseCssColor('#000000')).toEqual({ r: 0, g: 0, b: 0, a: 1 });
    expect(parseCssColor('#1a2b3c')).toEqual({ r: 26, g: 43, b: 60, a: 1 });
  });

  it('parses 4- and 8-digit hex with alpha', () => {
    expect(parseCssColor('#0000')).toEqual({ r: 0, g: 0, b: 0, a: 0 });
    const half = parseCssColor('#11223380');
    expect(half).toMatchObject({ r: 17, g: 34, b: 51 });
    expect(half?.a).toBeCloseTo(128 / 255, 5);
  });

  it('parses rgb()/rgba() in comma, space, and slash syntax', () => {
    expect(parseCssColor('rgb(255, 0, 0)')).toEqual({ r: 255, g: 0, b: 0, a: 1 });
    expect(parseCssColor('rgba(0, 128, 255, 0.5)')).toEqual({ r: 0, g: 128, b: 255, a: 0.5 });
    expect(parseCssColor('rgb(1 2 3)')).toEqual({ r: 1, g: 2, b: 3, a: 1 });
    expect(parseCssColor('rgb(1 2 3 / 50%)')).toEqual({ r: 1, g: 2, b: 3, a: 0.5 });
    expect(parseCssColor('rgb(50%, 0%, 100%)')).toEqual({ r: 128, g: 0, b: 255, a: 1 });
  });

  it('parses hsl()/hsla()', () => {
    expect(parseCssColor('hsl(0, 100%, 50%)')).toEqual({ r: 255, g: 0, b: 0, a: 1 });
    expect(parseCssColor('hsl(120, 100%, 50%)')).toEqual({ r: 0, g: 255, b: 0, a: 1 });
    expect(parseCssColor('hsl(0, 0%, 100%)')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseCssColor('hsla(240, 100%, 50%, 0.25)')).toEqual({ r: 0, g: 0, b: 255, a: 0.25 });
  });

  it('parses named colours and transparent', () => {
    expect(parseCssColor('white')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseCssColor('BLACK')).toEqual({ r: 0, g: 0, b: 0, a: 1 });
    expect(parseCssColor('navy')).toEqual({ r: 0, g: 0, b: 128, a: 1 });
    expect(parseCssColor(' whitesmoke ')).toEqual({ r: 245, g: 245, b: 245, a: 1 });
    expect(parseCssColor('transparent')).toEqual({ r: 0, g: 0, b: 0, a: 0 });
  });

  it('returns null for non-colour / unsupported values', () => {
    expect(parseCssColor('')).toBeNull();
    expect(parseCssColor(null)).toBeNull();
    expect(parseCssColor('currentColor')).toBeNull();
    expect(parseCssColor('inherit')).toBeNull();
    expect(parseCssColor('var(--x)')).toBeNull();
    expect(parseCssColor('url(x.png)')).toBeNull();
    expect(parseCssColor('linear-gradient(#fff,#000)')).toBeNull();
    expect(parseCssColor('#12')).toBeNull();
    expect(parseCssColor('#zzzzzz')).toBeNull();
    expect(parseCssColor('notacolor')).toBeNull();
  });
});

describe('luminance', () => {
  it('matches the Thunderbird weighted formula on a 0-255 scale', () => {
    expect(luminance('#ffffff')).toBeCloseTo(255, 5);
    expect(luminance('#000000')).toBe(0);
    // 0.2125*255 for pure red.
    expect(luminance('#ff0000')).toBeCloseTo(54.1875, 4);
    expect(luminance('#111111')).toBeCloseTo(17, 5);
  });

  it('treats unparseable colours as 0 (dark)', () => {
    expect(luminance('currentColor')).toBe(0);
    expect(luminance('')).toBe(0);
  });

  it('places the 200 threshold between mid grey and near-white', () => {
    expect(luminance('#808080')).toBeLessThanOrEqual(200);
    expect(luminance('#eeeeee')).toBeGreaterThan(200);
    expect(luminance('white')).toBeGreaterThan(200);
  });
});

describe('contrast', () => {
  it('is large for black/white and ~1 for identical colours', () => {
    expect(contrast('#ffffff', '#000000')).toBeGreaterThan(1000);
    expect(contrast('#123456', '#123456')).toBeCloseTo(1, 5);
  });

  it('exceeds the 3.5 threshold for light-on-dark but not dark-on-dark', () => {
    expect(contrast('#ffffff', '#111111')).toBeGreaterThan(3.5);
    expect(contrast('#222222', '#111111')).toBeLessThan(3.5);
  });
});

describe('isTransparent', () => {
  it('flags transparent, low-alpha, and unparseable values', () => {
    expect(isTransparent('transparent')).toBe(true);
    expect(isTransparent('rgba(0,0,0,0.1)')).toBe(true);
    expect(isTransparent('#00000033')).toBe(true);
    expect(isTransparent('currentColor')).toBe(true);
  });

  it('does not flag opaque colours', () => {
    expect(isTransparent('#000000')).toBe(false);
    expect(isTransparent('rgba(0,0,0,0.8)')).toBe(false);
    expect(isTransparent('white')).toBe(false);
  });
});

describe('isValidColor', () => {
  it('accepts colours the parser understands and rejects the rest', () => {
    expect(isValidColor('#fff')).toBe(true);
    expect(isValidColor('rgb(1,2,3)')).toBe(true);
    expect(isValidColor('transparent')).toBe(true);
    expect(isValidColor('red url(x)')).toBe(false);
    expect(isValidColor('currentColor')).toBe(false);
    expect(isValidColor('')).toBe(false);
  });
});

describe('colorChroma', () => {
  it('is zero for greys/black/white and high for saturated colours', () => {
    expect(colorChroma('#111111')).toBe(0);
    expect(colorChroma('white')).toBe(0);
    expect(colorChroma('#808080')).toBe(0);
    expect(colorChroma('#E50914')).toBe(220); // Netflix red
    expect(colorChroma('#000080')).toBe(128); // navy
  });

  it('returns 0 for unparseable values', () => {
    expect(colorChroma('currentColor')).toBe(0);
    expect(colorChroma('')).toBe(0);
  });
});

describe('lightenColorForContrast', () => {
  const DARK = '#11131a';

  it('lightens a dark chromatic colour to meet the contrast target, preserving hue', () => {
    const out = lightenColorForContrast('#E50914', DARK, 3.5);
    expect(out).not.toBeNull();
    // Still predominantly red, now readable on the dark canvas.
    const rgba = parseCssColor(out!)!;
    expect(rgba.r).toBeGreaterThan(rgba.g);
    expect(rgba.r).toBeGreaterThan(rgba.b);
    expect(contrast(out!, DARK)).toBeGreaterThanOrEqual(3.5);
    expect(luminance(out!)).toBeGreaterThan(luminance('#E50914'));
  });

  it('returns a colour that already meets the target unchanged', () => {
    expect(lightenColorForContrast('#1a73e8', DARK, 3.5)).toBe('#1a73e8');
  });

  it('returns null for unparseable input', () => {
    expect(lightenColorForContrast('currentColor', DARK, 3.5)).toBeNull();
  });
});
