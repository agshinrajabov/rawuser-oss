/**
 * AES-256-GCM for the two-step secrets at rest
 * (docs/specs/security-hardening.md, section 1.4).
 *
 * The key is the Workers secret MFA_ENCRYPTION_KEY: 32 random bytes in
 * standard base64 (`openssl rand -base64 32`). The user id is the
 * additional data, so a sealed secret copied onto another user's row does
 * not open. Stored form: "v1.<iv b64url>.<ciphertext b64url>". The version
 * prefix leaves room for a second key later.
 */

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64(s: string): Uint8Array | null {
  try {
    const std = s.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(std + "=".repeat((4 - (std.length % 4)) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** The AES key from the secret, or null when it is unset or not 32 bytes. */
export async function importBoxKey(secret: string | undefined): Promise<CryptoKey | null> {
  if (!secret) return null;
  const raw = fromB64(secret.trim());
  if (!raw || raw.length !== 32) return null;
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function sealSecret(key: CryptoKey, plain: Uint8Array, aad: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad) },
      key,
      plain,
    ),
  );
  return `v1.${b64url(iv)}.${b64url(ct)}`;
}

/** The plain bytes, or null when the form, the key or the additional data is wrong. */
export async function openSecret(
  key: CryptoKey,
  sealed: string,
  aad: string,
): Promise<Uint8Array | null> {
  const [v, ivS, ctS] = sealed.split(".");
  if (v !== "v1" || !ivS || !ctS) return null;
  const iv = fromB64(ivS);
  const ct = fromB64(ctS);
  if (!iv || !ct) return null;
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad) },
        key,
        ct,
      ),
    );
  } catch {
    return null;
  }
}
