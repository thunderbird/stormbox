export function errorProperties(reason: unknown): string[] {
  const properties = (reason as { properties?: unknown } | null)?.properties;
  return (Array.isArray(properties) ? properties : [])
    .filter((property: unknown): property is string => typeof property === 'string')
    .map((property) => property.toLowerCase().replace(/^\/+/u, ''));
}

export function hasErrorProperty(
  properties: readonly string[],
  name: string,
): boolean {
  const lowerName = name.toLowerCase();
  return properties.some((property) =>
    property === lowerName
    || property.startsWith(`${lowerName}/`)
    || property.startsWith(`${lowerName}.`)
    || property.startsWith(`${lowerName}[`));
}
