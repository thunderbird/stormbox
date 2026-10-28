import { t } from '../i18n/messages';

function copySuffix(): RegExp {
  const marker = t('common.copyMarker').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^(.*?)\\s+\\((?:Copy|${marker})\\s+(\\d+)\\)$`, 'iu');
}

function copyBase(displayName: string): string {
  const trimmed = displayName.trim();
  const match = copySuffix().exec(trimmed);
  return match?.[1]?.trim() || trimmed;
}

export function nextCopyName(
  displayName: string,
  existingDisplayNames: readonly string[],
): string {
  const base = copyBase(displayName);
  const normalizedBase = base.toLocaleLowerCase();
  let copyNumber = 0;

  for (const existingName of existingDisplayNames) {
    const match = copySuffix().exec(existingName.trim());
    if (!match || copyBase(existingName).toLocaleLowerCase() !== normalizedBase) continue;
    copyNumber = Math.max(copyNumber, Number(match[2]));
  }

  return t('common.copyName', { name: base, number: String(copyNumber + 1) });
}
