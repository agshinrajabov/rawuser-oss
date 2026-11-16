/**
 * A site's address from the domain as its owner typed it.
 *
 * A site on the internet is served over https, and that is what a bare
 * domain means. Two cases are not: an address typed with `http://`, and a
 * site on this machine (`localhost`, `127.0.0.1`), which is how someone
 * tries Rawuser before putting it anywhere. Those keep http, so the links
 * the dashboard opens and the pages the server reads are the ones that
 * exist.
 */

/** The host of a typed domain or address: lowercased, no scheme, port or path. */
function hostOf(domain: string): string {
  const rest = domain
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/[/?#].*$/, "");
  // An IPv6 address is written in brackets when a port follows it.
  const bracketed = /^\[([^\]]*)\](?::\d+)?$/.exec(rest);
  if (bracketed) return bracketed[1] as string;
  // More than one colon and no brackets: a bare IPv6 address, with no port.
  return (rest.match(/:/g) ?? []).length > 1 ? rest : rest.replace(/:\d+$/, "");
}

/** A host that can only be this machine. */
export function isLocalHost(host: string): boolean {
  const h = hostOf(host);
  return (
    h === "localhost" || h.endsWith(".localhost") || /^127(\.\d{1,3}){3}$/.test(h) || h === "::1"
  );
}

/**
 * `https://example.com` for "example.com", "Example.com/pricing" or
 * "https://example.com/"; `http://localhost:4100` for "localhost:4100";
 * `http://staging.example.com` only when typed with `http://`. Never a
 * path, never a trailing slash.
 */
export function siteOrigin(domain: string): string {
  const typed = domain.trim();
  const scheme = /^(https?):\/\//i.exec(typed)?.[1]?.toLowerCase();
  const rest = typed
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
    .replace(/[/?#].*$/, "")
    .toLowerCase();
  return `${scheme ?? (isLocalHost(rest) ? "http" : "https")}://${rest}`;
}
