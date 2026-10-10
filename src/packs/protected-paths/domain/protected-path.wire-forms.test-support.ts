// The wire forms of a protected-path rule that the pack's own tests expect
// ProtectedPath.parse to accept, copied verbatim from protected-path.test.ts
// and protected-path.laws.test.ts. The package catalogue's schema for the
// protectedPaths point must accept each of them
// (src/core/composition-root/pack-wire-schemas.test.ts). They are copies: a
// later change should make the concept tests consume this list (ADR 2026-029).
const rule = { match: "packages/db/**", deny: ["modify", "delete"], redirect: "Change the schema instead" };

/** Every wire form of a protected-path rule the concept tests accept. */
export const protectedPathWireForms: readonly unknown[] = [
  rule,
  { ...rule, match: ".env", deny: ["read"], file: true, why: "secrets" },
  { match: " ./packages//db/** ", deny: ["delete", "read", "delete"], redirect: " Ask the db owner ", why: " generated " },
  { ...rule, match: ".env", file: true },
  { ...rule, file: false },
  { ...rule, except: ["./packages/db/src/schema/**"] },
];
