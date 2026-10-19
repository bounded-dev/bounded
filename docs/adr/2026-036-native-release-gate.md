# 2026-036: Native release evidence and a version-bound target set

**Status:** accepted for the native release gate of issue #67. Amends [ADR 2026-033](2026-033-standalone-command-routing.md). Actual native workflow runs and signing credentials are required before publishing a release.

## Context

A compiler can produce a binary for another target, and a producing job can write its own smoke-test JSON. Neither proves that the target's native host executed the binary. A multi-target release also needs an explicit support decision before jobs start; choosing successful artifacts after the fact could silently omit a failed platform.

## Decision

- `src/release-targets.json` declares a sorted, nonempty supported subset of the eight candidate targets for the exact package version. The release workflow obtains its fixed native runner matrix from that declaration. Assembly requires exactly the declared set; a failed or missing job blocks the release. The 3.3.0 set is a provisional macOS arm64/x64, Linux x64 glibc, and Windows x64 set. It becomes releasable only after the native jobs pass.
- Stable builds compare the requested target with the runner's observed OS, CPU, and Linux libc before compiling or writing output. Development `--smoke` remains available on a dirty checkout. Stable manifests claim only the OS/kernel and libc versions observed on the native runner, and the workflow independently compares those claims with the runner probes.
- The protected tag workflow checks that the tag names the package version and its commit is on main. Every declared target runs the repository checks, builds and executes its own binary, exercises its installer, launcher, and fail-closed hook without Node, Bun, or npm on the smoke PATH, then attests the final archive. Windows uses native hosted runners; Linux musl uses native-architecture Alpine containers.
- macOS compiles first, signs the executable with a Developer ID Application identity and hardened runtime, and verifies the signature before package bytes or hashes are calculated. The final ZIP is notarized without changing its digest. The workflow checks the extracted quarantined distribution with Gatekeeper and an online first launch. It then runs the installed Bounded process with network access denied through `sandbox-exec`. Apple ZIPs cannot carry a stapled ticket, so offline first launch is not claimed.
- The workflow probes a real GitHub attestation certificate before native jobs. Assembly uses `gh attestation verify` with repository, source commit/ref, signer workflow, and hosted-runner restrictions, then requires exactly one verified subject digest per archive and the certificate's run invocation URI to match the current workflow run and attempt. A missing certificate field, network, CLI, or attestation refuses assembly. Producer smoke JSON is diagnostic only. Test code can inject a verifier at the assembly function; the production CLI cannot select one.
- Assembly stages the exact archives, one manifest, and both installers after all checks pass. CI creates a new draft release with `--verify-tag`, uploads without replacement, verifies the exact remote asset names, sizes, and digests, and leaves publication to a maintainer. On failure it deletes only a draft created by that run.

## Limits

The workflow and its local structural tests do not supply native run evidence. Apple signing and notarization need CI secrets; Windows and each macOS runner must execute successfully. The process-level network denial does not prove a fully disconnected Mac, including Gatekeeper services, works after installation; that issue #67 acceptance remains open. The version's target declaration can change only through a reviewed source commit before the tag is created. Candidate targets omitted from it are unsupported for that version.
