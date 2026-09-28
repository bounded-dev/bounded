import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The project root, found from this module rather than the working directory:
// src/db/ in the source tree and dist/db/ once built both sit two levels below it.
const projectRoot = fileURLToPath(new URL("../../", import.meta.url));

/** The database used when DATABASE_URL is unset: data/app.sqlite in the project. */
export const defaultDatabaseUrl = pathToFileURL(join(projectRoot, "data", "app.sqlite")).href;

/**
 * The local file a `file:` database URL names, or undefined when it names no
 * file (a remote database, or SQLite's in-memory one). Accepts the forms the
 * driver does: `file:relative/path`, `file:/absolute/path` and
 * `file:///absolute/path`, percent-decoded, query ignored.
 */
export function databaseFile(url: string): string | undefined {
  const match = /^file:(?:\/\/([^/?#]*))?([^?#]*)/i.exec(url);
  if (!match) return undefined;
  const host = match[1];
  if (host !== undefined && host !== "" && host.toLowerCase() !== "localhost") {
    throw new Error(`DATABASE_URL names a host in a file URL: ${url}`);
  }
  const path = decodeURIComponent(match[2] ?? "");
  return path === "" || path === ":memory:" ? undefined : resolve(path);
}

const url = process.env["DATABASE_URL"] ?? defaultDatabaseUrl;
const file = databaseFile(url);
if (file !== undefined) mkdirSync(dirname(file), { recursive: true });

export const client = createClient({ url });
export const db = drizzle(client);
