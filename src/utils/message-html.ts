/**
 * Build the srcdoc payload for the message-view HTML iframe.
 *
 * Why an iframe (and not just inline HTML in the Vue component):
 *  - Style isolation. HTML emails routinely ship their own <style>
 *    blocks and DOMPurify allows them through. Without an iframe those
 *    rules cascade out and reflow the surrounding webmail UI — the
 *    earlier symptom was that EVERY email appeared at one fixed width
 *    because each one's <style> was the last cascade winner against
 *    the host stylesheet.
 *  - Security. The iframe is sandboxed (no allow-scripts) and carries
 *    a strict CSP, so even if a stray <script> survived the sanitizer
 *    the document cannot execute it.
 *
 * What we deliberately do NOT do:
 *  - Override the email's widths. If a marketing email is designed as
 *    a 640-px hero card we let it render at 640px and put whitespace
 *    around it. Forcing tables/images to `max-width: 100% !important`
 *    flattens those carefully-laid-out designs into a wall of left-
 *    aligned content with broken proportions (PLEDGEBOX/UltraPill was
 *    the regression report). The iframe by itself solves the original
 *    "every email has the same locked width" bug; aggressive overrides
 *    on top of it create a new, worse bug.
 *  - Rewrite arbitrary email colors. The email's design wins. We only
 *    set the iframe document's default canvas/text colors so unstyled
 *    or lightly-styled HTML has readable dark-mode defaults.
 *
 * Bulwark (https://github.com/bulwarkmail/webmail) takes the same
 * iframe + sandbox + srcdoc approach in its email-viewer. Roundcube's
 * classic pipeline does inline rendering after a heavy custom
 * sanitizer (rcube_washtml); for us, iframe + DOMPurify is the
 * simpler equivalent and gets style isolation for free.
 */

/**
 * URI scheme allowlist for DOMPurify. Same set Bulwark uses for its
 * iframe srcdoc: standard web schemes plus `cid:` so inline images
 * survive sanitisation (we may rewrite them to blob URLs later).
 */
export const ALLOWED_URI_REGEXP =
  /^(?:(?:https?|mailto|tel|cid):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i;

/**
 * Content-Security-Policy applied INSIDE the iframe. The outer document
 * is unaffected. We forbid script execution entirely (default-src 'none'
 * + no script-src), allow inline styles and fonts, and permit images /
 * media via http/https/data/blob (the sanitizer already filters scheme
 * via ALLOWED_URI_REGEXP).
 */
export const IFRAME_CSP = [
  "default-src 'none'",
  "img-src data: blob: http: https: cid:",
  "style-src 'unsafe-inline'",
  "font-src data: http: https:",
  "media-src data: blob: http: https:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
].join('; ');

/**
 * Minimal stylesheet injected at the top of the iframe body. The
 * guiding principle is "do as little as possible" — the email's own
 * design has to come through intact, including its widths, alignment,
 * fonts, colors, and backgrounds.
 *
 * Specifically:
 *  - We zero out the user-agent's default 8-px body margin so the
 *    iframe content starts flush, otherwise a thin band of host
 *    background bleeds through at every edge of the iframe.
 *  - We provide a sans-serif default for emails that contain only
 *    plain text or unstyled markup. The vast majority of HTML emails
 *    set their own font-family in inline styles, so this default only
 *    matters for the "received as text/html but contains no styling"
 *    edge case.
 *  - We set default background/text colors on html/body. This is enough
 *    to fix simple HTML bodies like "<p>test</p>" in dark mode without
 *    adding the kind of global inversion/filter rules that break real
 *    marketing email designs.
 *  - We constrain replaced elements and common fixed-width containers
 *    to the iframe width so message bodies never require horizontal
 *    scrolling in the reading pane. We intentionally avoid colour,
 *    typography, spacing, or other broad design rewrites.
 */
export const BODY_THEME_COLORS = {
  light: {
    background: '#ffffff',
    color: '#111827',
  },
  dark: {
    background: '#11131a',
    color: '#e6e8ef',
  },
};

export function buildBodyCss(colorScheme = 'light') {
  const colors = Object.prototype.hasOwnProperty.call(BODY_THEME_COLORS, colorScheme)
    ? BODY_THEME_COLORS[colorScheme]
    : BODY_THEME_COLORS.light;
  return `
  html, body {
    margin: 0;
    padding: 0;
    background: ${colors.background};
    color: ${colors.color};
    /* The host (.message-view__body) is the sole scroll container for
     * the open message. The iframe document must never grow its own
     * scrollbars: we already size the iframe element to the document's
     * scroll height (post-zoom) from MessageView.vue, so any residual
     * iframe-level scrollbar would be visual noise stacked beside the
     * host's scrollbar, not a navigation affordance. */
    overflow: hidden;
  }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    overflow-wrap: anywhere;
  }
  img, video, canvas, svg {
    max-width: 100%;
    height: auto;
  }
  table {
    max-width: 100%;
  }
  div, section, article, main, header, footer, aside, table, tbody, thead, tfoot, tr, td, th {
    max-width: 100%;
  }
`;
}

/**
 * Build the srcdoc string used for the message-view iframe.
 *
 * @param {string} sanitizedHtml HTML that has already been passed
 *   through DOMPurify (or equivalent). Pass an empty string for an
 *   empty document.
 * @param {object} [opts]
 * @param {string} [opts.colorScheme='light'] CSS color-scheme value.
 *   Also controls the iframe document's default canvas/text colors.
 * @returns {string} Self-contained HTML document suitable for use as
 *   the `srcdoc` attribute of an iframe.
 */
export function buildMessageSrcDoc(sanitizedHtml: string, opts: { colorScheme?: string } = {}) {
  const colorScheme = opts.colorScheme === 'dark' ? 'dark' : 'light';
  const body = sanitizedHtml || '';
  const bodyCss = buildBodyCss(colorScheme);

  return `<!DOCTYPE html>
<html style="color-scheme: ${colorScheme};">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${IFRAME_CSP}">
<style>${bodyCss}</style>
</head>
<body>${body}</body>
</html>`;
}

/**
 * Sandbox attribute for the message-view iframe.
 *
 * Notably absent: `allow-scripts`. Without it the iframe document
 * cannot execute any inline or external JavaScript, even if the
 * sanitizer somehow misses a <script> element. `allow-same-origin`
 * is required so the parent (Vue component) can read
 * `iframe.contentDocument` to wire up auto-resize and to retarget
 * `<a>` clicks to a new tab.
 */
export const IFRAME_SANDBOX =
  'allow-same-origin allow-popups allow-popups-to-escape-sandbox';
