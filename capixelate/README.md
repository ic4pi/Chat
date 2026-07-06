# Capixelate — Portfolio Seas

A highly creative, immersive pirate sailing portfolio experience built with Next.js, Three.js, and real-time WebGL water shaders.

## Features

### 🌊 Game Experience
- **Real-time 3D ocean** with custom GLSL wave shaders, foam, specular highlights, and moonlit reflections
- **Pirate ship** with keyboard controls, animated sails that billow in the wind, side cannons, and lantern lighting
- **Starry night sky** with moon and atmospheric fog
- **Multiple explorable islands** each with animated campfires and glowing portal icons linked to real projects
- **Enemy ships and sea monsters** with full AI state machines (patrol → chase → attack → flee)
- **Combat system** — fire cannons with SPACE, blow up enemies, collect loot gold
- **Fog-of-war minimap** that reveals as you explore
- **"Sail to Island"** shortcut button

### ⚙️ Admin Dashboard (`/admin`)
- **Project management** — add, edit, remove portfolio projects; assign them to islands
- **Island management** — place islands at world coordinates, set scale, upload custom 3D models
- **Enemy configuration** — full enemy builder:
  - Type: ship / sea monster
  - AI behavior: fight to death / flee immediately / flee before sinking
  - Attack mode: cannon / ram / tentacle / bite / charge
  - Stats: HP, cannon accuracy, speed, flee threshold
  - Patrol zone: set center and radius
  - Loot value and difficulty
  - Spawn count
  - Upload custom 3D model and loot image
- **Ships & Models** — upload custom `.glb`/`.gltf` 3D models for the player ship and others
- **Sea Map** — canvas overview of the full world showing island positions, enemy patrol zones, and player start

### 🗺️ World Map
The game world spans 2000×2000 units. Islands are placed in the north (negative Z), and enemy zones define where ships and monsters patrol.

## Controls

| Key | Action |
|-----|--------|
| `W` / `↑` | Sail forward |
| `S` / `↓` | Reverse |
| `A` / `←` | Turn left |
| `D` / `→` | Turn right |
| `SPACE` | Fire cannons (both sides) |

## Tech Stack

- **Next.js 16** (App Router, TypeScript)
- **Three.js** — custom GLSL shaders for water, WebGL rendering
- **Prisma 7 + SQLite** via `@prisma/adapter-libsql`
- **Tailwind CSS v4**
- **JWT authentication** via `jose`
- **File upload** — local `/public/uploads/` directory

## Getting Started

```bash
cd capixelate
npm install
npx prisma migrate dev
npm run dev
```

Visit `http://localhost:3000` for the game.
Visit `http://localhost:3000/admin` for the dashboard.

**Default admin credentials:**
- Username: `admin`
- Password: `capixelate2024`

Change these via environment variables:
```env
ADMIN_USERNAME=yourusername
ADMIN_PASSWORD=yourpassword
NEXTAUTH_SECRET=your-secret-key
```

## Seeding Demo Data

After starting, visit `/admin` and click **✨ Seed Demo Data** to populate 3 islands, 3 projects, 2 enemy ships, and 2 sea monsters.

Or via curl:
```bash
curl -X POST http://localhost:3000/api/seed
```

## Deployment

1. Set `DATABASE_URL` to a persistent SQLite path or a libsql/Turso URL
2. Set `NEXTAUTH_SECRET` to a strong random string
3. Set `ADMIN_USERNAME` and `ADMIN_PASSWORD`
4. Deploy to Vercel, Railway, or any Node.js host

For production file uploads, configure cloud storage (S3, Cloudflare R2) and replace the upload handler in `app/api/upload/route.ts`.
