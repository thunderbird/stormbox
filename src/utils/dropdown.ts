export function closeContainingDropdown(
  source: Event | Element | null | undefined,
): void {
  const element = source instanceof Event ? source.currentTarget : source;
  if (!(element instanceof Element)) return;
  const details = element.closest('details');
  if (details instanceof HTMLDetailsElement) details.open = false;
}
