import { nextTick } from 'vue';

import type { useComposeStore } from '../stores/compose-store';
import {
  TOUR_BODY_TEXT,
  TOUR_EDITOR_TARGETS,
  TOUR_LINK_TEXT,
  TOUR_LINK_URL,
  pasteTourImage,
  pasteTourUrl,
  resetTourEditor,
  selectTourPhrase,
  typeTourBody,
} from './spotlightEditorDemo';
import {
  SPOTLIGHT_TIMING,
  type SpotlightScript,
  type SpotlightScripts,
  type SpotlightStep,
} from './useFeatureSpotlight';

export type SpotlightSpace = 'contacts' | 'mail';

export interface SpotlightScriptContext {
  composeStore: ReturnType<typeof useComposeStore>;
  currentSpace: () => SpotlightSpace;
  changeSpace: (next: SpotlightSpace) => Promise<void>;
  /** The user prefers reduced motion; scripted typing and pauses collapse to zero. */
  reducedMotion: () => boolean;
}

// Every session keeps its dialog mounted (minimized ones hidden), so composer
// selectors are scoped to the expanded dialog to reach the one on screen.
const COMPOSER = '.compose-dialog--expanded';

export const SPOTLIGHT_TARGETS = {
  composeCard: `${COMPOSER} .compose-dialog__card`,
  composeSubject: `${COMPOSER} #compose-subject`,
  composeMinimize: `${COMPOSER} .icon--minimize`,
  composeDockBar: '.compose-dock',
  composeDock: '.compose-dock__item',
  composeHeader: `${COMPOSER} .compose-dialog__card > header`,
  recipientsTo: `${COMPOSER} .row--to .recipient-input__field`,
  recipientsCcBcc: `${COMPOSER} .recipient-cc-toggles`,
  attachButton: `${COMPOSER} [aria-label="Attach files"]`,
  imageTools: `${COMPOSER} [data-tour="image-tools"]`,
  scheduleMenu: `${COMPOSER} .compose-schedule-menu`,
  scheduleTrigger: `${COMPOSER} .compose-schedule-menu__trigger`,
  scheduleMenuList: `${COMPOSER} .compose-schedule-menu__menu`,
  contactsSpace: '.app-spaces [aria-label="Contacts"]',
  contactsRail: '.contacts-rail',
  contactsAllBook: '.contacts-rail__books > .contacts-rail__book',
  contactsIdentities: '.contacts__identity-section',
  contactsIdentitiesButton: '.contacts__identity-section button',
  contactsList: '.directory-list',
  contactsFirstRow: '.directory-list .contacts__row[data-index="0"]',
  manageFolders: '.folder-tree__manage',
  folderManagerPanel: '.folder-subs__panel',
  folderManagerClose: '.folder-subs__close',
  folderFavorites: '[data-tour="folder-favorites"]',
  sharedFolders: '[data-tour="shared-folders"]',
  userFolders: '[data-tour="user-folders"]',
  folderTree: '.folder-tree',
} as const;

const SCHEDULE_MENU_DISABLED_CLASS = 'app-dropdown--disabled';

/** Subject the drafts spotlight types so the dock tab and header show a draft naming itself. */
export const TOUR_SUBJECT = 'Weekend plans';
export const TOUR_TYPING_MS_PER_CHAR = 55;

interface TourComposer {
  sessionId: string;
  /** False only when the store handed back a session it would not replace (one mid-send). */
  openedByTour: boolean;
  /** The user's expanded session the tour pushed aside, restored on release. */
  displacedSessionId: string | null;
}

/** Upper bounds for work the tour waits on: a dialog mounting, a directory loading, a draft save finishing. */
const DIALOG_OPEN_TIMEOUT_MS = 1500;
const DIRECTORY_LOAD_TIMEOUT_MS = 4000;
const SAVE_SETTLE_TIMEOUT_MS = 6000;
const WAIT_POLL_MS = 50;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** Clicks the first match of `selector`; false when there is none. */
function clickFirst(selector: string): boolean {
  if (typeof document === 'undefined') return false;
  const element = document.querySelector(selector);
  if (!(element instanceof HTMLElement)) return false;
  element.click();
  return true;
}

/** Resolves true once `ready` holds, false when `timeoutMs` passes first. */
async function waitUntil(ready: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!ready()) {
    if (Date.now() >= deadline) return false;
    await delay(WAIT_POLL_MS);
  }
  return true;
}

function waitForSelector(selector: string, timeoutMs: number): Promise<boolean> {
  if (typeof document === 'undefined') return Promise.resolve(false);
  return waitUntil(() => document.querySelector(selector) != null, timeoutMs);
}

