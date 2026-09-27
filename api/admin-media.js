// Authenticated admin endpoint listing recently generated media.
//   GET → { files: [{ path, url, mimeType, size, createdAt }, ...] }
// Same Basic-auth gate as /api/admin-config — nobody without the admin
// credentials can see this, and it reads straight from Supabase Storage via
// the service-role client already used to upload these files in the first
// place (see lib/hub.js's storeMediaAsset).

import { requireAdminAuth } from '../lib/auth.js';
import { db, MEDIA_BUCKET, HUB_ENABLED } from '../lib/hub.js';

const FOLDERS = ['video', 'image'];
const DEFAULT_LIMIT = 40;

export default async function handler(req, res) {
  if (!requireAdminAuth(req, res)) return;

  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET only' });
  }

  if (!HUB_ENABLED) {
    return res.status(503).json({
      error: 'Storage not connected — set SUPABASE_SERVICE_ROLE_KEY to enable media storage.',
    });
  }

  const limit = Math.max(1, Math.min(200, Number(req.query?.limit) || DEFAULT_LIMIT));

  try {
    const perFolder = await Promise.all(
      FOLDERS.map(async (folder) => {
        const { data, error } = await db.storage.from(MEDIA_BUCKET).list(folder, {
          limit,
          sortBy: { column: 'created_at', order: 'desc' },
        });
        if (error || !data) return [];
        return data
          // Supabase lists subfolders as entries with no metadata — skip those.
          .filter((entry) => entry.id && entry.metadata)
          .map((entry) => {
            const path = `${folder}/${entry.name}`;
            const { data: pub } = db.storage.from(MEDIA_BUCKET).getPublicUrl(path);
            return {
              path,
              url: pub?.publicUrl || null,
              mimeType: entry.metadata?.mimetype || null,
              size: entry.metadata?.size ?? null,
              createdAt: entry.created_at || null,
            };
          });
      }),
    );

    const files = perFolder
      .flat()
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
      .slice(0, limit);

    return res.status(200).json({ files });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
