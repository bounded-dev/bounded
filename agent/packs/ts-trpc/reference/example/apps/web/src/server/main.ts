import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import index from "../client/index.html";
import { composeApp } from "./composition-root.ts";
import { seed } from "./seed.ts";

const router = composeApp();
await seed(router);

const server = Bun.serve({
  routes: {
    "/": index,
    "/trpc/*": (req) => fetchRequestHandler({ endpoint: "/trpc", req, router }),
  },
});

console.log(`Listening on ${server.url}`);