/**
 * Builds the six spotlight scripts. The composer scripts share one empty
 * session the tour opens for itself (OB-2.7): a draft the user has open is
 * minimized, never written into, and expanded again on release. Autosave is
 * held on the tour session while it runs, so what the demo writes never
 * becomes a server draft; the session is closed again afterwards unless the
 * user typed into it.
 */
export function createSpotlightScripts(ctx: SpotlightScriptContext): SpotlightScripts {
  let tourComposer: TourComposer | null = null;

  // Steps share the session from the first step even while one of them has
  // it minimized; only a session the user closed mid-tour is replaced.
  function ensureTourComposer(): TourComposer {
    const { composeStore } = ctx;
    if (tourComposer && composeStore.sessions.some((session) => session.id === tourComposer?.sessionId)) {
      return tourComposer;
    }
    const displaced = composeStore.isExpanded ? composeStore.activeSession : null;
    const sessionId = composeStore.open();
    // `open` returns the expanded session unchanged while it is mid-send.
    const openedByTour = sessionId !== displaced?.id;
    if (openedByTour) composeStore.holdAutosave(sessionId);
    tourComposer = {
      sessionId,
      openedByTour,
      displacedSessionId: openedByTour ? displaced?.id ?? null : null,
    };
    return tourComposer;
  }

  // The subject is written straight onto the draft, not through
  // `touchSession`; cleanup clears it again before release.
  let typingGeneration = 0;

  async function typeTourSubject(): Promise<void> {
    const composer = tourComposer;
    if (!composer?.openedByTour) return;
    typingGeneration += 1;
    const myGeneration = typingGeneration;
    const perChar = ctx.reducedMotion() ? 0 : TOUR_TYPING_MS_PER_CHAR;
    for (let length = 1; length <= TOUR_SUBJECT.length; length += 1) {
      const session = ctx.composeStore.sessionById(composer.sessionId);
      if (!session || myGeneration !== typingGeneration) return;
      session.draft.subject = TOUR_SUBJECT.slice(0, length);
      if (perChar > 0) await delay(perChar);
    }
  }

  function clearTourSubject(): void {
    typingGeneration += 1;
    if (!tourComposer) return;
    const session = ctx.composeStore.sessionById(tourComposer.sessionId);
    if (session && session.draft.subject === TOUR_SUBJECT.slice(0, session.draft.subject.length)) {
      session.draft.subject = '';
    }
  }

  function releaseTourComposer(): void {
    clearTourSubject();
    const composer = tourComposer;
    tourComposer = null;
    if (!composer) return;
    const { composeStore } = ctx;
    if (!composeStore.sessionById(composer.sessionId)) return;
    if (!composer.openedByTour) return;
    // A tour-opened session the user never typed into is closed and the draft
    // it displaced comes back; one the user typed into stays, saving again.
    if (!composeStore.isSessionMeaningfullyNonEmpty(composer.sessionId)) {
      void composeStore.discardDraft(composer.sessionId);
      if (composer.displacedSessionId && composeStore.sessionById(composer.displacedSessionId)) {
        composeStore.restore(composer.displacedSessionId);
      }
      return;
    }
    composeStore.releaseAutosaveHold(composer.sessionId);
    if (!composeStore.isExpanded || composeStore.activeSession?.id !== composer.sessionId) {
      composeStore.restore(composer.sessionId);
    }
  }

  // The composer card stays undimmed for every composer step unless the step
  // stages something else (the dock while the draft is minimized).
  function composerStep(step: SpotlightStep): SpotlightStep {
    return {
      stage: [SPOTLIGHT_TARGETS.composeCard],
      ...step,
      prepare: async () => {
        ensureTourComposer();
        await step.prepare?.();
      },
    };
  }

  // `cleanup` runs before the composer is released so it can restore the
  // draft the tour wrote into.
  function composerScript(
    steps: SpotlightStep[],
    cleanup?: () => Promise<void> | void,
  ): SpotlightScript {
    return {
      steps,
      cleanup: async () => {
        await cleanup?.();
        releaseTourComposer();
      },
    };
  }

  function motionMs(ms: number): number {
    return ctx.reducedMotion() ? 0 : ms;
  }

  function scheduleMenuDetails(): HTMLDetailsElement | null {
    if (typeof document === 'undefined') return null;
    const details = document.querySelector(SPOTLIGHT_TARGETS.scheduleMenu);
    return details instanceof HTMLDetailsElement ? details : null;
  }

  let spaceBeforeTour: SpotlightSpace | null = null;
  let identitiesOpenedByTour = false;

  return {
    composeDrafts: composerScript([
      composerStep({
        caption: 'Drafts save themselves as you type, so you can step away from one at any time.',
        // The composer opened by `ensureTourComposer` mounts on the next tick;
        // typing starts once it is on screen.
        prepare: async () => {
          await nextTick();
          if (!ctx.reducedMotion()) await delay(SPOTLIGHT_TIMING.settleMs);
          await typeTourSubject();
        },
        // The typing itself is the demonstration; nothing is ringed.
        targets: [],
        durationMs: 2600,
      }),
      composerStep({
        caption: 'Minimize a draft and it waits in the dock, named by its subject, while you read or reply to other mail.',
        press: SPOTLIGHT_TARGETS.composeMinimize,
        // The store refuses to minimize mid-save, so an in-flight autosave is
        // waited out first.
        prepare: async () => {
          if (!tourComposer) return;
          const { sessionId } = tourComposer;
          await waitUntil(
            () => ctx.composeStore.sessionById(sessionId)?.isSaving !== true,
            SAVE_SETTLE_TIMEOUT_MS,
          );
          ctx.composeStore.minimize(sessionId);
        },
        targets: [SPOTLIGHT_TARGETS.composeDock],
        stage: [SPOTLIGHT_TARGETS.composeDockBar],
        durationMs: 3400,
      }),
      composerStep({
        caption: 'Click it in the dock to pick up where you left off. Open as many drafts as you need.',
        press: SPOTLIGHT_TARGETS.composeDock,
        prepare: () => {
          if (tourComposer) ctx.composeStore.restore(tourComposer.sessionId);
        },
        targets: [SPOTLIGHT_TARGETS.composeHeader],
        durationMs: 3200,
      }),
    ]),

    recipients: composerScript([
      composerStep({
        caption: 'Start typing in To and matching contacts appear. Each address becomes a pill you can edit or remove.',
        targets: [SPOTLIGHT_TARGETS.recipientsTo],
        durationMs: 3800,
      }),
      composerStep({
        caption: 'Cc and Bcc are one click away, and invalid addresses are flagged before the message goes out.',
        targets: [SPOTLIGHT_TARGETS.recipientsCcBcc],
        durationMs: 3600,
      }),
    ]),

    attachments: composerScript(
      [
        composerStep({
          caption: 'Attach picks files from your computer. They upload while you keep writing.',
          targets: [SPOTLIGHT_TARGETS.attachButton],
          durationMs: 3400,
        }),
        composerStep({
          caption: 'Copy an image and paste it into the message. It lands inline, ready to resize and align.',
          // Only a body the tour opened is written into; a borrowed draft
          // keeps its content and the toolbar is ringed instead.
          prepare: async () => {
            if (!tourComposer?.openedByTour) return;
            if (!await pasteTourImage()) return;
            await waitForSelector(TOUR_EDITOR_TARGETS.image, DIALOG_OPEN_TIMEOUT_MS);
          },
          targets: [TOUR_EDITOR_TARGETS.image],
          fallbackTargets: [SPOTLIGHT_TARGETS.imageTools],
          durationMs: 3400,
        }),
        composerStep({
          caption: 'Select some text and paste a URL over it. The text becomes a link, no dialog needed.',
          prepare: async () => {
            if (!tourComposer?.openedByTour) return;
            const perChar = ctx.reducedMotion() ? 0 : TOUR_TYPING_MS_PER_CHAR;
            const textNode = await typeTourBody(TOUR_BODY_TEXT, perChar);
            if (!textNode || !selectTourPhrase(textNode, TOUR_LINK_TEXT)) return;
            // The selection is shown on its own for a beat before the paste.
            await delay(motionMs(SPOTLIGHT_TIMING.settleMs));
            if (!pasteTourUrl(TOUR_LINK_URL)) return;
            await waitForSelector(TOUR_EDITOR_TARGETS.link, DIALOG_OPEN_TIMEOUT_MS);
          },
          targets: [TOUR_EDITOR_TARGETS.link],
          fallbackTargets: [SPOTLIGHT_TARGETS.imageTools],
          durationMs: 4000,
        }),
      ],
      resetTourEditor,
    ),

    sendLater: composerScript(
      [
        composerStep({
          caption: 'Next to Send is a schedule menu.',
          targets: [SPOTLIGHT_TARGETS.scheduleMenu],
          durationMs: 2400,
        }),
        composerStep({
          caption: 'Pick a preset or choose a date and time. Until it goes out, the message waits in Scheduled, where you can still cancel it.',
          press: SPOTLIGHT_TARGETS.scheduleTrigger,
          // Opening the presets menu shows what Send Later offers; a disabled
          // segment (server without the capability) stays closed and is only
          // ringed.
          prepare: () => {
            const details = scheduleMenuDetails();
            if (details && !details.classList.contains(SCHEDULE_MENU_DISABLED_CLASS)) {
              details.open = true;
            }
          },
          targets: [SPOTLIGHT_TARGETS.scheduleMenu, SPOTLIGHT_TARGETS.scheduleMenuList],
          durationMs: 4400,
        }),
      ],
      () => {
        const details = scheduleMenuDetails();
        if (details) details.open = false;
      },
    ),

    contacts: {
      // The contacts space changes layout twice during this tour; rings alone
      // read better than a scrim that keeps re-cutting.
      dim: false,
      steps: [
        {
          caption: 'Contacts have their own space in the toolbar on the left.',
          targets: [SPOTLIGHT_TARGETS.contactsSpace],
          durationMs: 2600,
        },
        {
          caption: 'Address books sit on the left. Drag contacts between them, or add a new book from the header.',
          press: SPOTLIGHT_TARGETS.contactsSpace,
          prepare: async () => {
            const before = ctx.currentSpace();
            if (before === 'contacts') return;
            await ctx.changeSpace('contacts');
            if (ctx.currentSpace() === 'contacts') spaceBeforeTour = before;
          },
          targets: [SPOTLIGHT_TARGETS.contactsRail],
          fallbackTargets: [SPOTLIGHT_TARGETS.contactsSpace],
          durationMs: 3600,
        },
        {
          caption: 'Manage identities sets up each address you send from: display name, signature, Reply-To, and automatic Bcc.',
          press: SPOTLIGHT_TARGETS.contactsIdentitiesButton,
          // Opening the identities directory lists every address the user
          // can send from; the first identity is ringed once it has loaded.
          prepare: async () => {
            if (!clickFirst(SPOTLIGHT_TARGETS.contactsIdentitiesButton)) return;
            identitiesOpenedByTour = true;
            await waitForSelector(SPOTLIGHT_TARGETS.contactsFirstRow, DIRECTORY_LOAD_TIMEOUT_MS);
          },
          targets: [SPOTLIGHT_TARGETS.contactsFirstRow],
          fallbackTargets: [SPOTLIGHT_TARGETS.contactsList, SPOTLIGHT_TARGETS.contactsIdentities],
          durationMs: 5200,
        },
      ],
      cleanup: async () => {
        if (identitiesOpenedByTour) {
          identitiesOpenedByTour = false;
          clickFirst(SPOTLIGHT_TARGETS.contactsAllBook);
        }
        const previous = spaceBeforeTour;
        spaceBeforeTour = null;
        if (previous && ctx.currentSpace() !== previous) {
          await ctx.changeSpace(previous);
        }
      },
    },

    folders: {
      steps: [
        {
          caption: 'Manage Folders creates new folders and chooses which ones appear in this list.',
          targets: [SPOTLIGHT_TARGETS.manageFolders],
          fallbackTargets: [SPOTLIGHT_TARGETS.folderTree],
          durationMs: 2600,
        },
        {
          caption: 'Create folders, choose which ones to show, and star favorites so they float to the top of the list.',
          press: SPOTLIGHT_TARGETS.manageFolders,
          prepare: async () => {
            if (!clickFirst(SPOTLIGHT_TARGETS.manageFolders)) return;
            await waitForSelector(SPOTLIGHT_TARGETS.folderManagerPanel, DIALOG_OPEN_TIMEOUT_MS);
          },
          targets: [SPOTLIGHT_TARGETS.folderManagerPanel],
          fallbackTargets: [SPOTLIGHT_TARGETS.manageFolders],
          // The overlay sits above the dialog so the pointer can reach its
          // Close button; staging the panel keeps it out of the scrim.
          stage: [SPOTLIGHT_TARGETS.folderManagerPanel],
          durationMs: 4600,
        },
        {
          caption: 'Favorites float to the top and shared accounts get their own section. Select several messages to move or delete them together.',
          press: SPOTLIGHT_TARGETS.folderManagerClose,
          prepare: () => {
            clickFirst(SPOTLIGHT_TARGETS.folderManagerClose);
          },
          targets: [SPOTLIGHT_TARGETS.folderFavorites, SPOTLIGHT_TARGETS.sharedFolders],
          fallbackTargets: [SPOTLIGHT_TARGETS.userFolders, SPOTLIGHT_TARGETS.folderTree],
          durationMs: 4200,
        },
      ],
      cleanup: () => {
        clickFirst(SPOTLIGHT_TARGETS.folderManagerClose);
      },
    },
  };
}
