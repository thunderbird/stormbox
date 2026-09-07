/**
 * Scripted paste into the rich text editor. Browsers strip the clipboard
 * data from a synthetic `ClipboardEvent`, so scripts (the feature tour)
 * hand the editor a payload through this custom event instead and the
 * editor routes it through the same paths a native paste takes.
 */

export const SCRIPTED_PASTE_EVENT = 'scripted-paste';

export interface ScriptedPasteDetail {
  /** Plain text; over a non-empty selection a lone URL links the selection. */
  text?: string;
  /** Clipboard files; raster images inline, everything else attaches. */
  files?: File[];
}

export function dispatchScriptedPaste(target: EventTarget, detail: ScriptedPasteDetail): void {
  target.dispatchEvent(new CustomEvent<ScriptedPasteDetail>(SCRIPTED_PASTE_EVENT, { detail }));
}

export function scriptedPasteDetail(event: Event): ScriptedPasteDetail | null {
  if (!(event instanceof CustomEvent)) return null;
  const detail: unknown = event.detail;
  return detail != null && typeof detail === 'object' ? detail as ScriptedPasteDetail : null;
}
