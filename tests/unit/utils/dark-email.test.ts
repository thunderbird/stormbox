// @vitest-environment happy-dom
/**
 * Unit tests for the dark-mode email adapter (a port of Thunderbird's
 * DarkReader "strip, don't invert" approach). Covers the per-declaration
 * algorithm, the document-level walk, embedded <style> rewriting
 * (including a nested @media block), SVG fill handling, and the
 * "already supports dark mode" bail conditions.
 */

import { describe, it, expect } from 'vitest';
import {
  sanitizeStyleDeclaration,
  adaptHtmlForDarkMode,
} from '../../../src/utils/dark-email';
import { parseCssColor, contrast } from '../../../src/utils/color';

const DARK_CANVAS = '#11131a';

function withPrefersDarkMatch<T>(matches: boolean, fn: () => T): T {
  const original = window.matchMedia;
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: ((query: string) => ({
      matches: query === '(prefers-color-scheme: dark)' ? matches : false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia,
  });
  try {
    return fn();
  } finally {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: original,
    });
  }
}

// Build a real CSSStyleDeclaration from an inline style string so the
// declaration-level tests exercise the same object type the adapter uses.
function decl(style: string): CSSStyleDeclaration {
  const el = document.createElement('div');
  el.setAttribute('style', style);
  return el.style;
}

function get(style: CSSStyleDeclaration, prop: string): string {
  return style.getPropertyValue(prop).trim();
}

describe('sanitizeStyleDeclaration', () => {
  it('drops dark text that has no real background (falls back to the canvas)', () => {
    const style = decl('color:#111111');
    expect(sanitizeStyleDeclaration(style)).toBe(true);
    expect(get(style, 'color')).toBe('');
  });

  it('keeps light text on no background', () => {
    const style = decl('color:#ffffff');
    expect(sanitizeStyleDeclaration(style)).toBe(false);
    expect(get(style, 'color')).toBe('#ffffff');
  });

  it('lightens dark chromatic text (brand colour) instead of dropping it to white', () => {
    const style = decl('color:#E50914'); // Netflix red
    expect(sanitizeStyleDeclaration(style)).toBe(true);
    const out = get(style, 'color');
    expect(out).not.toBe('');
    const rgba = parseCssColor(out)!;
    // Still red, now readable on the dark canvas.
    expect(rgba.r).toBeGreaterThan(rgba.g);
    expect(rgba.r).toBeGreaterThan(rgba.b);
    expect(contrast(out, DARK_CANVAS)).toBeGreaterThanOrEqual(3.5);
  });

  it('lightens dark chromatic text after stripping its bright background', () => {
    const style = decl('background:#ffffff;color:#000080'); // navy on white
    expect(sanitizeStyleDeclaration(style)).toBe(true);
    expect(get(style, 'background')).toBe('');
    const rgba = parseCssColor(get(style, 'color'))!;
    expect(rgba.b).toBeGreaterThan(rgba.r); // still blue
    expect(contrast(get(style, 'color'), DARK_CANVAS)).toBeGreaterThanOrEqual(3.5);
  });

  it('keeps an already-readable chromatic colour as authored', () => {
    const style = decl('color:#1a73e8'); // bright-enough blue
    expect(sanitizeStyleDeclaration(style)).toBe(false);
    expect(get(style, 'color')).toBe('#1a73e8');
  });

  it('strips a bright background and the dark text on it', () => {
    const style = decl('background-color:#ffffff;color:#111111');
    expect(sanitizeStyleDeclaration(style)).toBe(true);
    expect(get(style, 'background-color')).toBe('');
    expect(get(style, 'color')).toBe('');
  });

  it('keeps a dark background with adequate contrast', () => {
    const style = decl('background-color:#111111;color:#dddddd');
    expect(sanitizeStyleDeclaration(style)).toBe(false);
    expect(get(style, 'background-color')).toBe('#111111');
    expect(get(style, 'color')).toBe('#dddddd');
  });

  it('strips a dark-on-dark low-contrast pair', () => {
    const style = decl('background-color:#111111;color:#222222');
    expect(sanitizeStyleDeclaration(style)).toBe(true);
    expect(get(style, 'background-color')).toBe('');
    expect(get(style, 'color')).toBe('');
  });

  it('strips a bright background set via the shorthand', () => {
    const style = decl('background:#ffffff;color:#000000');
    expect(sanitizeStyleDeclaration(style)).toBe(true);
    expect(get(style, 'background')).toBe('');
    expect(get(style, 'color')).toBe('');
  });

  it('treats a transparent background as no background', () => {
    const style = decl('background-color:transparent;color:#000000');
    expect(sanitizeStyleDeclaration(style)).toBe(true);
    expect(get(style, 'color')).toBe('');
  });

  it('removes light-assuming background images but not gradients here', () => {
    const style = decl('background-image:url(hero.png)');
    expect(sanitizeStyleDeclaration(style)).toBe(true);
    expect(get(style, 'background-image')).toBe('');
  });

  it('removes gradient backgrounds', () => {
    const style = decl('background:linear-gradient(#ffffff,#000000)');
    expect(sanitizeStyleDeclaration(style)).toBe(true);
    expect(get(style, 'background')).toBe('');
  });

  it('leaves non-colour declarations untouched', () => {
    const style = decl('color:#111111;padding:8px;font-size:13px');
    sanitizeStyleDeclaration(style);
    expect(get(style, 'color')).toBe('');
    expect(get(style, 'padding')).toBe('8px');
    expect(get(style, 'font-size')).toBe('13px');
  });

  it('does nothing when there is no colour/background to judge', () => {
    const style = decl('padding:8px');
    expect(sanitizeStyleDeclaration(style)).toBe(false);
    expect(get(style, 'padding')).toBe('8px');
  });
});

