/**
 * A build that was given none of the six values of src/lib/identity.ts.
 * Imported first, by itself, by a test of that build:
 *
 *   import "../identity/unset";
 */

for (const name of [
  "NEXT_PUBLIC_EDGE_ORIGIN",
  "NEXT_PUBLIC_APP_ORIGIN",
  "NEXT_PUBLIC_OPERATOR_NAME",
  "NEXT_PUBLIC_OPERATOR_EMAIL",
  "NEXT_PUBLIC_SUPPORT_EMAIL",
  "NEXT_PUBLIC_PRIVACY_EMAIL",
]) {
  delete process.env[name];
}

export {};
