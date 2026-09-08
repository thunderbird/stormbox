/**
 * Drives the compose editor for the Attachments and Clipboard spotlight
 * through the same DOM the user acts on: text is written into the document
 * (Squire tracks mutations; the tour holds the session's autosave), then a URL
 * is pasted over a selection and an image file at the caret via the editor's
 * scripted paste. Every helper is a no-op when the tour composer is not on
 * screen.
 */
import { dispatchScriptedPaste } from '../utils/scripted-paste';

// Scoped to the expanded dialog: minimized sessions keep theirs mounted, hidden.
const EDITOR_SELECTOR = '.compose-dialog--expanded .rich-text-editor .editor';

export const TOUR_EDITOR_TARGETS = {
  editor: EDITOR_SELECTOR,
  link: `${EDITOR_SELECTOR} a[href]`,
  image: `${EDITOR_SELECTOR} img`,
} as const;

export const TOUR_BODY_TEXT = 'Details are on the Thunderbird site.';
export const TOUR_LINK_TEXT = 'Thunderbird site';
export const TOUR_LINK_URL = 'https://www.thunderbird.net/';

const TOUR_IMAGE_WIDTH = 280;
const TOUR_IMAGE_HEIGHT = 130;

let generation = 0;

/** Blocks the demo wrote into, in order; `reset` removes the ones it added and empties the one it reused. */
let addedBlocks: HTMLElement[] = [];
let reusedBlock: HTMLElement | null = null;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function tourEditor(): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  const root = document.querySelector(EDITOR_SELECTOR);
  return root instanceof HTMLElement ? root : null;
}

/** Stops any typing still in progress. */
export function cancelTourEditorDemo(): void {
  generation += 1;
}

function emptyParagraph(): HTMLParagraphElement {
  const paragraph = document.createElement('p');
  paragraph.appendChild(document.createElement('br'));
  return paragraph;
}

/**
 * An empty block to write into. The first demo block is the editor's own
 * leading empty paragraph when there is one (a seeded signature follows it),
 * otherwise a new paragraph at the top; later blocks follow the previous
 * demo block so the body reads in the order the demo wrote it.
 */
function freshParagraph(root: HTMLElement): HTMLElement {
  const previous = [...addedBlocks].reverse().find((block) => root.contains(block))
    ?? (reusedBlock && root.contains(reusedBlock) ? reusedBlock : null);
  if (previous) {
    const paragraph = emptyParagraph();
    previous.after(paragraph);
    addedBlocks.push(paragraph);
    return paragraph;
  }
  const first = root.firstElementChild;
  if (first instanceof HTMLElement && (first.textContent ?? '') === '' && first.querySelector('img') == null) {
    reusedBlock = first;
    return first;
  }
  const paragraph = emptyParagraph();
  root.prepend(paragraph);
  addedBlocks.push(paragraph);
  return paragraph;
}

function select(range: Range): void {
  const selection = window.getSelection();
  if (!selection) return;
  selection.removeAllRanges();
  selection.addRange(range);
}

function placeCaret(node: Node, offset: number): void {
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  select(range);
}

/**
 * Types `text` into a fresh paragraph one character per `perCharMs`.
 * Resolves with the text node, or null when the editor left or the demo
 * was cancelled part-way.
 */
export async function typeTourBody(text: string, perCharMs: number): Promise<Text | null> {
  const root = tourEditor();
  if (!root) return null;
  generation += 1;
  const myGeneration = generation;
  const paragraph = freshParagraph(root);
  paragraph.querySelector('br')?.remove();
  const textNode = document.createTextNode('');
  paragraph.appendChild(textNode);
  root.focus({ preventScroll: true });
  for (let length = 1; length <= text.length; length += 1) {
    if (myGeneration !== generation || !root.contains(textNode)) return null;
    textNode.data = text.slice(0, length);
    placeCaret(textNode, length);
    if (perCharMs > 0) await delay(perCharMs);
  }
  return myGeneration === generation ? textNode : null;
}

