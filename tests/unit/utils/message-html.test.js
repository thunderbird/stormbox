// @vitest-environment happy-dom
/**
 * Unit tests for the message-view iframe srcdoc builder.
 *
 * The MessageView component renders incoming HTML inside a sandboxed
 * iframe so that:
 *   - <style> blocks shipped by the email don't leak into the host
 *     webmail UI (which used to cause every email to render at one
 *     fixed width — whichever email's <style> last won the cascade),
 *   - any stray <script> survives only inert (no allow-scripts in
 *     the sandbox, no script-src in the CSP),
 *   - the email's own design — including its width, alignment, and
 *     background — is preserved verbatim. We do NOT clamp tables or
 *     images; if the email is 640-px wide we let it be 640-px wide.
 *
 * These tests pin those guarantees by exercising the pure builder
 * (no Vue, no real DOMPurify) under happy-dom and parsing the
 * rendered srcdoc back into a Document.
 */

import { describe, it, expect } from 'vitest';
import {
  ALLOWED_URI_REGEXP,
  IFRAME_CSP,
  IFRAME_SANDBOX,
  BODY_THEME_COLORS,
  buildBodyCss,
  buildMessageSrcDoc,
} from '../../../src/utils/message-html.js';

function parseSrcDoc(srcdoc) {
  return new DOMParser().parseFromString(srcdoc, 'text/html');
}

