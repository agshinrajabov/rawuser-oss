/**
 * The QR code for an authenticator app, drawn in the browser (privacy review
 * condition 7, docs/specs/security-hardening.md §1.4 and §1.6). The
 * otpauth URI holds the secret, so it never goes to a QR web service, an
 * image URL or any other host: a bundled generator (qrcode-generator, MIT,
 * no network) turns it into modules, and the screen draws them as an
 * inline SVG path.
 *
 * The generator is a dynamic import, so its chunk loads only when the Turn
 * on dialog or the required set-up page asks for a code.
 */

export type QrModules = { size: number; path: string };

/** One SVG path of 1x1 squares, merged along each row. */
export function modulesPath(size: number, isDark: (row: number, col: number) => boolean): string {
  const parts: string[] = [];
  for (let r = 0; r < size; r++) {
    let c = 0;
    while (c < size) {
      if (!isDark(r, c)) {
        c++;
        continue;
      }
      const start = c;
      while (c < size && isDark(r, c)) c++;
      parts.push(`M${start} ${r}h${c - start}v1h${start - c}z`);
    }
  }
  return parts.join("");
}

/** Error correction M, the size picked by the generator for the URI's length. */
export async function qrModules(uri: string): Promise<QrModules> {
  const { default: qrcode } = await import("qrcode-generator");
  const qr = qrcode(0, "M");
  qr.addData(uri);
  qr.make();
  const size = qr.getModuleCount();
  return { size, path: modulesPath(size, (r, c) => qr.isDark(r, c)) };
}
