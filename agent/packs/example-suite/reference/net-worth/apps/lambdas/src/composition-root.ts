// Generated from the design (ADR 2026-067); do not edit: the design gate regenerates it.
// The one place that decides which adapter backs which port.
import { DrizzleListWorkspacesStore } from "@dogfood/net-worth/adapters/drizzle";
import { createListWorkspacesLambda } from "@dogfood/net-worth/adapters/lambda";
import { ListWorkspacesHandler } from "@dogfood/net-worth/application";
import { drizzle } from "drizzle-orm/node-postgres";

export function composeListWorkspaces(): ReturnType<typeof createListWorkspacesLambda> {
  const db = drizzle(connectionUrl());

  return createListWorkspacesLambda({
    workspaces: {
      list: new ListWorkspacesHandler(new DrizzleListWorkspacesStore(db)),
    },
  });
}

// DATABASE_URL comes only from the environment: never a hard-coded address, never a fallback.
function connectionUrl(): string {
  const value = process.env.DATABASE_URL;
  if (value === undefined || value === "") throw new Error("DATABASE_URL is not set");
  return value;
}
