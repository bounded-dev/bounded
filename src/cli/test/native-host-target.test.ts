import { expect, test } from "bun:test";
import * as releaseBuilder from "../../build-release.ts";

type ObservedHost = { readonly platform: string; readonly arch: string; readonly libc?: string };
const assertNativeReleaseTarget = (releaseBuilder as unknown as {
  assertNativeReleaseTarget?: (targetId: string, observedHost: ObservedHost) => void;
}).assertNativeReleaseTarget;

test("stable target gate compares the requested OS and CPU with an observed host before build", () => {
  expect(assertNativeReleaseTarget).toBeFunction();
  if (assertNativeReleaseTarget === undefined) return;
  expect(() => assertNativeReleaseTarget("windows-arm64", { platform: "darwin", arch: "arm64" })).toThrow(/target.*host|host.*target/i);
  expect(() => assertNativeReleaseTarget("darwin-x64", { platform: "darwin", arch: "arm64" })).toThrow(/target.*host|host.*target/i);
  expect(() => assertNativeReleaseTarget("darwin-arm64", { platform: "darwin", arch: "arm64" })).not.toThrow();
});

test("stable target gate compares Linux libc and refuses an unresolved libc", () => {
  expect(assertNativeReleaseTarget).toBeFunction();
  if (assertNativeReleaseTarget === undefined) return;
  expect(() => assertNativeReleaseTarget("linux-arm64-musl", { platform: "linux", arch: "arm64", libc: "gnu" })).toThrow(/target.*host|host.*target|libc/i);
  expect(() => assertNativeReleaseTarget("linux-arm64-gnu", { platform: "linux", arch: "arm64", libc: "unknown" })).toThrow(/libc|unresolved|unknown/i);
  expect(() => assertNativeReleaseTarget("linux-arm64-gnu", { platform: "linux", arch: "arm64", libc: "gnu" })).not.toThrow();
});
