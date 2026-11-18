// Port of the Accounts login theme's banner check (thunderbird-accounts#1490); the app never waits on it.
import { onMounted, ref, type Ref } from 'vue';

type BannerType = 'info' | 'warning' | 'critical';

export interface Banner {
  type: BannerType;
  message: string;
  link: { text: string; href: string } | null;
}

const BANNER_TYPES: readonly BannerType[] = ['info', 'warning', 'critical'];
const MAX_MESSAGE_LENGTH = 300;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function parseTimestamp(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  const time = typeof value === 'string' ? Date.parse(value) : NaN;
  if (Number.isNaN(time)) throw new Error(`${field} is not a date`);
  return time;
}

function parseLink(value: unknown): Banner['link'] {
  if (!isRecord(value) || typeof value.text !== 'string' || !value.text || typeof value.href !== 'string') return null;
  try {
    const { protocol } = new URL(value.href);
    return protocol === 'http:' || protocol === 'https:' ? { text: value.text, href: value.href } : null;
  } catch {
    return null;
  }
}

function parseBanner(data: unknown, now: number): Banner | null {
  if (!isRecord(data)) throw new Error('not an object');
  if (data.enabled !== true) return null;
  const { type, message } = data;
  if (!BANNER_TYPES.includes(type as BannerType)) throw new Error('unknown type');
  // Code points, matching the server's max_length; String.length counts emoji twice.
  if (typeof message !== 'string' || !message.trim() || [...message].length > MAX_MESSAGE_LENGTH) {
    throw new Error('invalid message');
  }
  const starts = parseTimestamp(data.starts, 'starts');
  const ends = parseTimestamp(data.ends, 'ends');
  if ((starts !== null && now < starts) || (ends !== null && now >= ends)) throw new Error('outside its starts/ends window');
  return { type: type as BannerType, message, link: parseLink(data.link) };
}

export function useDowntimeBanner(url: string): { banner: Ref<Banner | null> } {
  const banner = ref<Banner | null>(null);

  onMounted(async () => {
    if (!url) return;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000), cache: 'no-store', credentials: 'omit' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      banner.value = parseBanner(await response.json(), Date.now());
    } catch (error) {
      console.warn('[banner] Not showing the downtime banner:', error instanceof Error ? error.message : error);
    }
  });

  return { banner };
}
