import { randomUUID } from 'node:crypto';
import fs from 'node:fs';

/**
 * One e2e lane at a time.
 *
 * `workers: 1` serialises tests inside one Playwright process and says
 * nothing about a second process. Two lanes against the one shared Stalwart
 * account interleave sends, seeds and cleanups, and the results are not
 * merely slower — they are wrong in both directions: a spec fails because
 * the other lane emptied the mailbox it had just filled, and the run that
 * caused it passes. An hour was spent reading such a report before noticing
 * the overlap.
 *
 * The lock lives outside the repository, because two worktrees are two trees
 * and still one mail server. It does not reach across containers, which is
 * the case it cannot see.
 */
const LOCK_PATH = process.env.E2E_LANE_LOCK ?? '/tmp/stormbox-e2e-lane.lock';

/**
 * How long a lock may be held before it is assumed abandoned. Longer than
 * any lane — the bulk-move spec alone allows itself eight minutes — and
 * short enough that a machine recovers on its own.
 */
const MAX_HELD_MS = 2 * 60 * 60 * 1000;

/**
 * Long enough for a competitor's create to be visible before ownership is
 * believed. Two lanes racing for an abandoned lock both take it and both
 * check; whoever is not in the file stands down.
 */
const SETTLE_MS = 150;

/** Ours alone: a pid can be reused, this cannot. */
const OWNER = `${process.pid}-${randomUUID()}`;

function record() {
  return JSON.stringify({
    owner: OWNER,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    argv: process.argv.slice(1),
  });
}

/** There is no lock at all. */
const NO_LOCK = { state: 'absent' };
/** There is a lock, and nothing can be asked about whose it is. */
const UNREADABLE = { state: 'unreadable' };

/** Who holds the lock: `NO_LOCK`, `UNREADABLE`, or a holder record. */
function readHolder() {
  let raw;
  try {
    raw = fs.readFileSync(LOCK_PATH, 'utf8');
  } catch (err) {
    // Released while being read: no holder, which is what the caller needs.
    if (err?.code === 'ENOENT') return NO_LOCK;
    throw err;
  }
  try {
    const held = JSON.parse(raw);
    if (typeof held.owner !== 'string') return UNREADABLE;
    return {
      state: 'held',
      owner: held.owner,
      pid: Number(held.pid),
      startedAt: held.startedAt ?? null,
      argv: Array.isArray(held.argv) ? held.argv.join(' ') : '(unrecorded)',
    };
  } catch {
    return UNREADABLE;
  }
}

/**
 * Whether a holder is still there to own the lock.
 *
 * A live pid is not enough on its own: a killed lane's pid gets reused, and
 * an unrelated process inheriting it would lock the machine out of every run
 * that followed. What the pid belongs to is checked where the system will
 * say, and the recorded age is the backstop where it will not.
 */
function holderAlive(holder) {
  if (!Number.isInteger(holder.pid) || holder.pid <= 0) return false;
  if (!processExists(holder.pid)) return false;

  const command = commandOf(holder.pid);
  if (command !== null) return command.includes('playwright');

  const startedAt = Date.parse(holder.startedAt ?? '');
  if (Number.isNaN(startedAt)) return true;
  return Date.now() - startedAt < MAX_HELD_MS;
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // Someone else's process: running, and not ours to inspect or take.
    return err?.code === 'EPERM';
  }
}

/** What a pid is running, where the system will say. Null where it will not. */
function commandOf(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ');
  } catch {
    return null;
  }
}

/** Create the lock, or report that one already exists. Never half-written. */
function claim() {
  // Written elsewhere and linked into place, so a competitor reading the
  // lock cannot catch it empty and mistake it for nobody's.
  const staging = `${LOCK_PATH}.${OWNER}`;
  fs.writeFileSync(staging, record());
  try {
    fs.linkSync(staging, LOCK_PATH);
    return true;
  } catch (err) {
    if (err?.code === 'EEXIST') return false;
    throw err;
  } finally {
    fs.rmSync(staging, { force: true });
  }
}

/**
 * Clear a lock nobody is holding, without disturbing one somebody is.
 *
 * `owner` is what was there when the decision to clear it was made; a lock
 * that has changed hands since belongs to whoever took it.
 */
function discard(owner) {
  const current = readHolder();
  if (current.state === 'absent') return;
  if (current.state === 'held' && current.owner !== owner) return;
  if (current.state === 'unreadable' && owner !== null) return;
  try {
    fs.rmSync(LOCK_PATH);
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
}

function refuse(holder) {
  const since = holder.startedAt ?? 'an unknown time';
  return new Error(
    `Another e2e lane is running: pid ${holder.pid}, started ${since}.\n`
    + `  ${holder.argv}\n`
    + 'Two lanes share one Stalwart account and corrupt each other\'s results.\n'
    + 'Wait for it to finish, or stop it, then run again.\n'
    + `If it is gone, the lock clears itself; to override, remove ${LOCK_PATH}.`,
  );
}

export async function acquireLaneLock() {
  // Bounded: each turn either takes the lock, or finds a live holder and
  // stands down, or clears an abandoned one. Only losing a race repeats.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (claim()) {
      await new Promise((resolve) => { setTimeout(resolve, SETTLE_MS); });
      const taken = readHolder();
      if (taken.state === 'held' && taken.owner === OWNER) return;
      // Someone cleared ours as abandoned and took it. Theirs now.
      continue;
    }
    const holder = readHolder();
    // Gone between the failed claim and the read: try to take it.
    if (holder.state === 'absent') continue;
    // A lock nobody can be asked about is a lock nobody is holding. Left
    // alone it would refuse every run on the machine for ever.
    if (holder.state === 'unreadable') {
      discard(null);
      continue;
    }
    if (holder.owner === OWNER) return;
    if (holderAlive(holder)) throw refuse(holder);
    discard(holder.owner);
  }
  throw new Error(
    `Could not take the e2e lane lock at ${LOCK_PATH} after five attempts.\n`
    + 'Something is repeatedly creating and clearing it. Look for other test '
    + 'runs, then remove the file if it is nobody\'s.',
  );
}

export function releaseLaneLock() {
  const holder = readHolder();
  // Only ever release our own: a lock taken over from us belongs to the run
  // that took it, and removing it would let a third lane in beside it.
  if (holder.state !== 'held' || holder.owner !== OWNER) return;
  try {
    fs.rmSync(LOCK_PATH);
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
}
