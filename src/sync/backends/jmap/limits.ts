import { JMAP_CAPS } from './transport';

type JmapCoreLimit = 'maxObjectsInGet' | 'maxObjectsInSet';

function coreLimit(transport: any, property: JmapCoreLimit): number {
  const raw = Number(
    transport?.session?.capabilities?.[JMAP_CAPS.CORE]?.[property],
  );
  if (!Number.isFinite(raw) || raw <= 0) {
    throw new Error(`JMAP Session missing valid ${property}`);
  }
  return Math.max(1, Math.floor(raw));
}

export function maxObjectsInGet(transport: any): number {
  return coreLimit(transport, 'maxObjectsInGet');
}

export function maxObjectsInSet(transport: any): number {
  return coreLimit(transport, 'maxObjectsInSet');
}
