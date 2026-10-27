import { defineConfig } from "vite";
import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import process from "node:process";
const host = process.env.TAURI_DEV_HOST;

// https://v2.tauri.app/start/frontend/sveltekit/
export default defineConfig(() => ({
  plugins: [tailwindcss(), sveltekit()],

  // Unit tests for pure TS modules. E2E lives in tests/e2e (Playwright).
  test: {
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
    environment: "node",
  },

  // Release builds (PEETMAIL_SOURCEMAPS=1 in release.yml) write source maps for Sentry,
  // "hidden" so the shipped JS doesn't point at them; CI uploads them, then deletes them
  // before they'd be embedded in the exe.
  build: { sourcemap: process.env.PEETMAIL_SOURCEMAPS === "1" ? /** @type {const} */ ("hidden") : false },

  // Don't hide Rust errors behind Vite's screen clearing.
  clearScreen: false,
  server: {
    // Tauri expects a fixed port.
    port: 1420,
    strictPort: true,
    host: host || "127.0.0.1",
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
}));