/** Selects `phrase` inside `textNode` the way a drag would; false when it is not there. */
export function selectTourPhrase(textNode: Text, phrase: string): boolean {
  const root = tourEditor();
  if (!root || !root.contains(textNode)) return false;
  const start = textNode.data.indexOf(phrase);
  if (start < 0) return false;
  root.focus({ preventScroll: true });
  const range = document.createRange();
  range.setStart(textNode, start);
  range.setEnd(textNode, start + phrase.length);
  select(range);
  return true;
}

/** Pastes `url` over the current selection; the editor turns the selected text into a link. */
export function pasteTourUrl(url: string): boolean {
  const root = tourEditor();
  if (!root) return false;
  dispatchScriptedPaste(root, { text: url });
  return true;
}

function renderTourImage(): Promise<File | null> {
  const canvas = document.createElement('canvas');
  if (typeof canvas.getContext !== 'function' || typeof canvas.toBlob !== 'function') {
    return Promise.resolve(null);
  }
  canvas.width = TOUR_IMAGE_WIDTH;
  canvas.height = TOUR_IMAGE_HEIGHT;
  const context = canvas.getContext('2d');
  if (!context) return Promise.resolve(null);
  const sky = context.createLinearGradient(0, 0, 0, TOUR_IMAGE_HEIGHT);
  sky.addColorStop(0, '#1373d9');
  sky.addColorStop(1, '#9bc9ff');
  context.fillStyle = sky;
  context.fillRect(0, 0, TOUR_IMAGE_WIDTH, TOUR_IMAGE_HEIGHT);
  context.fillStyle = 'rgba(255, 255, 255, 0.85)';
  context.beginPath();
  context.arc(TOUR_IMAGE_WIDTH * 0.72, TOUR_IMAGE_HEIGHT * 0.34, 18, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = '#2d5a8c';
  context.beginPath();
  context.moveTo(0, TOUR_IMAGE_HEIGHT);
  context.lineTo(TOUR_IMAGE_WIDTH * 0.3, TOUR_IMAGE_HEIGHT * 0.45);
  context.lineTo(TOUR_IMAGE_WIDTH * 0.55, TOUR_IMAGE_HEIGHT * 0.8);
  context.lineTo(TOUR_IMAGE_WIDTH * 0.75, TOUR_IMAGE_HEIGHT * 0.55);
  context.lineTo(TOUR_IMAGE_WIDTH, TOUR_IMAGE_HEIGHT);
  context.closePath();
  context.fill();
  return new Promise((resolve) => {
    canvas.toBlob((blob) => {
      resolve(blob ? new File([blob], 'photo.png', { type: 'image/png' }) : null);
    }, 'image/png');
  });
}

/** Pastes a small generated PNG into a fresh paragraph; the editor inlines it like a clipboard image. */
export async function pasteTourImage(): Promise<boolean> {
  const root = tourEditor();
  if (!root) return false;
  const file = await renderTourImage();
  if (!file || !tourEditor()) return false;
  const paragraph = freshParagraph(root);
  root.focus({ preventScroll: true });
  placeCaret(paragraph, 0);
  dispatchScriptedPaste(root, { files: [file] });
  return true;
}

/** Removes what the demo wrote and waits for the editor to sync the change to the draft. */
export async function resetTourEditor(): Promise<void> {
  cancelTourEditorDemo();
  const root = tourEditor();
  const blocks = addedBlocks;
  const reused = reusedBlock;
  addedBlocks = [];
  reusedBlock = null;
  if (!root) return;
  for (const block of blocks) {
    if (root.contains(block)) block.remove();
  }
  // A plain empty paragraph again, without the alignment an image paste set.
  if (reused && root.contains(reused)) reused.replaceWith(emptyParagraph());
  // Squire reports the mutation from an observer callback; the composer
  // stores the restored body before the caller decides the draft's fate.
  await delay(0);
}
