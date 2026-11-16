/**
 * The machine's own resolver, for the workers' public-address check
 * (generation's lib/public-url.ts). On Cloudflare a Worker has no resolver
 * and asks one over HTTPS; here the operating system answers, so the check
 * asks nobody outside this machine's own DNS.
 */

import { lookup } from "node:dns/promises";

/** Every address of a host; an empty list when the name does not exist; null when it could not be asked. */
export async function resolveSite(host: string): Promise<string[] | null> {
  try {
    return (await lookup(host, { all: true })).map((a) => a.address);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === "ENOTFOUND" || code === "ENODATA" ? [] : null;
  }
}
