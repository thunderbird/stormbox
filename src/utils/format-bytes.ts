import { t, formatNumber } from '../i18n/messages';
/**
 * Format a byte count for compact UI labels (e.g. "6 GB", "512 MB").
 */
export function formatBytes(bytes: number | null | undefined): string | null {
  if (bytes == null || Number.isNaN(bytes)) {
    return null;
  }
  if (bytes <= 0) {
    return t('common.numberAndUnit', { number: formatNumber(0), unit: t('common.bytes') });
  }

  const units = [
    { threshold: 1024 ** 3, get label() { return t('formatBytes.gB'); }, divisor: 1024 ** 3 },
    { threshold: 1024 ** 2, get label() { return t('formatBytes.mB'); }, divisor: 1024 ** 2 },
    { threshold: 1024, get label() { return t('formatBytes.kB'); }, divisor: 1024 },
  ];

  for (const unit of units) {
    if (bytes >= unit.threshold) {
      const value = Math.floor(bytes / unit.divisor);
      return t('common.numberAndUnit', { number: formatNumber(value), unit: unit.label });
    }
  }

  return t('common.numberAndUnit', { number: formatNumber(bytes), unit: t('common.bytes') });
}
