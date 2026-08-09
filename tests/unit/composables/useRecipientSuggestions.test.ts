import {
  afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';
import { effectScope, ref } from 'vue';

import { useRecipientSuggestions } from '../../../src/composables/useRecipientSuggestions';
import type { AutocompleteCandidate } from '../../../src/stores/contacts-store';

const CONTACTS: AutocompleteCandidate[] = [
  { name: 'Bob', email: 'bob@example.com', source: 'contact' },
  { name: 'Bobbie', email: 'bobbie@example.com', source: 'contact' },
];

function makeHarness({
  query = async () => CONTACTS,
  debounceMs = 40,
}: {
  query?: (
    prefix: string, limit: number, exclude: string[],
  ) => Promise<AutocompleteCandidate[]>;
  debounceMs?: number;
} = {}) {
  const scope = effectScope();
  const text = ref('');
  const takenEmails = ref<ReadonlySet<string>>(new Set());
  const suggestions = scope.run(() => useRecipientSuggestions({
    text,
    takenEmails,
    getQuery: () => query,
    getBrowseAll: () => undefined,
    getDebounceMs: () => debounceMs,
  }));
  if (!suggestions) throw new Error('Recipient suggestion scope did not start');
  return {
    scope, text, ...suggestions,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useRecipientSuggestions', () => {
  it('debounces a query until typing pauses', async () => {
    const query = vi.fn(async () => CONTACTS);
    const harness = makeHarness({ query });

    harness.text.value = 'bo';
    harness.scheduleQuery();
    await vi.advanceTimersByTimeAsync(39);
    expect(query).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(query).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledWith('bo', 10, []);
    expect(harness.suggestions.value).toEqual(CONTACTS);
    harness.scope.stop();
  });

  it('discards a stale response after a newer query supersedes it', async () => {
    // CS-3.10: only the response for the latest typed prefix may update the list.
    const pending: Array<(value: AutocompleteCandidate[]) => void> = [];
    const query = vi.fn(() => new Promise<AutocompleteCandidate[]>((resolve) => {
      pending.push(resolve);
    }));
    const harness = makeHarness({ query, debounceMs: 0 });

    harness.text.value = 'bo';
    harness.scheduleQuery();
    await vi.runOnlyPendingTimersAsync();
    harness.text.value = 'bobbie';
    harness.scheduleQuery();
    await vi.runOnlyPendingTimersAsync();

    pending[1]([CONTACTS[1]]);
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.suggestions.value).toEqual([CONTACTS[1]]);

    pending[0]([CONTACTS[0]]);
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.suggestions.value).toEqual([CONTACTS[1]]);
    harness.scope.stop();
  });

  it('does not query below the two-character threshold', async () => {
    const query = vi.fn(async () => CONTACTS);
    const harness = makeHarness({ query });

    harness.text.value = 'b';
    harness.scheduleQuery();
    await vi.runAllTimersAsync();

    expect(query).not.toHaveBeenCalled();
    expect(harness.suggestions.value).toEqual([]);
    expect(harness.isPanelOpen.value).toBe(false);
    harness.scope.stop();
  });

  it('cancels the pending debounce when its scope is disposed', async () => {
    const query = vi.fn(async () => CONTACTS);
    const harness = makeHarness({ query });

    harness.text.value = 'bo';
    harness.scheduleQuery();
    harness.scope.stop();
    await vi.runAllTimersAsync();

    expect(query).not.toHaveBeenCalled();
  });
});
