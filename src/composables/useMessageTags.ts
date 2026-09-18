import { computed } from 'vue';

import { useSettingsStore } from '../stores/settings-store';
import {
  deriveTagKeyword,
  MAX_TAG_DEFINITIONS,
  isValidKeyword,
  isSystemKeyword,
  nextTagColor,
  normalizeKeyword,
  resolveMessageTags,
  sortTagDefinitions,
  tagNameError,
  type MessageTagDefinition,
  type ResolvedTag,
} from '../utils/message-tags';

/**
 * Tag definitions for the UI: the `messageTags` setting in display
 * order, plus the writes that add to it. Definitions are the only thing
 * this touches; applying a tag to messages is the mail store's job.
 */
export function useMessageTags() {
  const settingsStore = useSettingsStore();

  const definitions = computed<MessageTagDefinition[]>(() => (
    sortTagDefinitions(settingsStore.get('messageTags'))
  ));

  const canCreate = computed(() => definitions.value.length < MAX_TAG_DEFINITIONS);

  async function persist(next: MessageTagDefinition[]): Promise<void> {
    // Definitions have primitive fields; snapshot every entry for MessagePort.
    await settingsStore.update({ messageTags: next.map((definition) => ({ ...definition })) });
  }

  /**
   * Define a new tag named `name` with a keyword derived from it
   * (MK-6.3). Returns null when the name yields no keyword or the cap
   * is reached.
   */
  async function createTag(
    name: string,
    color: string = nextTagColor(definitions.value),
  ): Promise<MessageTagDefinition | null> {
    const trimmed = name.trim();
    if (tagNameError(name) || !canCreate.value) return null;
    const keyword = deriveTagKeyword(trimmed, definitions.value.map((d) => d.keyword));
    if (!keyword) return null;
    const definition: MessageTagDefinition = {
      keyword,
      name: trimmed,
      color,
      order: definitions.value.length,
    };
    await persist([...definitions.value, definition]);
    return definition;
  }

  /**
   * Give an existing keyword (set by another client or a Sieve script)
   * a definition, keeping the keyword as-is so tagged messages keep
   * matching (MK-6.4).
   */
  async function defineKeyword(
    keyword: string,
    name: string = keyword,
    color: string = nextTagColor(definitions.value),
  ): Promise<MessageTagDefinition | null> {
    const normalized = normalizeKeyword(keyword);
    if (!canCreate.value || !isValidKeyword(normalized) || isSystemKeyword(normalized)) return null;
    if (definitions.value.some((d) => normalizeKeyword(d.keyword) === normalized)) return null;
    const error = tagNameError(name);
    if (error) throw new Error(error);
    const definition: MessageTagDefinition = {
      keyword: normalized,
      name: name.trim(),
      color,
      order: definitions.value.length,
    };
    await persist([...definitions.value, definition]);
    return definition;
  }

  function tagsFor(row: { keywords_json?: string | null } | null | undefined): ResolvedTag[] {
    return resolveMessageTags(row?.keywords_json, definitions.value);
  }

  /** Rename or recolor a tag; the keyword never changes (MK-6.3). */
  async function updateTag(
    keyword: string,
    patch: Partial<Pick<MessageTagDefinition, 'name' | 'color'>>,
  ): Promise<void> {
    const normalized = normalizeKeyword(keyword);
    if (!definitions.value.some((d) => normalizeKeyword(d.keyword) === normalized)) return;
    const error = patch.name === undefined ? null : tagNameError(patch.name);
    if (error) throw new Error(error);
    const name = patch.name?.trim();
    await persist(definitions.value.map((definition) => (
      normalizeKeyword(definition.keyword) === normalized
        ? {
          ...definition,
          ...(name ? { name } : {}),
          ...(patch.color ? { color: patch.color } : {}),
        }
        : definition
    )));
  }

  /** Move a tag one step up or down in the order the picker and digits use. */
  async function moveTag(keyword: string, direction: -1 | 1): Promise<void> {
    const normalized = normalizeKeyword(keyword);
    const ordered = [...definitions.value];
    const index = ordered.findIndex((d) => normalizeKeyword(d.keyword) === normalized);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= ordered.length) return;
    [ordered[index], ordered[target]] = [ordered[target], ordered[index]];
    await persist(ordered.map((definition, order) => ({ ...definition, order })));
  }

  /**
   * Drop a definition. Messages keep the keyword and show it as an
   * undefined tag; stripping it from them is a separate action (MK-6.4).
   */
  async function deleteTag(keyword: string): Promise<void> {
    const normalized = normalizeKeyword(keyword);
    await persist(
      definitions.value
        .filter((d) => normalizeKeyword(d.keyword) !== normalized)
        .map((definition, order) => ({ ...definition, order })),
    );
  }

  return {
    definitions,
    canCreate,
    createTag,
    defineKeyword,
    updateTag,
    moveTag,
    deleteTag,
    tagsFor,
  };
}
