import react from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig } from "vite";

/**
 * BASE_PATH lets the same build be served from the domain root OR from a
 * sub-path behind someone else's nginx. Vite has to know the prefix at BUILD
 * time because it writes asset URLs into index.html; a runtime guess would
 * work until the first hard refresh on a deep link.
 *
 * The dev server proxies /api and /tiles to the ElectionIntOS server, so the
 * app talks to the same origin in development as it does in production.
 * Without that, dev would need CORS and absolute URLs that production does
 * not — exactly the difference that hides bugs until deploy.
 */
export default defineConfig(() => {
  const base = process.env.BASE_PATH || "/";
  return {
    base,
    plugins: [react()],
    resolve: { alias: { "@": path.resolve(__dirname, "src") } },
    server: {
      port: 3051,
      proxy: {
        "/api": { target: "http://localhost:3050", changeOrigin: true },
        "/tiles": { target: "http://localhost:3050", changeOrigin: true },
      },
    },
  };
});
