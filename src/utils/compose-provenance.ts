export const TRACKED_ORIGIN_ATTRIBUTE = 'data-stormbox-origin';
export const TRACKED_ORIGIN_TOUCHED_ATTRIBUTE = 'data-stormbox-origin-touched';
export const IDENTITY_SIGNATURE_ORIGIN = 'identity-signature';
export const QUOTED_CONTENT_BOUNDARY_ATTRIBUTE = 'data-stormbox-quoted-content';

export interface TrackedOriginState {
  id: string;
  present: boolean;
  touched: boolean;
}

const INTERNAL_ATTRIBUTE_PREFIX = 'data-stormbox-';
const TEXT_BLOCKS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DIV', 'DL', 'DT',
  'FIGCAPTION', 'FIGURE', 'FOOTER', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'HEADER', 'LI', 'OL', 'P', 'PRE', 'SECTION', 'TABLE', 'TBODY', 'TD',
  'TFOOT', 'TH', 'THEAD', 'TR', 'UL',
]);

function htmlTemplate(html: string): HTMLTemplateElement | null {
  if (typeof document === 'undefined') return null;
  const template = document.createElement('template');
  template.innerHTML = String(html ?? '');
  return template;
}

function hasInternalAttribute(element: Element): boolean {
  return Array.from(element.attributes)
    .some((attribute) => attribute.name.toLowerCase().startsWith(INTERNAL_ATTRIBUTE_PREFIX));
}

function removeInternalAttributes(element: Element): void {
  for (const attribute of Array.from(element.attributes)) {
    if (attribute.name.toLowerCase().startsWith(INTERNAL_ATTRIBUTE_PREFIX)) {
      element.removeAttribute(attribute.name);
    }
  }
}

export function hasInternalProvenanceAttribute(html: string): boolean {
  const value = String(html ?? '');
  let index = 0;
  let remainingSteps = (value.length * 2) + 16;
  while (index < value.length) {
    if (remainingSteps <= 0) return true;
    remainingSteps -= 1;
    const tagStart = value.indexOf('<', index);
    if (tagStart < 0) return false;
    if (value.startsWith('<!--', tagStart)) {
      const commentEnd = value.indexOf('-->', tagStart + 4);
      index = commentEnd < 0 ? value.length : commentEnd + 3;
      continue;
    }

    let cursor = tagStart + 1;
    if (value[cursor] === '/' || value[cursor] === '!' || value[cursor] === '?') {
      index = cursor + 1;
      continue;
    }
    if (!/[A-Za-z]/.test(value[cursor] ?? '')) {
      index = cursor;
      continue;
    }
    while (/[^\s/>]/.test(value[cursor] ?? '')) cursor += 1;

    while (cursor < value.length) {
      if (remainingSteps <= 0) return true;
      remainingSteps -= 1;
      while (/\s/.test(value[cursor] ?? '')) cursor += 1;
      if (value[cursor] === '>' || value[cursor] === '<') break;
      if (value[cursor] === '/' && value[cursor + 1] === '>') break;

      const stepStart = cursor;
      const nameStart = cursor;
      while (/[^\s=/>]/.test(value[cursor] ?? '')) cursor += 1;
      const name = value.slice(nameStart, cursor).toLowerCase();
      if (name.startsWith(INTERNAL_ATTRIBUTE_PREFIX)) return true;

      while (/\s/.test(value[cursor] ?? '')) cursor += 1;
      if (value[cursor] === '=') {
        cursor += 1;
        while (/\s/.test(value[cursor] ?? '')) cursor += 1;
        const quote = value[cursor];
        if (quote === '"' || quote === "'") {
          cursor += 1;
          const valueEnd = value.indexOf(quote, cursor);
          cursor = valueEnd < 0 ? value.length : valueEnd + 1;
        } else {
          while (/[^\s>]/.test(value[cursor] ?? '')) cursor += 1;
        }
      }
      if (cursor <= stepStart) cursor = stepStart + 1;
    }
    index = cursor + 1;
  }
  return false;
}

function originElement(root: ParentNode, originId: string): HTMLElement | null {
  return Array.from(root.querySelectorAll<HTMLElement>(`[${TRACKED_ORIGIN_ATTRIBUTE}]`))
    .find((element) => element.getAttribute(TRACKED_ORIGIN_ATTRIBUTE) === originId)
    ?? null;
}

export function wrapTrackedOrigin(
  originId: string,
  html: string,
  { touched = false }: { touched?: boolean } = {},
): string {
  const touchedAttribute = touched
    ? ` ${TRACKED_ORIGIN_TOUCHED_ATTRIBUTE}="true"`
    : '';
  return `<div ${TRACKED_ORIGIN_ATTRIBUTE}="${originId}"${touchedAttribute}`
    + `>${html}</div>`;
}

