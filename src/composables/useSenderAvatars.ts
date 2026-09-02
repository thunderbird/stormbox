import {
  getCurrentInstance, inject, provide, ref, type InjectionKey,
} from 'vue';

import { SENDER_AVATAR_PROXY_URL } from '../defines';
import { senderAvatarFor, type SenderAvatar } from '../utils/sender-avatar';

export interface SenderAvatars {
  senderAvatar: (fromText: string | null | undefined) => SenderAvatar;
  onAvatarError: (fromText: string | null | undefined) => void;
}

const SENDER_AVATARS: InjectionKey<SenderAvatars> = Symbol('sender-avatars');

/**
 * One failure memory: once a domain's avatar failed to load, no row
 * sharing this instance retries it. Owned by a list surface for its
 * lifetime, so a remounted list retries.
 */
export function createSenderAvatars(): SenderAvatars {
  const failedAvatarDomains = ref<Set<string>>(new Set());

  function senderAvatar(fromText: string | null | undefined): SenderAvatar {
    const avatar = senderAvatarFor(fromText, SENDER_AVATAR_PROXY_URL);
    if (avatar.domain && failedAvatarDomains.value.has(avatar.domain)) {
      return { ...avatar, imageUrl: '' };
    }
    return avatar;
  }

  function onAvatarError(fromText: string | null | undefined): void {
    const { domain } = senderAvatarFor(fromText, SENDER_AVATAR_PROXY_URL);
    if (!domain || failedAvatarDomains.value.has(domain)) return;
    failedAvatarDomains.value = new Set([...failedAvatarDomains.value, domain]);
  }

  return { senderAvatar, onAvatarError };
}

/** Called by a list surface so every row it renders shares one memory. */
export function provideSenderAvatars(): SenderAvatars {
  const avatars = createSenderAvatars();
  provide(SENDER_AVATARS, avatars);
  return avatars;
}

/** Rows join the enclosing list's memory, or get their own when none. */
export function useSenderAvatars(): SenderAvatars {
  const provided = getCurrentInstance() ? inject(SENDER_AVATARS, null) : null;
  return provided ?? createSenderAvatars();
}
