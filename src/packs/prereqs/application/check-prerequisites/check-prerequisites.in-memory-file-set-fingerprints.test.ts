import { fileSetFingerprintsConformance } from "./check-prerequisites.file-set-fingerprints.test-support.ts";
import { InMemoryFileSetFingerprints } from "./check-prerequisites.in-memory-file-set-fingerprints.test-support.ts";

fileSetFingerprintsConformance("InMemoryFileSetFingerprints", async (files) => {
  const fingerprints = new InMemoryFileSetFingerprints(files);
  return {
    fingerprints,
    write: async (path, content) => void fingerprints.files.set(path, content),
    remove: async (path) => void fingerprints.files.delete(path),
  };
});
