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
 *   - the email's own design is mostly preserved, but fixed-width
 *     content is constrained to the iframe width so the reading pane
 *     never needs horizontal scrolling.
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

    // We DO constrain common fixed-width content so the message pane
    // never develops horizontal scrolling.
    expect(css).toMatch(/img,\s*video,\s*canvas,\s*svg\s*\{[^}]*max-width:\s*100%/);
    expect(css).toMatch(/table\s*\{[^}]*max-width:\s*100%/);
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
  it('pins the sandbox contract: same-origin + popups, no allow-scripts', () => {
    // Same-origin lets the parent measure the iframe height and rewrite
    // links. Popup permissions let target=_blank links open in a new
    // tab. No allow-scripts means any <script> that survives the
    // sanitizer is still inert at runtime (defence in depth on top of
    // the CSP).
    const tokens = IFRAME_SANDBOX.split(/\s+/).filter(Boolean).sort();
    expect(tokens).toEqual([
      'allow-popups',
      'allow-popups-to-escape-sandbox',
      'allow-same-origin',
    ]);
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
  // fixed-width image inside it. The current reading-pane contract is
  // that even these emails must not create horizontal message scrolling.
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

  it('preserves the email markup while pairing it with overflow-prevention CSS', () => {
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

    const css = doc.querySelector('style')?.textContent ?? '';
    expect(css).toMatch(/img,\s*video,\s*canvas,\s*svg\s*\{[^}]*max-width:\s*100%/);
    expect(css).toMatch(/table\s*\{[^}]*max-width:\s*100%/);
  });

  it('does NOT pair the email with broad override CSS beyond overflow prevention', () => {
    const out = buildMessageSrcDoc(wideEmail);
    const doc = parseSrcDoc(out);
    const css = doc.querySelector('style')?.textContent ?? '';

    expect(css).not.toMatch(/body\s*\*\s*\{/);
    expect(css).not.toMatch(/!important/);
    expect(css).not.toMatch(/\bfilter:/);
  });
});
