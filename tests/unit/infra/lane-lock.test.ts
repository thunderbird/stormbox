import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';

let lockPath: string;

/**
 * The lock module reads its path and mints its owner id once, at import, so
 * each case needs a fresh module against a fresh path. Importing it twice is
 * also how two competing lanes are simulated: two modules, two owners.
 */
async function loadLock() {
  process.env.E2E_LANE_LOCK = lockPath;
  vi.resetModules();
  return import('../../e2e/helpers/lane-lock');
}

/** A pid that cannot be running: above every Linux `pid_max`. */
const DEAD_PID = 4_194_304;

function writeLock(fields: Record<string, unknown>) {
  fs.writeFileSync(lockPath, JSON.stringify({
    owner: 'someone-else',
    pid: DEAD_PID,
    startedAt: new Date().toISOString(),
    argv: ['playwright', 'test'],
    ...fields,
  }));
}

/** The test runners whose processes the lock recognises as live lanes. */
type Runner = 'playwright' | 'vitest';
const RUNNERS: Runner[] = ['playwright', 'vitest'];

/**
 * A lane in its own process, which is the only way to test exclusion between
 * lanes: a holder is recognised by being a live playwright or vitest run, and
 * one process cannot be two of those.
 *
 * The script is named for its runner so the running command says so, exactly
 * as `node …/playwright test` and `node …/vitest run` do.
 */
