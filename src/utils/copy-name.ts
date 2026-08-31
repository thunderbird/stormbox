const COPY_SUFFIX = /^(.*?)\s+\(Copy\s+(\d+)\)$/iu;

function copyBase(displayName: string): string {
  const trimmed = displayName.trim();
  const match = COPY_SUFFIX.exec(trimmed);
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
    const match = COPY_SUFFIX.exec(existingName.trim());
    if (!match || copyBase(existingName).toLocaleLowerCase() !== normalizedBase) continue;
    copyNumber = Math.max(copyNumber, Number(match[2]));
  }

  return `${base} (Copy ${copyNumber + 1})`;
}
