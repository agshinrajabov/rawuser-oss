/**
 * The Workers rate-limit binding on one machine: so many calls per key in a
 * window, counted in memory. One process serves every request here, so the
 * count is exact where Cloudflare's is per location.
 */

export interface Limiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export function fixedWindow(
  limit: number,
  periodSeconds: number,
  clock: () => number = Date.now,
): Limiter & { size(): number } {
  const windows = new Map<string, { started: number; count: number }>();
  const period = periodSeconds * 1000;
  return {
    async limit({ key }) {
      const now = clock();
      // Keys nobody has used for a window are forgotten, so the map stays small.
      if (windows.size > 10_000)
        for (const [k, w] of windows) if (now - w.started >= period) windows.delete(k);
      const w = windows.get(key);
      if (!w || now - w.started >= period) {
        windows.set(key, { started: now, count: 1 });
        return { success: true };
      }
      w.count++;
      return { success: w.count <= limit };
    },
    size: () => windows.size,
  };
}
