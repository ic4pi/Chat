import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';

export default defineConfig({
  plugins: [react()],
  // When embedded at /agent/ inside the main Vercel project, all asset
  // references must be prefixed so the browser finds them at /agent/assets/…
  // not /assets/… (which would 404 and leave a black screen).
  base: process.env['VITE_BASE_PATH'] ?? '/',
  server: {
    port: 5174,
    strictPort: true,
  },
});
