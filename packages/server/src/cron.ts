/**
 * The generation worker's schedules on one machine (docs/specs/run-anywhere.md).
 * Cloudflare calls `scheduled` with the cron line that fired; this does the
 * same, on the minute, in UTC.
 */

/** The lines of `[env.production] triggers` in the generation config; a test holds the two equal. */
export const SCHEDULES = ["0 */6 * * *", "0 * * * *", "0 6 * * 1", "*/5 * * * *"] as const;

// One field of a cron line against a value: a star, a star with a step, a number, or a list of those.
function fieldMatches(field: string, value: number): boolean {
  return field.split(",").some((part) => {
    if (part === "*") return true;
    const step = /^\*\/(\d+)$/.exec(part);
    if (step) return value % Number(step[1]) === 0;
    if (/^\d+$/.test(part)) return Number(part) === value;
    throw new Error(`cron: cannot read "${part}"`);
  });
}

/** Whether a five-field cron line fires at this minute (UTC). */
export function fires(cron: string, at: Date): boolean {
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5) throw new Error(`cron: five fields, got "${cron}"`);
  const [minute, hour, day, month, weekday] = f as [string, string, string, string, string];
  return (
    fieldMatches(minute, at.getUTCMinutes()) &&
    fieldMatches(hour, at.getUTCHours()) &&
    fieldMatches(day, at.getUTCDate()) &&
    fieldMatches(month, at.getUTCMonth() + 1) &&
    fieldMatches(weekday, at.getUTCDay())
  );
}

export type Scheduled = (cron: string, scheduledTime: number) => Promise<void>;

/**
 * Calls `run` for every schedule that fires, once a minute. A schedule
 * still running from an earlier minute is not started again. Returns the
 * function that stops it.
 */
export function startCron(
  run: Scheduled,
  schedules: readonly string[] = SCHEDULES,
  log: (line: string) => void = console.error,
): { stop: () => void; tick: (at: Date) => Promise<void>[] } {
  const running = new Set<string>();
  const tick = (at: Date): Promise<void>[] =>
    schedules
      .filter((cron) => fires(cron, at) && !running.has(cron))
      .map((cron) => {
        running.add(cron);
        return run(cron, at.getTime())
          .catch((e) => log(`[cron ${cron}] ${e instanceof Error ? e.message : String(e)}`))
          .finally(() => running.delete(cron));
      });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    // The next whole minute, so a line fires once and on time.
    const wait = 60_000 - (Date.now() % 60_000);
    timer = setTimeout(() => {
      tick(new Date(Math.floor(Date.now() / 60_000) * 60_000));
      arm();
    }, wait);
    timer.unref?.();
  };
  arm();
  return { stop: () => clearTimeout(timer), tick };
}
