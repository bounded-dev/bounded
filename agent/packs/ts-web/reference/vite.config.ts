// GENERATED from packs/ts-web/template.ts by packs/ts-web/scripts/new-web-app.ts — do not edit.
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      // PLACEHOLDER (TN-26-006 Phase C wires this for real). The service's HTTP
      // entry is `serveStandalone` from the generated service-runtime; point
      // this at wherever it listens. Until `npm run dev` starts both processes,
      // run the service yourself in another terminal.
      "/trpc": { target: "http://localhost:3000", changeOrigin: true },
    },
  },
});