describe('adaptHtmlForDarkMode', () => {
  function parse(html: string) {
    return new DOMParser().parseFromString(html, 'text/html');
  }

  it('returns empty/edge input unchanged', () => {
    expect(adaptHtmlForDarkMode('')).toBe('');
  });

  it('strips a wrapping light card so it falls back to the dark canvas', () => {
    const out = adaptHtmlForDarkMode('<div style="background:#ffffff;color:#000000">hi</div>');
    const div = parse(out).querySelector('div')!;
    expect(div.getAttribute('style') ?? '').not.toMatch(/#ffffff/i);
    expect(div.getAttribute('style') ?? '').not.toMatch(/#000000/i);
    expect(div.textContent).toBe('hi');
  });

  it('removes bgcolor attributes and dark inline text in tables', () => {
    const out = adaptHtmlForDarkMode(
      '<table bgcolor="#ffffff"><tr><td style="color:#000000">cell</td></tr></table>',
    );
    const doc = parse(out);
    expect(doc.querySelector('table')!.hasAttribute('bgcolor')).toBe(false);
    expect(doc.querySelector('td')!.getAttribute('style') ?? '').not.toMatch(/#000000/i);
  });

  it('adapts preserved body presentation and head styles in a complete document', () => {
    const out = adaptHtmlForDarkMode(
      '<html class="email-root"><head>'
      + '<style>.footer{background:#eeeeee;color:#111111}</style>'
      + '</head><body class="email-body" bgcolor="#ffffff" text="#000000" '
      + 'style="background:#ffffff;color:#000000;font-size:14px">'
      + '<div class="footer">footer</div></body></html>',
    );
    const doc = parse(out);
    const bodyStyle = doc.body.getAttribute('style') ?? '';
    const css = doc.querySelector('head > style')?.textContent ?? '';

    expect(doc.documentElement.classList.contains('email-root')).toBe(true);
    expect(doc.body.classList.contains('email-body')).toBe(true);
    expect(doc.body.hasAttribute('bgcolor')).toBe(false);
    expect(doc.body.hasAttribute('text')).toBe(false);
    expect(bodyStyle).toContain('font-size: 14px');
    expect(bodyStyle).not.toMatch(/#ffffff|#000000/i);
    expect(css).not.toMatch(/#eeeeee|#111111/i);
    expect(doc.body.textContent).toContain('footer');
  });

  it('leaves a complete email untouched when its active head CSS supports dark mode', () => {
    const html =
      '<html><head><style>@media (prefers-color-scheme: dark)'
      + '{body{background:#000;color:#fff}}</style></head>'
      + '<body style="background:#ffffff;color:#000000">x</body></html>';
    const out = withPrefersDarkMatch(true, () => adaptHtmlForDarkMode(html));

    expect(out).toBe(html);
  });

  it.each([
    'filter:invert(1)',
    'color-scheme:dark',
  ])('leaves a complete email untouched when its body wrapper declares %s', (wrapperStyle) => {
    const html =
      '<html><head></head><body>'
      + `<div style="${wrapperStyle}"><span style="color:#000000">x</span></div>`
      + '</body></html>';

    expect(adaptHtmlForDarkMode(html)).toBe(html);
  });

  it('preserves a saturated brand colour (Netflix red) as a readable red, not white', () => {
    const out = adaptHtmlForDarkMode('<span style="color:#E50914">NETFLIX</span>');
    const style = parse(out).querySelector('span')!.getAttribute('style') ?? '';
    const match = /color:\s*([^;]+)/i.exec(style);
    expect(match).not.toBeNull();
    const rgba = parseCssColor(match![1])!;
    expect(rgba.r).toBeGreaterThan(rgba.g);
    expect(rgba.r).toBeGreaterThan(rgba.b);
    expect(contrast(match![1], DARK_CANVAS)).toBeGreaterThanOrEqual(3.5);
  });

  it('keeps dark-friendly colours that already work', () => {
    const html = '<div style="background-color:#1a1a1a;color:#dddddd">ok</div>';
    const out = adaptHtmlForDarkMode(html);
    const style = parse(out).querySelector('div')!.getAttribute('style') ?? '';
    expect(style).toMatch(/#1a1a1a/i);
    expect(style).toMatch(/#dddddd/i);
  });

  it('rewrites dark SVG text fill to currentColor but keeps light fills', () => {
    const out = adaptHtmlForDarkMode(
      '<svg><text fill="#000000">a</text><text fill="#ffffff">b</text></svg>',
    );
    const texts = parse(out).querySelectorAll('text');
    expect(texts[0].getAttribute('fill')).toBe('currentColor');
    expect(texts[1].getAttribute('fill')).toBe('#ffffff');
  });

  it('keeps non-colour SVG text fills unchanged', () => {
    const out = adaptHtmlForDarkMode(
      '<svg><text fill="none">a</text><text fill="url(#gradient)">b</text></svg>',
    );
    const texts = parse(out).querySelectorAll('text');
    expect(texts[0].getAttribute('fill')).toBe('none');
    expect(texts[1].getAttribute('fill')).toBe('url(#gradient)');
  });

  it('sanitizes embedded <style> rules, recursing into @media blocks', () => {
    const html =
      '<style>p{color:#000000;background:#ffffff}'
      + '@media screen and (max-width:600px){a{color:#111111;background:#eeeeee}}</style>'
      + '<p>x</p>';
    const out = adaptHtmlForDarkMode(html);
    const css = parse(out).querySelector('style')!.textContent ?? '';
    // Top-level bright background + dark text removed.
    expect(css).not.toMatch(/#ffffff/i);
    expect(css).not.toMatch(/#000000/i);
    // Nested @media bright background + dark text removed too.
    expect(css).not.toMatch(/#eeeeee/i);
    expect(css).not.toMatch(/#111111/i);
    // The media query wrapper itself is preserved.
    expect(css).toMatch(/@media/i);
  });

  it('leaves the email untouched when its @media dark branch is active', () => {
    const html =
      '<style>@media (prefers-color-scheme: dark){body{background:#000;color:#fff}}</style>'
      + '<div style="color:#000000">x</div>';
    const out = withPrefersDarkMatch(true, () => adaptHtmlForDarkMode(html));
    // Bail: the dark-on-light inline colour is intentionally preserved.
    expect(out).toContain('color:#000000');
  });

  it('still adapts @media dark emails when the browser preference is light', () => {
    const html =
      '<style>@media (prefers-color-scheme: dark){body{background:#000;color:#fff}}</style>'
      + '<div style="color:#000000">x</div>';
    const out = withPrefersDarkMatch(false, () => adaptHtmlForDarkMode(html));
    expect(out).not.toContain('color:#000000');
  });

  it('leaves the email untouched when a meta color-scheme opts into dark', () => {
    const html = '<meta name="color-scheme" content="light dark"><div style="color:#000000">x</div>';
    const out = adaptHtmlForDarkMode(html);
    expect(out).toContain('color:#000000');
  });

  it('leaves the email untouched when the wrapper declares filter: invert', () => {
    const html = '<div style="filter:invert(1)"><span style="color:#000000">x</span></div>';
    const out = adaptHtmlForDarkMode(html);
    expect(out).toContain('color:#000000');
  });

  it('leaves the email untouched when the wrapper opts into a dark color-scheme', () => {
    const html = '<div style="color-scheme:dark"><span style="color:#000000">x</span></div>';
    const out = adaptHtmlForDarkMode(html);
    expect(out).toContain('color:#000000');
  });
});
