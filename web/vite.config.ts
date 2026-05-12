import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { nodePolyfills } from "vite-plugin-node-polyfills";

export default defineConfig({
  plugins: [
    react(),
    // @solana/web3.js + @solana/spl-token reach for Buffer / process / etc.
    // This plugin shims the relevant Node builtins for the browser.
    nodePolyfills({ globals: { Buffer: true, global: true, process: true } }),
  ],
  server: {
    port: 5173,
    // Allow Vite to import files from `code/shared/` (one level above `web/`).
    // Single source of truth for AGENT_DOC lives there — see `shared/agent-doc.ts`.
    fs: { allow: [".."] },
    proxy: {
      "/api": {
        target: "https://susurration.fly.dev",
        changeOrigin: true,
        secure: true,
      },
    },
  },
});
