import { initTRPC } from "@trpc/server";

// Shared by every router in this context so they can be combined.
export const t = initTRPC.create();
