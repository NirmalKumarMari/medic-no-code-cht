import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiTarget = process.env.REVIEW_API_TARGET ?? "http://127.0.0.1:3003";

// `npm run dev`        serves the app at http://localhost:5173/
// `npm run dev:proxy`  serves it under /absproxy/5173/, for the workshop's
//                      CloudFront proxy, which keeps that path prefix.
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  base: mode === "proxy" ? "/absproxy/5173/" : "/",
  server: {
    host: mode === "proxy" ? true : "127.0.0.1",
    port: 5173,
    // Fail instead of quietly moving to another port, which would break the proxy path.
    strictPort: true,
    // Allow requests that arrive through the CloudFront proxy.
    allowedHosts: [".cloudfront.net"],
    proxy: {
      "/api": { target: apiTarget, changeOrigin: true },
      "/absproxy/5173/api": {
        target: apiTarget,
        changeOrigin: true,
        rewrite: (path) => path.replace("/absproxy/5173", ""),
      },
    },
  },
}));
