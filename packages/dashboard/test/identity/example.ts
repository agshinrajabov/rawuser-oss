/**
 * A made-up install for the tests: the six build values of src/lib/identity.ts,
 * at reserved names. The module reads them once, when it is first imported,
 * so a test file that needs them imports this file first, by itself:
 *
 *   import "../identity/example";
 *
 * A test of the build that was given nothing imports "./unset" the same way.
 */

export const EDGE = "https://edge.example.com";
export const APP = "https://app.example.com";
export const OPERATOR = "Sam";
export const OPERATOR_EMAIL = "sam@example.com";
export const SUPPORT_EMAIL = "help@example.com";
export const PRIVACY_EMAIL = "privacy@example.com";

process.env.NEXT_PUBLIC_EDGE_ORIGIN = EDGE;
process.env.NEXT_PUBLIC_APP_ORIGIN = APP;
process.env.NEXT_PUBLIC_OPERATOR_NAME = OPERATOR;
process.env.NEXT_PUBLIC_OPERATOR_EMAIL = OPERATOR_EMAIL;
process.env.NEXT_PUBLIC_SUPPORT_EMAIL = SUPPORT_EMAIL;
process.env.NEXT_PUBLIC_PRIVACY_EMAIL = PRIVACY_EMAIL;
