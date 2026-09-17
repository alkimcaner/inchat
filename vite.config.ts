import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  base: "./",
  server: {
    port: 1420,
    strictPort: true,
    host: "127.0.0.1",
    proxy: {
      // Local dev: `wrangler dev` (run from worker/) serves the API on :8787.
      "/api": "http://127.0.0.1:8787",
    },
  },
  envPrefix: ["VITE_"],
  build: {
    target: "esnext",
    sourcemap: false,
  },
});