async function startLane({ hold, runner }: { hold: number; runner: Runner }) {
  const dir = path.dirname(lockPath);
  const script = path.join(dir, `${runner}-lane.mjs`);
  const helper = path.resolve(__dirname, '../../e2e/helpers/lane-lock.js');
  fs.writeFileSync(script, `
    import { acquireLaneLock, releaseLaneLock } from ${JSON.stringify(helper)};
    try {
      await acquireLaneLock();
      console.log('HELD');
      await new Promise((resolve) => { setTimeout(resolve, ${hold}); });
      releaseLaneLock();
    } catch (err) {
      console.log('REFUSED ' + err.message.split('\\n')[0]);
    }
  `);
  const child = spawn(process.execPath, [script], {
    env: { ...process.env, E2E_LANE_LOCK: lockPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += String(chunk); });
  child.stderr.on('data', (chunk) => { output += String(chunk); });

  const finished = new Promise<void>((resolve) => { child.on('close', () => resolve()); });
  // Started is not the same as holding: wait until it has said which.
  await vi.waitFor(() => {
    if (!/HELD|REFUSED/.test(output)) throw new Error(`lane said nothing yet: ${output}`);
  }, { timeout: 10_000, interval: 25 });

  return {
    async settled() {
      await finished;
      return { held: output.includes('HELD'), message: output.trim() };
    },
    async stop() {
      child.kill('SIGKILL');
      await finished;
    },
  };
}

beforeEach(() => {
  lockPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lane-lock-')), 'lane.lock');
});

afterEach(() => {
  delete process.env.E2E_LANE_LOCK;
  // One scratch directory per case, and nothing was removing them: a few
  // hundred `lane-lock-*` directories accumulate in /tmp, where they read
  // like abandoned lane locks to anyone diagnosing a lane that will not
  // start.
  fs.rmSync(path.dirname(lockPath), { recursive: true, force: true });
});

describe('e2e lane lock', () => {
  it('lets a lane in, and out again', async () => {
    const { acquireLaneLock, releaseLaneLock } = await loadLock();

    await acquireLaneLock();
    expect(fs.existsSync(lockPath)).toBe(true);

    releaseLaneLock();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it.each(RUNNERS)('refuses a second lane while a %s lane is running', async (runner) => {
    const holder = await startLane({ hold: 5_000, runner });

    try {
      const { acquireLaneLock } = await loadLock();
      // The message has to name what is running: the failures this prevents
      // were twice diagnosed as product defects first.
      await expect(acquireLaneLock()).rejects.toThrow(/Another e2e lane is running: pid/);
    } finally {
      await holder.stop();
    }
  });

  it.each([
    { holder: 'playwright', challenger: 'vitest' },
    { holder: 'vitest', challenger: 'playwright' },
  ] as const)(
    'refuses a $challenger lane while a $holder lane is running',
    async ({ holder, challenger }) => {
      // The integration suites and the browser specs share one Stalwart
      // account, so each runner has to see the other's lane as live.
      const first = await startLane({ hold: 5_000, runner: holder });

      try {
        const second = await startLane({ hold: 800, runner: challenger });
        const outcome = await second.settled();
        expect(outcome.held, outcome.message).toBe(false);
        expect(outcome.message).toMatch(/Another e2e lane is running: pid/);
      } finally {
        await first.stop();
      }
    },
  );

  it.each([
    { runners: ['playwright', 'playwright'] },
    { runners: ['vitest', 'vitest'] },
    { runners: ['playwright', 'vitest'] },
  ] as const)(
    'admits only one of two lanes ($runners) racing for an abandoned lock',
    async ({ runners }) => {
      // The case the first version of this lock got wrong: both lanes find a
      // dead holder, both take it over, and both run against one mailbox. It
      // takes two real processes to show — inside one, neither can tell the
      // other is alive.
      writeLock({ pid: DEAD_PID });

      const lanes: Array<Awaited<ReturnType<typeof startLane>>> = [];
      for (const runner of runners) lanes.push(await startLane({ hold: 800, runner }));
      const outcomes = await Promise.all(lanes.map((lane) => lane.settled()));

      expect(
        outcomes.filter((outcome) => outcome.held),
        `exactly one lane may hold the lock, got ${JSON.stringify(outcomes)}`,
      ).toHaveLength(1);
      expect(outcomes.find((outcome) => !outcome.held)?.message)
        .toMatch(/Another e2e lane is running/);
    },
  );

  it('takes over from a lane that was killed', async () => {
    writeLock({ pid: DEAD_PID });
    const { acquireLaneLock } = await loadLock();

    // Otherwise one `kill -9` locks out every run that follows it.
    await expect(acquireLaneLock()).resolves.toBeUndefined();
  });

  it('takes over when the recorded pid belongs to something else now', async () => {
    // A pid gets reused. This process is alive and is not a playwright run,
    // and the record is older than any lane could be, so the lock is
    // abandoned however alive its pid looks.
    writeLock({
      pid: process.pid,
      startedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
      argv: ['some-unrelated-process'],
    });
    const { acquireLaneLock } = await loadLock();

    await expect(acquireLaneLock()).resolves.toBeUndefined();
  });

  it('takes over from a lock file it cannot read', async () => {
    fs.writeFileSync(lockPath, 'not json');
    const { acquireLaneLock } = await loadLock();

    await expect(acquireLaneLock()).resolves.toBeUndefined();
  });

  it('survives the holder releasing while it is being read', async () => {
    // The lock is gone between the failed create and the read of it. That is
    // an ordinary release, not a reason to fail the run.
    writeLock({ pid: DEAD_PID });
    const { acquireLaneLock } = await loadLock();
    const realRead = fs.readFileSync;
    let removed = false;
    vi.spyOn(fs, 'readFileSync').mockImplementation(((file: any, ...rest: any[]) => {
      if (file === lockPath && !removed) {
        removed = true;
        fs.rmSync(lockPath, { force: true });
      }
      return (realRead as any)(file, ...rest);
    }) as any);

    try {
      await expect(acquireLaneLock()).resolves.toBeUndefined();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('leaves a lock that is no longer ours alone', async () => {
    const { acquireLaneLock, releaseLaneLock } = await loadLock();
    await acquireLaneLock();
    // A later run decided we were gone and took it. Releasing now would let
    // a third lane in beside the one that holds it.
    writeLock({ owner: 'the-run-that-took-over', pid: process.pid });

    releaseLaneLock();

    expect(fs.existsSync(lockPath)).toBe(true);
  });

  it('does not mind releasing nothing', async () => {
    const { releaseLaneLock } = await loadLock();

    expect(() => releaseLaneLock()).not.toThrow();
  });

  it('leaves nothing behind but the lock', async () => {
    // The staging file the lock is written through is an implementation
    // detail and must not accumulate in /tmp.
    const { acquireLaneLock, releaseLaneLock } = await loadLock();

    await acquireLaneLock();
    releaseLaneLock();

    expect(fs.readdirSync(path.dirname(lockPath))).toEqual([]);
  });
});
