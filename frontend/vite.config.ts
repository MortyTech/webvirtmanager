import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  // noVNC uses top-level await (WebCodecs detection); raise the build target.
  esbuild: {
    target: "esnext",
  },
  build: {
    target: "esnext",
  },
  server: {
    // In dev, proxy API + VNC websocket to the FastAPI backend.
    proxy: {
      "/api": { target: "http://127.0.0.1:8000", changeOrigin: true },
      "/vnc": { target: "http://127.0.0.1:8000", ws: true, changeOrigin: true },
      "/login": { target: "http://127.0.0.1:8000", changeOrigin: true },
      "/oauth2": { target: "http://127.0.0.1:8000", changeOrigin: true },
      "/logout": { target: "http://127.0.0.1:8000", changeOrigin: true },
      "/healthz": { target: "http://127.0.0.1:8000", changeOrigin: true },
    },
  },
});
