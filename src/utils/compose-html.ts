import DOMPurify from 'dompurify';

import { buildInlineImageDataUrl } from './message-html';

const EDITOR_ALLOWED_URI_REGEXP =
  /^(?:(?:https?|mailto|tel|cid|blob):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i;

const EDITOR_STYLE_PROPERTIES = new Set([
  'background-color',
  'color',
  'direction',
  'font-family',
  'font-size',
  'font-style',
  'font-weight',
  'height',
  'line-height',
  'margin-left',
  'margin-right',
  'max-height',
  'max-width',
  'text-align',
  'text-decoration',
  'vertical-align',
  'white-space',
  'width',
]);

function isLocalImageSource(value: string): boolean {
  const trimmed = value.trim();
  if (/^(?:cid|blob):/i.test(trimmed)) return true;
  const data = /^data:([^;,]+);base64,(.*)$/is.exec(trimmed);
  return !!data && buildInlineImageDataUrl(data[2], data[1]) != null;
}

/**
 * Sanitize HTML before mounting it in Squire's host document.
 *
 * Compose formatting uses a narrow set of inline CSS properties. Layout,
 * selectors, URLs, and active elements are excluded so a server draft cannot
 * restyle or overlay the surrounding application.
 */
export function editSafeDraftHtml(html: string): string {
  const sanitized = DOMPurify.sanitize(String(html ?? ''), {
    ALLOWED_URI_REGEXP: EDITOR_ALLOWED_URI_REGEXP,
    FORBID_TAGS: [
      'script', 'iframe', 'object', 'embed', 'form', 'input', 'button',
      'textarea', 'select', 'option', 'svg', 'math', 'base', 'link', 'meta', 'style',
      'audio', 'video', 'source', 'track',
    ],
    FORBID_ATTR: ['srcdoc', 'srcset', 'poster', 'background', 'ping', 'class', 'id'],
  });
  const template = document.createElement('template');
  template.innerHTML = sanitized;
  for (const active of template.content.querySelectorAll(
    'script,iframe,object,embed,form,input,button,textarea,select,option,svg,math,base,link,meta,style,audio,video,source,track',
  )) {
    active.remove();
  }
  for (const element of template.content.querySelectorAll<HTMLElement>('*')) {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      if (name === 'class'
          || name === 'id'
          || name === 'srcdoc'
          || name === 'srcset'
          || name === 'poster'
          || name === 'background'
          || name === 'ping'
          || name.startsWith('on')) {
        element.removeAttribute(attribute.name);
      }
    }
    const source = element.getAttribute('src');
    if (source != null
        && (element.tagName !== 'IMG' || !isLocalImageSource(source))) {
      element.removeAttribute('src');
    }
  }
  for (const element of template.content.querySelectorAll<HTMLElement>('[style]')) {
    const parsed = document.createElement('span').style;
    parsed.cssText = element.getAttribute('style') ?? '';
    element.removeAttribute('style');
    for (const property of Array.from(parsed)) {
      if (!EDITOR_STYLE_PROPERTIES.has(property)) continue;
      const value = parsed.getPropertyValue(property);
      if (/url\s*\(|expression\s*\(|@import|-moz-binding/i.test(value)) continue;
      element.style.setProperty(property, value, parsed.getPropertyPriority(property));
    }
    if (!element.getAttribute('style')) element.removeAttribute('style');
  }
  return template.innerHTML;
}