describe('buildMessageSrcDoc', () => {
  it('returns a complete HTML document with utf-8 charset and viewport', () => {
    const out = buildMessageSrcDoc('<p>hi</p>');
    expect(out.startsWith('<!DOCTYPE html>')).toBe(true);

    const doc = parseSrcDoc(out);
    const charset = doc.querySelector('meta[charset]');
    expect(charset?.getAttribute('charset')).toBe('utf-8');
    const viewport = doc.querySelector('meta[name="viewport"]');
    expect(viewport?.getAttribute('content')).toContain('width=device-width');
  });

  it('embeds the iframe Content-Security-Policy meta tag', () => {
    const doc = parseSrcDoc(buildMessageSrcDoc(''));
    const cspMeta = doc.querySelector('meta[http-equiv="Content-Security-Policy"]');
    expect(cspMeta).not.toBeNull();
    const csp = cspMeta.getAttribute('content') ?? '';
    expect(csp).toBe(IFRAME_CSP);

    // The CSP must forbid script-src by way of default-src 'none' and
    // never list a script-src whitelist. Anything else would let an
    // <script> survive the sanitizer and execute (inertness is a
    // belt-and-braces guarantee on top of the sandbox).
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toMatch(/script-src/);
    expect(csp).toMatch(/img-src[^;]*data:/);
    expect(csp).toMatch(/img-src[^;]*https:/);
    expect(csp).toMatch(/img-src[^;]*cid:/);
    expect(csp).toContain("style-src 'unsafe-inline'");
    expect(csp).toContain("frame-src 'none'");
  });

  it('inlines a deliberately minimal themed stylesheet', () => {
    const doc = parseSrcDoc(buildMessageSrcDoc(''));
    const style = doc.querySelector('style');
    expect(style).not.toBeNull();
    const css = style.textContent ?? '';

    expect(css).toBe(buildBodyCss('light'));

    // We DO reset the user-agent's 8-px body margin, otherwise a
    // strip of host background bleeds through at every iframe edge.
    expect(css).toMatch(/html,\s*body\s*\{[^}]*margin:\s*0/);

    // We DO set the iframe document's default canvas and text colors.
    // This fixes simple text/html bodies without rewriting styled
    // email content deeper in the tree.
    expect(css).toContain(`background: ${BODY_THEME_COLORS.light.background};`);
    expect(css).toContain(`color: ${BODY_THEME_COLORS.light.color};`);

    // We DO ship a sans-serif default for unstyled bodies. Almost all
    // marketing emails set their own font-family inline so this only
    // matters for plain HTML messages with no <style> at all.
    expect(css).toMatch(/font-family:/);

    // We must NOT touch widths. Earlier versions of this builder
    // injected `img { max-width: 100% !important }` and
    // `table[width] { width: auto !important }`, which destroyed
    // hand-laid-out marketing emails (PLEDGEBOX/UltraPill regression).
    // The user explicitly wants emails to render at their natural
    // design width with whitespace around them in a wide pane.
    expect(css).not.toMatch(/max-width:\s*100%\s*!important/);
    expect(css).not.toMatch(/width:\s*auto\s*!important/);
    expect(css).not.toMatch(/table\s*\{/);
    expect(css).not.toMatch(/\bimg\s*\{/);
    expect(css).not.toMatch(/\[width\]/);
    expect(css).not.toMatch(/body\s*\*\s*\{/);

    // We must NOT add broad dark-mode hacks or re-style email-specific
    // elements. Anchor colour, blockquote borders, filters, and so on
    // are part of the email's design.
    expect(css).not.toMatch(/\bblockquote\b/);
    expect(css).not.toMatch(/\ba\s*\{/);
    expect(css).not.toMatch(/!important/);
    expect(css).not.toMatch(/\bfilter:/);
  });

  it('places the supplied HTML directly inside <body>', () => {
    const out = buildMessageSrcDoc('<p class="x">hello <b>world</b></p>');
    const doc = parseSrcDoc(out);
    const para = doc.querySelector('body > p.x');
    expect(para).not.toBeNull();
    expect(para.textContent).toBe('hello world');
    expect(para.querySelector('b')?.textContent).toBe('world');
  });

  it('does NOT re-sanitize: trusts the caller to have sanitized first', () => {
    // The builder is intentionally a passthrough on the body — the
    // MessageView component runs DOMPurify before calling us, and we
    // don't want to double-process. So if a (test-only) caller hands
    // us raw <script>, it goes through verbatim. The defence in depth
    // is the iframe sandbox + CSP, not the builder itself.
    const out = buildMessageSrcDoc('<p>hi</p><script>alert(1)</script>');
    expect(out).toContain('<script>alert(1)</script>');
    // But that script is inert at runtime: the sandbox attribute on
    // the <iframe> excludes allow-scripts, and the embedded CSP has
    // default-src 'none' with no script-src.
    expect(IFRAME_SANDBOX).not.toMatch(/allow-scripts/);
  });

  it('renders a usable empty document when no body is provided', () => {
    const out = buildMessageSrcDoc('');
    const doc = parseSrcDoc(out);
    expect(doc.body).not.toBeNull();
    // Whitespace only — no leftover placeholder, no thrown error from
    // a missing <body>.
    expect((doc.body.innerHTML ?? '').trim()).toBe('');
  });

  it('emits color-scheme=light by default and dark when requested', () => {
    const light = parseSrcDoc(buildMessageSrcDoc(''));
    expect(light.documentElement.getAttribute('style')).toContain('color-scheme: light');

    const dark = parseSrcDoc(buildMessageSrcDoc('', { colorScheme: 'dark' }));
    expect(dark.documentElement.getAttribute('style')).toContain('color-scheme: dark');
  });

  it('uses dark default canvas and text colors for simple HTML in dark mode', () => {
    const doc = parseSrcDoc(buildMessageSrcDoc('<p>test</p>', { colorScheme: 'dark' }));
    const css = doc.querySelector('style')?.textContent ?? '';

    expect(doc.documentElement.getAttribute('style')).toContain('color-scheme: dark');
    expect(css).toBe(buildBodyCss('dark'));
    expect(css).toContain(`background: ${BODY_THEME_COLORS.dark.background};`);
    expect(css).toContain(`color: ${BODY_THEME_COLORS.dark.color};`);
    expect(doc.querySelector('body > p')?.textContent).toBe('test');
  });

  it('rejects an unrecognised colorScheme value and falls back to light', () => {
    const out = buildMessageSrcDoc('', { colorScheme: 'javascript:alert(1)' });
    const doc = parseSrcDoc(out);
    expect(doc.documentElement.getAttribute('style')).toBe('color-scheme: light;');
    expect(doc.querySelector('style')?.textContent ?? '').toBe(buildBodyCss('light'));
    // The rogue value must NOT have ended up anywhere in the document.
    expect(out).not.toContain('javascript:');
  });
});

describe('IFRAME_SANDBOX', () => {
  it('grants same-origin so the parent can measure & rewrite links', () => {
    expect(IFRAME_SANDBOX).toMatch(/allow-same-origin/);
  });

  it('does NOT grant allow-scripts (script execution stays disabled)', () => {
    expect(IFRAME_SANDBOX).not.toMatch(/allow-scripts/);
  });

  it('grants popup permissions so external links open in a new tab', () => {
    expect(IFRAME_SANDBOX).toMatch(/allow-popups/);
    expect(IFRAME_SANDBOX).toMatch(/allow-popups-to-escape-sandbox/);
  });
});

describe('ALLOWED_URI_REGEXP', () => {
  it('permits the schemes a webmail message body can legitimately use', () => {
    expect(ALLOWED_URI_REGEXP.test('https://example.com')).toBe(true);
    expect(ALLOWED_URI_REGEXP.test('http://example.com')).toBe(true);
    expect(ALLOWED_URI_REGEXP.test('mailto:foo@bar.com')).toBe(true);
    expect(ALLOWED_URI_REGEXP.test('tel:+15555555555')).toBe(true);
    // CID is the message-internal scheme used for inline images, e.g.
    // <img src="cid:logo@example.com">. We need it through the
    // sanitizer because we may rewrite it to a blob URL later.
    expect(ALLOWED_URI_REGEXP.test('cid:logo@example.com')).toBe(true);
    // Relative URLs (no scheme) — the leading slash matches [^a-z].
    expect(ALLOWED_URI_REGEXP.test('/relative/path')).toBe(true);
    expect(ALLOWED_URI_REGEXP.test('#anchor')).toBe(true);
  });

  it('rejects javascript: and other dangerous schemes', () => {
    expect(ALLOWED_URI_REGEXP.test('javascript:alert(1)')).toBe(false);
    expect(ALLOWED_URI_REGEXP.test('vbscript:msgbox(1)')).toBe(false);
    // data: URLs are intentionally NOT allowed in href position by
    // this regexp (DOMPurify pairs it with attribute-context rules);
    // image-context data: URLs survive via CSP img-src.
    expect(ALLOWED_URI_REGEXP.test('data:text/html,<script>alert(1)</script>')).toBe(false);
  });
});

describe('integration: a real-world wide marketing email', () => {
  // The screenshot that motivated this change was a PledgeBox
  // newsletter built around the classic 640-px hero table with a
  // fixed-width image inside it. The user's correction was: "if an
  // email wants to be 600px wide, that's fine — just put white space
  // around it." So the contract here is that the builder PRESERVES
  // the email structure verbatim and does NOT inject CSS that fights
  // the email's own design.
  const wideEmail = `
    <table width="640" cellpadding="0" cellspacing="0" align="center"
           style="width:640px; max-width:640px;">
      <tr>
        <td>
          <img src="https://example.com/hero.jpg" width="640" height="320"
               style="display:block;width:640px;height:auto;">
        </td>
      </tr>
      <tr>
        <td style="padding:24px;">
          <h1 style="font-size:32px;line-height:1.2;margin:0;">
            UltraPill — Tungsten Carbide Micro Cutter
          </h1>
        </td>
      </tr>
    </table>
  `;

  it('preserves the email markup verbatim — width attributes and inline styles intact', () => {
    const out = buildMessageSrcDoc(wideEmail);
    const doc = parseSrcDoc(out);

    const table = doc.querySelector('table');
    expect(table?.getAttribute('width')).toBe('640');
    expect(table?.getAttribute('align')).toBe('center');
    expect(table?.getAttribute('style')).toContain('width:640px');

    const img = doc.querySelector('img');
    expect(img?.getAttribute('width')).toBe('640');
    expect(img?.getAttribute('height')).toBe('320');
    expect(img?.getAttribute('style')).toContain('width:640px');

    const h1 = doc.querySelector('h1');
    expect(h1?.getAttribute('style')).toContain('font-size:32px');
  });

  it('does NOT pair the email with override CSS that would change its layout', () => {
    const out = buildMessageSrcDoc(wideEmail);
    const doc = parseSrcDoc(out);
    const css = doc.querySelector('style')?.textContent ?? '';

    // None of the rules that previously broke the email design.
    expect(css).not.toMatch(/max-width:\s*100%\s*!important/);
    expect(css).not.toMatch(/width:\s*auto\s*!important/);
    expect(css).not.toMatch(/table\s*\{/);
    expect(css).not.toMatch(/\bimg\s*\{/);
    expect(css).not.toMatch(/\[width\]/);
    expect(css).not.toMatch(/body\s*\*\s*\{/);
    expect(css).not.toMatch(/!important/);
    expect(css).not.toMatch(/\bfilter:/);
  });
});
