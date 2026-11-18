// Reads the maintenanceNotice realm message that the Keycloak login page shows (thunderbird-accounts#1491); the app never waits on it.
import { onMounted, ref, type Ref } from 'vue';

const BANNER_TYPES = ['info', 'warning', 'critical'] as const;
type BannerType = (typeof BANNER_TYPES)[number];

export interface Banner {
  type: BannerType;
  message: string;
}

function parseBanner(messages: unknown): Banner | null {
  if (!Array.isArray(messages)) throw new Error('not a message list');
  const text = (key: string): string => {
    const value: unknown = messages.find((entry) => entry?.key === key)?.value;
    return typeof value === 'string' ? value.trim() : '';
  };
  // The endpoint returns the MessageFormat pattern, where operators type '' for an apostrophe.
  const message = text('maintenanceNotice').replaceAll("''", "'");
  if (!message) return null;
  const type = BANNER_TYPES.find((name) => name === text('maintenanceNoticeType')) ?? 'warning';
  return { type, message };
}

export function useDowntimeBanner(url: string): { banner: Ref<Banner | null> } {
  const banner = ref<Banner | null>(null);

  onMounted(async () => {
    if (!url) return;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000), cache: 'no-store', credentials: 'omit' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      banner.value = parseBanner(await response.json());
    } catch (error) {
      console.warn('[banner] Not showing the downtime banner:', error instanceof Error ? error.message : error);
    }
  });

  return { banner };
}
