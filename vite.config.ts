import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Vite root is web/, output goes to dist/web/ which server/src/index.ts
// serves statically in demo mode. In dev mode, Vite runs on its own port and
// proxies /api (including the SSE stream) to the Fastify server on PORT
// (default 3000), so the browser only ever talks to one origin.
export default defineConfig({
  root: "web",
  plugins: [react()],
  build: {
    outDir: "../dist/web",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api": {
        target: `http://localhost:${process.env.PORT ?? 3000}`,
        changeOrigin: true,
      },
    },
  },
});
