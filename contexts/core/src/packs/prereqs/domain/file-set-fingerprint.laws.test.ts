import { valueObjectLaws } from "../../../domain/shared/value-object.laws.test-support.ts";
import { FileSetFingerprint } from "./file-set-fingerprint.ts";

valueObjectLaws("FileSetFingerprint", FileSetFingerprint, [{ sha256: "a".repeat(64), fileCount: 2 }, { sha256: "b".repeat(64), fileCount: 0 }], [{ sha256: "A".repeat(64), fileCount: 2 }, { sha256: "a".repeat(64), fileCount: -1 }, { sha256: "a".repeat(64) }]);
