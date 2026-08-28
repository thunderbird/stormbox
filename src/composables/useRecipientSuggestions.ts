import {
  computed, onScopeDispose, ref, type Ref,
} from 'vue';

import type { AutocompleteCandidate } from '../stores/contacts-store';
import { addressKey } from '../utils/address-key';

type RecipientQuery = (
  prefix: string, limit: number, exclude: string[],
) => Promise<AutocompleteCandidate[]>;

export interface UseRecipientSuggestionsOptions {
  text: Readonly<Ref<string>>;
  takenEmails: Readonly<Ref<ReadonlySet<string>>>;
  getQuery: () => RecipientQuery | undefined;
  getBrowseAll: () => (() => Promise<AutocompleteCandidate[]>) | undefined;
  getDebounceMs: () => number;
}

/** CS-3.12: a suggestion list is capped independently of address-book browsing. */
const SUGGESTION_LIMIT = 10;
/** CS-3.15: autocomplete starts with the first non-whitespace character. */
const MIN_PREFIX = 1;

export function useRecipientSuggestions({
  text,
  takenEmails,
  getQuery,
  getBrowseAll,
  getDebounceMs,
}: UseRecipientSuggestionsOptions) {
  const suggestions = ref<AutocompleteCandidate[]>([]);
  const activeIndex = ref(-1);
  const expanded = ref(false);
  /** Whether the list currently holds the address book rather than matches. */
  const browsing = ref(false);
  /**
   * The typed text a completed lookup answered with nothing, kept so the
   * panel can say so where the user is looking — and say what still works:
   * Enter commits the text as an address regardless. A failed lookup never
   * lands here; "unavailable" must not read as "not in your address book".
   */
  const noMatches = ref<string | null>(null);
  /**
   * What to say about a lookup that found nothing. An empty live region is not
   * an announcement — screen readers speak a change, not a clearing — so "no
   * matches" has to be said in words or the user is left waiting for a list
   * that is never coming.
   */
  const foundNothing = ref<string | null>(null);

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * The query whose answer is still wanted. Answers arrive in whatever order
   * the worker returns them, and an earlier one landing later would replace
   * the list for what the user has since typed (CS-3.10).
   */
  let queryToken = 0;

  const isListOpen = computed(() => expanded.value && suggestions.value.length > 0);

  /** The popup as a whole: the option list, or the visible no-matches state. */
  const isPanelOpen = computed(() => isListOpen.value || noMatches.value !== null);

  /**
   * Announced to a screen reader when the list changes, since a listbox
   * appearing below the field is not something a non-sighted user can see.
   */
  const resultSummary = computed(() => {
    if (!isListOpen.value) {
      // Silent on dismissal: the user who pressed Escape knows what it did.
      return foundNothing.value ?? '';
    }
    const count = suggestions.value.length;
    if (browsing.value) return `Showing ${count} contacts`;
    return count === 1 ? '1 suggestion available' : `${count} suggestions available`;
  });

  const countLabel = computed(() => {
    const count = suggestions.value.length;
    if (browsing.value) return count === 1 ? '1 contact' : `${count} contacts`;
    return count === 1 ? '1 suggestion' : `${count} suggestions`;
  });

  onScopeDispose(() => {
    if (debounceTimer) clearTimeout(debounceTimer);
  });

  /**
   * Stop wanting a list, whatever the reason — dismissed, committed, or left.
   *
   * Invalidating the query prevents a late answer from reopening a list under
   * a field that may no longer have focus. Cancelling the timer applies the
   * same rule before a query starts.
   */
  function closeList(): void {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = null;
    queryToken += 1;
    expanded.value = false;
    activeIndex.value = -1;
    suggestions.value = [];
    browsing.value = false;
    foundNothing.value = null;
    noMatches.value = null;
  }

  /**
   * Run a lookup and distinguish an empty answer from an unavailable source.
   */
  async function ask<T>(
    lookup: () => Promise<T>, onFailure: T,
  ): Promise<{ value: T; answered: boolean }> {
    try {
      return { value: await lookup(), answered: true };
    } catch {
      return { value: onFailure, answered: false };
    }
  }

  /** Offering an existing recipient wastes a row and would do nothing. */
  function notTaken(found: readonly AutocompleteCandidate[]): AutocompleteCandidate[] {
    return found.filter((candidate) => !takenEmails.value.has(addressKey(candidate.email)));
  }

  /**
   * Show the whole address book for a recipient the user cannot find by
   * typing. Browse results are not subject to the suggestion limit (CS-3.12).
   */
  async function browseContacts(): Promise<boolean> {
    const browseAll = getBrowseAll();
    if (!browseAll) return false;
    if (debounceTimer) clearTimeout(debounceTimer);
    const token = (queryToken += 1);
    const { value: found, answered } = await ask(() => browseAll(), []);
    if (token !== queryToken) return false;
    suggestions.value = notTaken(found);
    activeIndex.value = suggestions.value.length > 0 ? 0 : -1;
    browsing.value = true;
    noMatches.value = null;
    foundNothing.value = suggestions.value.length > 0
      ? null
      : (answered ? 'No contacts to show' : 'Contacts are unavailable');
    expanded.value = suggestions.value.length > 0;
    return true;
  }

  async function runQuery(prefix: string): Promise<void> {
    const query = getQuery();
    const token = (queryToken += 1);
    const excluded = [...takenEmails.value];
    const { value: found, answered } = query
      ? await ask(() => query(prefix, SUGGESTION_LIMIT, excluded), [])
      : { value: [] as AutocompleteCandidate[], answered: true };
    if (token !== queryToken) return;
    // The query receives these exclusions, and filtering again also covers a
    // caller whose implementation does not honor that argument.
    suggestions.value = notTaken(found).slice(0, SUGGESTION_LIMIT);
    activeIndex.value = suggestions.value.length > 0 ? 0 : -1;
    browsing.value = false;
    // An answered empty result keeps the panel open to say what still works;
    // a failed lookup closes it so unavailable is not presented as no match.
    noMatches.value = suggestions.value.length === 0 && answered ? prefix : null;
    expanded.value = suggestions.value.length > 0;
    foundNothing.value = suggestions.value.length > 0
      ? null
      : (answered ? `No suggestions for ${prefix}` : 'Suggestions are unavailable');
  }

  function hasQueryPrefix(prefix: string): boolean {
    return prefix.length >= MIN_PREFIX;
  }

  function scheduleQuery(): void {
    if (debounceTimer) clearTimeout(debounceTimer);
    const prefix = text.value.trim();
    if (!hasQueryPrefix(prefix)) {
      // Nothing typed is not a query with no answers. Invalidating the token
      // keeps an earlier response out of the now-short field.
      queryToken += 1;
      closeList();
      return;
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void runQuery(prefix);
    }, getDebounceMs());
  }

  return {
    suggestions,
    activeIndex,
    expanded,
    browsing,
    noMatches,
    isPanelOpen,
    resultSummary,
    countLabel,
    hasQueryPrefix,
    runQuery,
    scheduleQuery,
    browseContacts,
    closeList,
  };
}
