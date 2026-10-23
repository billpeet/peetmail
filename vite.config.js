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
    include: ["src/**/*.test.ts"],
    environment: "node",
  },

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
