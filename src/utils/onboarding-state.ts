/**
 * The `onboarding` setting (specs/010 §3, specs/006): a missing value means
 * Welcome has never been dismissed. Once set, every beacon whose `seq` is
 * at or below `beaconsSeenThrough` is dismissed, plus the few listed in
 * `beaconsSeenAlso` that were dismissed out of order above it. The mark
 * only moves up, and out-of-order entries fold into it as soon as the gap
 * closes, so a user who has seen everything stores one number.
 */

export interface OnboardingState {
  beaconsSeenThrough: number;
  /** Seen `seq`s above `beaconsSeenThrough`, ascending; omitted when empty. */
  beaconsSeenAlso?: number[];
}

function isSeq(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

export function isOnboardingState(value: unknown): value is OnboardingState | null {
  if (value === null) return true;
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  if (!isSeq(state.beaconsSeenThrough)) return false;
  if (state.beaconsSeenAlso === undefined) return true;
  return Array.isArray(state.beaconsSeenAlso) && state.beaconsSeenAlso.every(isSeq);
}

export function isBeaconSeen(state: OnboardingState | null, seq: number): boolean {
  if (state == null) return false;
  return seq <= state.beaconsSeenThrough || (state.beaconsSeenAlso ?? []).includes(seq);
}

/**
 * Folds out-of-order entries into the mark: it advances over every `seq`
 * that is seen or no longer a live beacon, up to `latest`. The result is
 * the canonical stored form.
 */
export function compactOnboardingState(
  state: OnboardingState,
  liveSeqs: ReadonlySet<number>,
  latest: number,
): OnboardingState {
  const also = new Set((state.beaconsSeenAlso ?? []).filter((seq) => seq > state.beaconsSeenThrough));
  let through = state.beaconsSeenThrough;
  while (through < latest && (also.has(through + 1) || !liveSeqs.has(through + 1))) {
    through += 1;
    also.delete(through);
  }
  const rest = [...also].filter((seq) => seq > through).sort((a, b) => a - b);
  return rest.length > 0
    ? { beaconsSeenThrough: through, beaconsSeenAlso: rest }
    : { beaconsSeenThrough: through };
}

/** State with `seq` seen; null (Welcome never dismissed) starts from nothing seen. */
export function markBeaconSeen(
  state: OnboardingState | null,
  seq: number,
  liveSeqs: ReadonlySet<number>,
  latest: number,
): OnboardingState {
  const base = state ?? { beaconsSeenThrough: 0 };
  return compactOnboardingState(
    { ...base, beaconsSeenAlso: [...(base.beaconsSeenAlso ?? []), seq] },
    liveSeqs,
    latest,
  );
}

/** Every beacon through `latest` seen: Welcome dismissed, or Dismiss all. */
export function onboardingSeenThrough(latest: number): OnboardingState {
  return { beaconsSeenThrough: latest };
}
