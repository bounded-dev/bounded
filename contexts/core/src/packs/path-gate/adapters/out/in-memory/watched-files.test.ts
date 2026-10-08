import { watchedFilesConformance } from "../../../application/watch-shell/watch-shell.watched-files.test-support.ts";
import { InMemoryWatchedFiles } from "./watched-files.ts";

watchedFilesConformance("InMemoryWatchedFiles", async (committed) => {
  const files = new InMemoryWatchedFiles(committed);
  return {
    files,
    write: async (path, content) => files.write(path, content),
    remove: async (path) => files.remove(path),
    read: async (path) => files.read(path),
    readQuarantined: async (location, path) => files.quarantined(location, path),
  };
});
