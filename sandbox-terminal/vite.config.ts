import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react-swc';

export default defineConfig(({ mode }) => {
  // loadEnv puts VITE_* from .env / .env.production into an object.
  // process.env alone does NOT see .env.production for `base`.
  const env = loadEnv(mode, process.cwd(), '');
  const base =
    env.VITE_BASE_PATH ||
    env.VITE_BASE ||
    process.env['VITE_BASE_PATH'] ||
    process.env['VITE_BASE'] ||
    '/';

  return {
    plugins: [react()],
    // When embedded at /agent/ inside the main Vercel project, all asset
    // references must be prefixed so the browser finds them at /agent/assets/…
    // not /assets/… (which would 404 and leave a black screen).
    base,
    server: {
      port: 5174,
      strictPort: true,
    },
  };
});