export function wrapQuotedContent(html: string): string {
  if (!html) return '';
  return `<div ${QUOTED_CONTENT_BOUNDARY_ATTRIBUTE}="true"`
    + ` style="display:contents">${html}</div>`;
}

/**
 * Remove runtime-only compose wrappers while retaining their rendered content.
 * Workers cannot safely unwrap HTML without a parser, so they leave it unchanged.
 */
export function stripInternalProvenanceHtml(html: string): string {
  const value = String(html ?? '');
  if (!hasInternalProvenanceAttribute(value)) return value;
  const template = htmlTemplate(value);
  if (!template) return value;

  const marked = Array.from(template.content.querySelectorAll<HTMLElement>('*'))
    .filter(hasInternalAttribute)
    .reverse();
  for (const element of marked) {
    const isWrapper = element.hasAttribute(TRACKED_ORIGIN_ATTRIBUTE)
      || element.hasAttribute(QUOTED_CONTENT_BOUNDARY_ATTRIBUTE);
    removeInternalAttributes(element);
    if (isWrapper) element.replaceWith(...Array.from(element.childNodes));
  }
  return template.innerHTML;
}

export function trackedOriginState(html: string, originId: string): TrackedOriginState {
  const template = htmlTemplate(html);
  if (!template) {
    const escaped = originId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const opening = new RegExp(
      `<[^>]+${TRACKED_ORIGIN_ATTRIBUTE}\\s*=\\s*(?:"${escaped}"|'${escaped}'|${escaped})(?:\\s|>)`,
      'i',
    );
    const present = opening.test(String(html ?? ''));
    const touched = present && new RegExp(
      `${TRACKED_ORIGIN_TOUCHED_ATTRIBUTE}\\s*=\\s*(?:"true"|'true'|true)`,
      'i',
    ).test(String(html ?? ''));
    return { id: originId, present, touched };
  }
  const element = originElement(template.content, originId);
  return {
    id: originId,
    present: !!element,
    touched: element?.getAttribute(TRACKED_ORIGIN_TOUCHED_ATTRIBUTE) === 'true',
  };
}

export function replaceTrackedOriginHtml(
  html: string,
  originId: string,
  replacementHtml: string | null,
): { html: string; replaced: boolean } {
  const template = htmlTemplate(html);
  if (!template) return { html: String(html ?? ''), replaced: false };
  const element = originElement(template.content, originId);
  if (!element) return { html: String(html ?? ''), replaced: false };
  if (replacementHtml === null) {
    element.remove();
  } else {
    const replacement = htmlTemplate(replacementHtml);
    if (!replacement) return { html: String(html ?? ''), replaced: false };
    element.replaceWith(replacement.content);
  }
  return { html: template.innerHTML, replaced: true };
}

export function insertBeforeQuotedContent(html: string, insertedHtml: string): string {
  const template = htmlTemplate(html);
  if (!template) return `${String(html ?? '')}${insertedHtml}`;
  const quoted = template.content.querySelector<HTMLElement>(
    `[${QUOTED_CONTENT_BOUNDARY_ATTRIBUTE}]`,
  );
  const insertion = htmlTemplate(insertedHtml);
  if (!insertion) return template.innerHTML;
  if (quoted) quoted.before(insertion.content);
  else template.content.append(insertion.content);
  return template.innerHTML;
}

export function removeTrackedOriginRegion(html: string, originId: string): string {
  const template = htmlTemplate(html);
  if (!template) return stripInternalProvenanceHtml(html);
  originElement(template.content, originId)?.remove();
  return stripInternalProvenanceHtml(template.innerHTML);
}

export function trackedHtmlPlainText(
  html: string,
  originText: ReadonlyMap<string, string | null> = new Map(),
): string {
  const template = htmlTemplate(html);
  if (!template) return '';
  for (const [originId, text] of originText) {
    const element = originElement(template.content, originId);
    if (!element) continue;
    if (text === null) {
      element.remove();
    } else {
      element.replaceChildren(document.createTextNode(text));
    }
  }
  const container = document.createElement('div');
  container.append(template.content);
  let text = '';
  const blockBreak = () => {
    if (text && !text.endsWith('\n')) text += '\n';
  };
  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.nodeValue ?? '';
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) {
      return;
    }
    if (node.nodeName === 'BR') {
      text += '\n';
      return;
    }
    const block = node.nodeType === Node.ELEMENT_NODE && TEXT_BLOCKS.has(node.nodeName);
    if (block) blockBreak();
    node.childNodes.forEach(visit);
    if (block) blockBreak();
  };
  container.childNodes.forEach(visit);
  return text.replace(/\n+$/u, '');
}
