import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `npm run dev`        serves the app at http://localhost:5173/
// `npm run dev:proxy`  serves it under /absproxy/5173/, for the workshop's
//                      CloudFront proxy, which keeps that path prefix.
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  base: mode === 'proxy' ? '/absproxy/5173/' : '/',
  server: {
    host: true,
    port: 5173,
    // Fail instead of quietly moving to another port, which would break the proxy path.
    strictPort: true,
    // Allow requests that arrive through the CloudFront proxy.
    allowedHosts: ['.cloudfront.net'],
  },
}));
