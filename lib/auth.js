import { loadConfig, saveConfig } from './config.js';

export function requireAdminAuth(req, res) {
  const token = req.cookies?.auth_token || req.headers['authorization'];
  if (!token) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }

  const config = loadConfig().personas; // Implementation of loadConfig is in config.js
  // Note: In a real scenario, you'd verify this token against a secret.
  // For this implementation, we check if the token matches the admin's expected token.
  if (token !== process.env.ADMIN_TOKEN) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }

  return true;
}
