/**
 * Pure mapping from folder rows to the icons, accent colour, and
 * display order the FolderTree uses. Keeps presentation off the
 * mail-store and out of the FolderNode template so unit tests can
 * pin role -> icon and role -> ordering directly.
 *
 * The icon set is loaded as raw SVG strings via Vite's '?raw' suffix
 * imports. They are bundled at build time and rendered through
 * v-html in FolderNode; the source is the project's own asset
 * pipeline, never untrusted email content (see
 * docs/architecture/safe-rendering.md once that lands).
 */

import archiveIcon from '../assets/icons/tb-folder-archive.svg?raw';
import draftIcon from '../assets/icons/tb-folder-draft.svg?raw';
import folderIcon from '../assets/icons/tb-folder.svg?raw';
import inboxIcon from '../assets/icons/tb-folder-inbox.svg?raw';
import newsletterIcon from '../assets/icons/tb-folder-newsletter.svg?raw';
import rssFolderIcon from '../assets/icons/tb-folder-rss.svg?raw';
import scheduledIcon from '../assets/icons/tb-folder-scheduled.svg?raw';
import sentIcon from '../assets/icons/tb-folder-sent.svg?raw';
import spamIcon from '../assets/icons/tb-folder-spam.svg?raw';
import trashIcon from '../assets/icons/tb-folder-trash.svg?raw';

import type { MailboxRole } from '../constants/states';

export const ROLE_ICON: Partial<Record<MailboxRole, string>> = {
  inbox: inboxIcon,
  sent: sentIcon,
  drafts: draftIcon,
  archive: archiveIcon,
  trash: trashIcon,
  junk: spamIcon,
};

export const ROLE_COLOR: Partial<Record<MailboxRole, string>> = {
  inbox: '#1a73e8',
  sent: '#188038',
  drafts: '#7e22ce',
  archive: '#8b5a2b',
  trash: '#5f6368',
  junk: '#d93025',
  important: '#f9ab00',
  flagged: '#c5221f',
  all: '#5f6368',
};

interface NamedFolderPresentation {
  icon: string;
  color: string;
}

export const DEFAULT_FOLDER_BY_NAME: Record<string, NamedFolderPresentation> = {
  newsletters: { icon: newsletterIcon, color: '#7378a6' },
  feeds: { icon: rssFolderIcon, color: '#f97316' },
};

// Goldenrod tone matches the default folder icon colour in
// Thunderbird Desktop so user-created folders read as Thunderbird
// folders rather than greyed-out.
export const DEFAULT_FOLDER_COLOR = '#e4b85c';

export interface FolderPresentationInput {
  name?: string | null;
  role?: MailboxRole | null;
  is_starred?: 0 | 1 | null;
  /** Mail-store decoration marking the managed Send Later mailbox. */
  is_scheduled?: 0 | 1 | null;
}

function isScheduledFolder(folder: FolderPresentationInput): boolean {
  return Number(folder.is_scheduled ?? 0) === 1;
}

export function defaultFolderKey(name: string | null | undefined): string {
  return String(name ?? '').trim().toLowerCase();
}

/**
 * Resolve the visual {icon, color} pair for a folder. Role wins; the
 * named-folder map is a fallback for user-named special folders that
 * the server hasn't tagged with a JMAP role; everything else gets
 * the generic folder icon and the goldenrod tone.
 */
export function folderPresentation(folder: FolderPresentationInput): NamedFolderPresentation {
  if (isScheduledFolder(folder)) {
    return { icon: scheduledIcon, color: '#0e7490' };
  }
  const role = folder.role ?? null;
  const namedDefault = DEFAULT_FOLDER_BY_NAME[defaultFolderKey(folder.name)];
  return {
    icon: (role && ROLE_ICON[role]) ?? namedDefault?.icon ?? folderIcon,
    color: (role && ROLE_COLOR[role]) ?? namedDefault?.color ?? DEFAULT_FOLDER_COLOR,
  };
}

/**
 * Display order for the role-anchored "main" folders. Anything else
 * sorts after them and falls back to alphabetical.
 */
export function folderSortKey(folder: FolderPresentationInput): number {
  // The managed Scheduled mailbox is roleless but anchored right
  // below Drafts, matching where the messages it holds came from.
  if (isScheduledFolder(folder)) return 2;
  switch (folder.role) {
    case 'inbox': return 0;
    case 'drafts': return 1;
    case 'sent': return 3;
    case 'archive': return 4;
    case 'junk': return 5;
    case 'trash': return 6;
    default: return 100;
  }
}

/**
 * True for folders that should appear in the role-anchored main
 * group (Inbox/Drafts/Scheduled/Sent/Archive/Trash/Junk) of the
 * folder tree.
 */
export function isMainFolder(folder: FolderPresentationInput): boolean {
  if (isScheduledFolder(folder)) return true;
  return folder.role != null && ROLE_ICON[folder.role] != null;
}

/**
 * Sidebar sibling comparator: role order first (system folders keep
 * their fixed positions), then starred — the client-local priority
 * pin — then locale-aware name. Sidebar-only by design: the manager
 * and create dialogs stay in structural order so toggling a star
 * never reorders the list being managed.
 */
export function folderCompare(
  a: FolderPresentationInput,
  b: FolderPresentationInput,
): number {
  return (
    folderSortKey(a) - folderSortKey(b)
    || Number(b.is_starred ?? 0) - Number(a.is_starred ?? 0)
    || String(a.name ?? '').localeCompare(String(b.name ?? ''))
  );
}

export interface FolderTreeNodeInput extends FolderPresentationInput {
  id: number;
  parent_id?: number | null;
  is_deleted?: 0 | 1 | null;
}

/**
 * Depth-first flattening of one account's folders in structural order
 * (role, then name — never the sidebar's starred grouping), for pickers
 * that show the tree as an indented flat list.
 */
export function flattenFolderTree<T extends FolderTreeNodeInput>(
  accountFolders: T[],
): Array<{ folder: T; depth: number }> {
  const byParent = new Map<number | 'ROOT', T[]>();
  for (const folder of accountFolders) {
    if (Number(folder.is_deleted) === 1) continue;
    const key = folder.parent_id ?? 'ROOT';
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(folder);
  }
  for (const list of byParent.values()) {
    list.sort((a, b) => folderSortKey(a) - folderSortKey(b)
      || String(a.name ?? '').localeCompare(String(b.name ?? '')));
  }
  const out: Array<{ folder: T; depth: number }> = [];
  function walk(parentKey: number | 'ROOT', depth: number) {
    for (const folder of byParent.get(parentKey) ?? []) {
      out.push({ folder, depth });
      walk(folder.id, depth + 1);
    }
  }
  walk('ROOT', 0);
  return out;
}
