import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "bun:test";
import * as releaseBuilder from "../../build-release.ts";

const formatObservedMinimumOS = (releaseBuilder as unknown as {
  formatObservedMinimumOS?: (targetId: string, observed: {
    readonly kernelVersion: string;
    readonly macVersion?: string;
    readonly libc?: string;
    readonly libcVersion?: string;
  }) => string;
}).formatObservedMinimumOS;

test("stable Windows minimumOS names the observed kernel and refuses an unresolved build", () => {
  expect(formatObservedMinimumOS).toBeFunction();
  if (formatObservedMinimumOS === undefined) return;
  expect(formatObservedMinimumOS("windows-x64", { kernelVersion: "10.0.26100" })).toBe("Windows kernel 10.0.26100");
  expect(() => formatObservedMinimumOS("windows-x64", { kernelVersion: "10.0" })).toThrow(/Windows|kernel|version/i);
  expect(() => formatObservedMinimumOS("windows-arm64", { kernelVersion: "" })).toThrow(/Windows|kernel|version/i);
});

test("stable macOS and Linux minimumOS values come from observed versions", () => {
  expect(formatObservedMinimumOS).toBeFunction();
  if (formatObservedMinimumOS === undefined) return;
  expect(formatObservedMinimumOS("darwin-arm64", { kernelVersion: "24.6.0", macVersion: "15.7.3" })).toBe("macOS 15.7.3");
  expect(formatObservedMinimumOS("linux-x64-gnu", { kernelVersion: "6.8.0-1031-azure", libc: "gnu", libcVersion: "2.39" })).toBe("Linux kernel 6.8.0-1031-azure, glibc 2.39");
  expect(formatObservedMinimumOS("linux-arm64-musl", { kernelVersion: "6.8.0-1031-azure", libc: "musl", libcVersion: "1.2.5" })).toBe("Linux kernel 6.8.0-1031-azure, musl 1.2.5");
  expect(() => formatObservedMinimumOS("linux-x64-gnu", { kernelVersion: "6.8.0", libc: "gnu" })).toThrow(/libc|version/i);
});

test("each native release job compares its emitted minimumOS with independent runner probes", () => {
  const workflow = readFileSync(resolve(import.meta.dir, "../../../.github/workflows/release.yml"), "utf8");
  expect(workflow).toContain(".minimumOS");
  expect(workflow).toContain("getconf GNU_LIBC_VERSION");
  expect(workflow).toContain("sw_vers -productVersion");
  expect(workflow).toContain("OSVersion.Version.ToString(3)");
  expect(workflow).toContain("ldd --version");
  expect(workflow).toMatch(/minimumOS.*musl|musl.*minimumOS/s);
});
