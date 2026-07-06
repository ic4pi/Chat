"use client";
import { useState, useEffect, useRef } from "react";

type TabId = "projects" | "islands" | "enemies" | "ships" | "map";

interface Project {
  id: string;
  title: string;
  description: string;
  url: string;
  imageUrl?: string;
  iconUrl?: string;
  tags: string;
  order: number;
  islandId?: string;
  isActive: boolean;
}

interface Island {
  id: string;
  name: string;
  posX: number;
  posZ: number;
  scale: number;
  modelUrl?: string;
  isActive: boolean;
  projects?: Project[];
}

interface Enemy {
  id: string;
  name: string;
  type: string;
  modelUrl?: string;
  lootImageUrl?: string;
  hitPoints: number;
  cannonAccuracy: number;
  difficulty: string;
  behavior: string;
  attackMode: string;
  fleeThreshold: number;
  lootValue: number;
  lootDifficulty: string;
  zoneX: number;
  zoneZ: number;
  zoneRadius: number;
  speed: number;
  spawnCount: number;
  isActive: boolean;
}

interface Ship {
  id: string;
  name: string;
  type: string;
  modelUrl?: string;
  isActive: boolean;
}

const DIFFICULTY_COLORS: Record<string, string> = {
  easy: "text-green-400 bg-green-900/30 border-green-700/40",
  normal: "text-blue-400 bg-blue-900/30 border-blue-700/40",
  hard: "text-orange-400 bg-orange-900/30 border-orange-700/40",
  legendary: "text-purple-400 bg-purple-900/30 border-purple-700/40",
};

export default function AdminDashboard() {
  const [authenticated, setAuthenticated] = useState(false);
  const [authLoading, setAuthLoading] = useState(true);
  const [loginError, setLoginError] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [activeTab, setActiveTab] = useState<TabId>("projects");
  const [projects, setProjects] = useState<Project[]>([]);
  const [islands, setIslands] = useState<Island[]>([]);
  const [enemies, setEnemies] = useState<Enemy[]>([]);
  const [ships, setShips] = useState<Ship[]>([]);
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState<{ msg: string; type: "success" | "error" } | null>(null);
  const [editingProject, setEditingProject] = useState<Partial<Project> | null>(null);
  const [editingIsland, setEditingIsland] = useState<Partial<Island> | null>(null);
  const [editingEnemy, setEditingEnemy] = useState<Partial<Enemy> | null>(null);
  const [editingShip, setEditingShip] = useState<Partial<Ship> | null>(null);
  const mapCanvasRef = useRef<HTMLCanvasElement>(null);

  const showToast = (msg: string, type: "success" | "error" = "success") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  // Auth check
  useEffect(() => {
    fetch("/api/auth")
      .then((r) => r.json())
      .then((d) => {
        setAuthenticated(d.authenticated);
        setAuthLoading(false);
      })
      .catch(() => setAuthLoading(false));
  }, []);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError("");
    const res = await fetch("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (data.success) {
      setAuthenticated(true);
    } else {
      setLoginError(data.error ?? "Invalid credentials");
    }
  };

  const handleLogout = async () => {
    await fetch("/api/auth", { method: "DELETE" });
    setAuthenticated(false);
  };

  // Load data
  useEffect(() => {
    if (!authenticated) return;
    loadAll();
  }, [authenticated]);

  const loadAll = async () => {
    setLoading(true);
    try {
      const [pr, isl, en, sh] = await Promise.all([
        fetch("/api/projects").then((r) => r.json()),
        fetch("/api/islands").then((r) => r.json()),
        fetch("/api/enemies").then((r) => r.json()),
        fetch("/api/ships").then((r) => r.json()),
      ]);
      setProjects(pr.projects ?? []);
      setIslands(isl.islands ?? []);
      setEnemies(en.enemies ?? []);
      setShips(sh.ships ?? []);
    } catch {
      showToast("Failed to load data", "error");
    } finally {
      setLoading(false);
    }
  };

  // File upload helper
  const uploadFile = async (file: File, category: string): Promise<string> => {
    const fd = new FormData();
    fd.append("file", file);
    fd.append("category", category);
    const res = await fetch("/api/upload", { method: "POST", body: fd });
    const data = await res.json();
    if (!data.url) throw new Error("Upload failed");
    return data.url;
  };

  // Seed demo data
  const handleSeed = async () => {
    if (!confirm("This will replace all data with demo data. Continue?")) return;
    const res = await fetch("/api/seed", { method: "POST" });
    const data = await res.json();
    if (data.success) {
      showToast("Demo data seeded!");
      loadAll();
    } else {
      showToast("Seed failed", "error");
    }
  };

  // Draw map
  useEffect(() => {
    if (activeTab !== "map" || !mapCanvasRef.current) return;
    const canvas = mapCanvasRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const W = canvas.width;
    const H = canvas.height;
    const SCALE = W / 1000;
    const toCanvas = (x: number, z: number) => ({
      cx: W / 2 + x * SCALE,
      cy: H / 2 + z * SCALE,
    });

    ctx.clearRect(0, 0, W, H);

    // Ocean bg
    const gradient = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, W / 2);
    gradient.addColorStop(0, "#0a2840");
    gradient.addColorStop(1, "#020c1a");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, W, H);

    // Grid
    ctx.strokeStyle = "rgba(0,100,150,0.2)";
    ctx.lineWidth = 0.5;
    for (let x = 0; x < W; x += 50) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    }
    for (let y = 0; y < H; y += 50) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }

    // Enemy zones
    enemies.filter((e) => e.isActive).forEach((e) => {
      const { cx, cy } = toCanvas(e.zoneX, e.zoneZ);
      const r = e.zoneRadius * SCALE;
      const color = e.type === "monster" ? "#7c3aed" : "#dc2626";
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = `${color}22`;
      ctx.fill();
      ctx.strokeStyle = `${color}66`;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.stroke();
      ctx.setLineDash([]);

      // Enemy icon
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(cx, cy, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.8)";
      ctx.font = "10px monospace";
      ctx.textAlign = "center";
      ctx.fillText(e.name.split(" ")[0], cx, cy - 10);
    });

    // Islands
    islands.filter((i) => i.isActive).forEach((isl) => {
      const { cx, cy } = toCanvas(isl.posX, isl.posZ);
      ctx.beginPath();
      ctx.arc(cx, cy, 10 * isl.scale, 0, Math.PI * 2);
      ctx.fillStyle = "#16a34a";
      ctx.fill();
      ctx.strokeStyle = "#4ade80";
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      ctx.font = "10px monospace";
      ctx.textAlign = "center";
      ctx.fillText(isl.name, cx, cy + 18);
    });

    // Player start
    const { cx: px, cy: pz } = toCanvas(0, 0);
    ctx.beginPath();
    ctx.arc(px, pz, 6, 0, Math.PI * 2);
    ctx.fillStyle = "#22d3ee";
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.font = "11px monospace";
    ctx.textAlign = "center";
    ctx.fillText("START", px, pz + 18);

    // Compass
    ctx.fillStyle = "rgba(0,200,200,0.8)";
    ctx.font = "12px serif";
    ctx.textAlign = "center";
    ctx.fillText("N", W / 2, 20);
    ctx.fillText("S", W / 2, H - 8);
    ctx.fillText("W", 12, H / 2);
    ctx.fillText("E", W - 12, H / 2);
  }, [activeTab, islands, enemies]);

  // ===================
  // Project CRUD
  // ===================
  const saveProject = async () => {
    if (!editingProject) return;
    const method = editingProject.id ? "PUT" : "POST";
    const url = editingProject.id ? `/api/projects/${editingProject.id}` : "/api/projects";
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...editingProject, tags: JSON.parse(editingProject.tags ?? "[]") }),
    });
    if (res.ok) {
      showToast(editingProject.id ? "Project updated!" : "Project created!");
      setEditingProject(null);
      loadAll();
    } else {
      showToast("Failed to save project", "error");
    }
  };

  const deleteProject = async (id: string) => {
    if (!confirm("Delete this project?")) return;
    await fetch(`/api/projects/${id}`, { method: "DELETE" });
    showToast("Project deleted");
    loadAll();
  };

  // ===================
  // Island CRUD
  // ===================
  const saveIsland = async () => {
    if (!editingIsland) return;
    const method = editingIsland.id ? "PUT" : "POST";
    const url = editingIsland.id ? `/api/islands/${editingIsland.id}` : "/api/islands";
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(editingIsland),
    });
    if (res.ok) {
      showToast(editingIsland.id ? "Island updated!" : "Island created!");
      setEditingIsland(null);
      loadAll();
    } else {
      showToast("Failed to save island", "error");
    }
  };

  const deleteIsland = async (id: string) => {
    if (!confirm("Delete this island?")) return;
    await fetch(`/api/islands/${id}`, { method: "DELETE" });
    showToast("Island deleted");
    loadAll();
  };

  // ===================
  // Enemy CRUD
  // ===================
  const saveEnemy = async () => {
    if (!editingEnemy) return;
    const method = editingEnemy.id ? "PUT" : "POST";
    const url = editingEnemy.id ? `/api/enemies/${editingEnemy.id}` : "/api/enemies";
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(editingEnemy),
    });
    if (res.ok) {
      showToast(editingEnemy.id ? "Enemy updated!" : "Enemy created!");
      setEditingEnemy(null);
      loadAll();
    } else {
      showToast("Failed to save enemy", "error");
    }
  };

  const deleteEnemy = async (id: string) => {
    if (!confirm("Delete this enemy?")) return;
    await fetch(`/api/enemies/${id}`, { method: "DELETE" });
    showToast("Enemy deleted");
    loadAll();
  };

  // ===================
  // Ship CRUD
  // ===================
  const saveShip = async () => {
    if (!editingShip) return;
    const method = editingShip.id ? "PUT" : "POST";
    const url = editingShip.id ? `/api/ships/${editingShip.id}` : "/api/ships";
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(editingShip),
    });
    if (res.ok) {
      showToast(editingShip.id ? "Ship updated!" : "Ship created!");
      setEditingShip(null);
      loadAll();
    } else {
      showToast("Failed to save ship", "error");
    }
  };

  // ========== RENDER LOGIC ===========

  if (authLoading) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center">
        <div className="text-cyan-400 animate-pulse font-mono">Checking auth...</div>
      </div>
    );
  }

  if (!authenticated) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center p-4">
        <div className="w-full max-w-sm">
          <div className="text-center mb-8">
            <div className="text-4xl font-bold text-cyan-400 mb-2 tracking-widest" style={{ fontFamily: "serif" }}>
              CAPIXELATE
            </div>
            <div className="text-slate-500 text-sm tracking-widest">ADMIN DASHBOARD</div>
          </div>
          <form onSubmit={handleLogin} className="bg-slate-900 border border-slate-700 rounded-2xl p-6 space-y-4">
            <h2 className="text-lg font-bold text-white text-center">Captain&apos;s Log-In</h2>
            {loginError && (
              <div className="text-red-400 text-sm bg-red-900/20 border border-red-700/30 rounded-lg p-2 text-center">
                {loginError}
              </div>
            )}
            <div>
              <label className="text-xs text-slate-400 uppercase tracking-widest block mb-1">Username</label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2.5 text-white focus:outline-none focus:border-cyan-500 text-sm"
                placeholder="admin"
              />
            </div>
            <div>
              <label className="text-xs text-slate-400 uppercase tracking-widest block mb-1">Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2.5 text-white focus:outline-none focus:border-cyan-500 text-sm"
                placeholder="••••••••"
              />
            </div>
            <button
              type="submit"
              className="w-full py-3 bg-cyan-700 hover:bg-cyan-600 rounded-xl text-white font-bold tracking-widest transition-all"
            >
              BOARD THE SHIP
            </button>
          </form>
          <div className="text-center mt-4 text-xs text-slate-600">
            Default: admin / capixelate2024
          </div>
        </div>
      </div>
    );
  }

  const TABS: { id: TabId; label: string; icon: string }[] = [
    { id: "projects", label: "Projects", icon: "🚀" },
    { id: "islands", label: "Islands", icon: "🏝️" },
    { id: "enemies", label: "Enemies", icon: "💀" },
    { id: "ships", label: "Ships & Models", icon: "⛵" },
    { id: "map", label: "Sea Map", icon: "🗺️" },
  ];

  return (
    <div className="min-h-screen bg-slate-950 text-white">
      {/* Header */}
      <div className="border-b border-slate-800 bg-slate-900/60 backdrop-blur-sm sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="text-xl font-bold text-cyan-400 tracking-widest" style={{ fontFamily: "serif" }}>
              CAPIXELATE
            </div>
            <div className="text-xs text-slate-500 uppercase tracking-widest hidden sm:block">
              Admin Dashboard
            </div>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={handleSeed}
              className="text-xs px-3 py-1.5 bg-purple-900/40 hover:bg-purple-700/40 border border-purple-700/40 rounded-lg text-purple-300 transition-all"
            >
              ✨ Seed Demo Data
            </button>
            <a
              href="/"
              className="text-xs px-3 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-600 rounded-lg text-slate-300 transition-all"
            >
              ⚓ View Game
            </a>
            <button
              onClick={handleLogout}
              className="text-xs px-3 py-1.5 bg-red-900/40 hover:bg-red-700/40 border border-red-700/40 rounded-lg text-red-300 transition-all"
            >
              Log Out
            </button>
          </div>
        </div>
        {/* Tabs */}
        <div className="max-w-7xl mx-auto px-4 flex gap-1 pb-0">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-4 py-2 text-sm font-medium rounded-t-lg transition-all border-b-2 ${
                activeTab === tab.id
                  ? "text-cyan-400 border-cyan-400 bg-cyan-950/30"
                  : "text-slate-400 border-transparent hover:text-slate-200"
              }`}
            >
              {tab.icon} {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Toast */}
      {toast && (
        <div
          className={`fixed top-4 right-4 z-[100] px-4 py-3 rounded-xl text-sm font-medium shadow-xl ${
            toast.type === "success"
              ? "bg-green-900/90 border border-green-500/40 text-green-300"
              : "bg-red-900/90 border border-red-500/40 text-red-300"
          }`}
        >
          {toast.type === "success" ? "✓" : "✗"} {toast.msg}
        </div>
      )}

      <div className="max-w-7xl mx-auto px-4 py-6">
        {loading && (
          <div className="text-center text-slate-500 py-8 animate-pulse">Loading data...</div>
        )}

        {/* ===== PROJECTS TAB ===== */}
        {activeTab === "projects" && (
          <div>
            <div className="flex items-center justify-between mb-6">
              <div>
                <h2 className="text-2xl font-bold text-white">Projects</h2>
                <p className="text-slate-500 text-sm mt-1">Manage your portfolio projects displayed on islands</p>
              </div>
              <button
                onClick={() => setEditingProject({ title: "", description: "", url: "", tags: "[]", order: projects.length, isActive: true })}
                className="px-4 py-2 bg-cyan-700 hover:bg-cyan-600 rounded-xl text-white text-sm font-bold transition-all"
              >
                + Add Project
              </button>
            </div>

            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {projects.map((project) => (
                <div key={project.id} className="bg-slate-900 border border-slate-700 rounded-xl p-4">
                  <div className="flex items-start justify-between mb-2">
                    <h3 className="font-bold text-white text-lg">{project.title}</h3>
                    <span className={`text-xs px-2 py-0.5 rounded-full ${project.isActive ? "bg-green-900/40 text-green-400" : "bg-red-900/40 text-red-400"}`}>
                      {project.isActive ? "Active" : "Hidden"}
                    </span>
                  </div>
                  <p className="text-slate-400 text-sm mb-3 line-clamp-2">{project.description}</p>
                  <a href={project.url} target="_blank" rel="noopener noreferrer" className="text-cyan-400 text-xs hover:underline block mb-2 truncate">
                    {project.url}
                  </a>
                  {project.islandId && (
                    <div className="text-xs text-slate-500 mb-2">
                      🏝️ {islands.find((i) => i.id === project.islandId)?.name ?? "Unknown Island"}
                    </div>
                  )}
                  <div className="flex flex-wrap gap-1 mb-3">
                    {JSON.parse(project.tags || "[]").map((tag: string) => (
                      <span key={tag} className="text-xs px-2 py-0.5 bg-slate-800 text-slate-300 rounded-full border border-slate-600">
                        {tag}
                      </span>
                    ))}
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setEditingProject({ ...project })}
                      className="flex-1 py-1.5 text-xs bg-slate-800 hover:bg-slate-700 rounded-lg text-slate-200 transition-all"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => deleteProject(project.id)}
                      className="px-3 py-1.5 text-xs bg-red-900/40 hover:bg-red-700/40 rounded-lg text-red-300 transition-all"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>

            {/* Project form modal */}
            {editingProject && (
              <ProjectModal
                project={editingProject}
                islands={islands}
                onChange={setEditingProject}
                onSave={saveProject}
                onCancel={() => setEditingProject(null)}
                uploadFile={uploadFile}
              />
            )}
          </div>
        )}

        {/* ===== ISLANDS TAB ===== */}
        {activeTab === "islands" && (
          <div>
            <div className="flex items-center justify-between mb-6">
              <div>
                <h2 className="text-2xl font-bold text-white">Islands</h2>
                <p className="text-slate-500 text-sm mt-1">Place and configure explorable islands in the world</p>
              </div>
              <button
                onClick={() => setEditingIsland({ name: "", posX: 0, posZ: -200, scale: 1, isActive: true })}
                className="px-4 py-2 bg-cyan-700 hover:bg-cyan-600 rounded-xl text-white text-sm font-bold transition-all"
              >
                + Add Island
              </button>
            </div>

            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {islands.map((island) => (
                <div key={island.id} className="bg-slate-900 border border-slate-700 rounded-xl p-4">
                  <div className="flex items-start justify-between mb-2">
                    <h3 className="font-bold text-white text-lg">🏝️ {island.name}</h3>
                    <span className={`text-xs px-2 py-0.5 rounded-full ${island.isActive ? "bg-green-900/40 text-green-400" : "bg-red-900/40 text-red-400"}`}>
                      {island.isActive ? "Active" : "Hidden"}
                    </span>
                  </div>
                  <div className="text-slate-400 text-xs space-y-1 mb-3 font-mono">
                    <div>Position: ({island.posX}, {island.posZ})</div>
                    <div>Scale: {island.scale}x</div>
                    {island.projects && island.projects.length > 0 && (
                      <div className="text-cyan-400">Projects: {island.projects.map((p) => p.title).join(", ")}</div>
                    )}
                    {island.modelUrl && <div className="text-purple-400">Custom model ✓</div>}
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setEditingIsland({ ...island })}
                      className="flex-1 py-1.5 text-xs bg-slate-800 hover:bg-slate-700 rounded-lg text-slate-200 transition-all"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => deleteIsland(island.id)}
                      className="px-3 py-1.5 text-xs bg-red-900/40 hover:bg-red-700/40 rounded-lg text-red-300 transition-all"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>

            {editingIsland && (
              <IslandModal
                island={editingIsland}
                onChange={setEditingIsland}
                onSave={saveIsland}
                onCancel={() => setEditingIsland(null)}
                uploadFile={uploadFile}
              />
            )}
          </div>
        )}

        {/* ===== ENEMIES TAB ===== */}
        {activeTab === "enemies" && (
          <div>
            <div className="flex items-center justify-between mb-6">
              <div>
                <h2 className="text-2xl font-bold text-white">Enemies</h2>
                <p className="text-slate-500 text-sm mt-1">Configure enemy ships, sea monsters, their AI and combat stats</p>
              </div>
              <button
                onClick={() => setEditingEnemy({
                  name: "", type: "ship", hitPoints: 3, cannonAccuracy: 0.5,
                  difficulty: "normal", behavior: "fight", attackMode: "cannon",
                  fleeThreshold: 0.25, lootValue: 100, lootDifficulty: "normal",
                  zoneX: 0, zoneZ: -200, zoneRadius: 200, speed: 1, spawnCount: 1, isActive: true
                })}
                className="px-4 py-2 bg-red-800 hover:bg-red-700 rounded-xl text-white text-sm font-bold transition-all"
              >
                + Add Enemy
              </button>
            </div>

            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {enemies.map((enemy) => (
                <div key={enemy.id} className="bg-slate-900 border border-slate-700 rounded-xl p-4">
                  <div className="flex items-start justify-between mb-2">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-lg">{enemy.type === "monster" ? "🐙" : "☠️"}</span>
                        <h3 className="font-bold text-white">{enemy.name}</h3>
                      </div>
                      <div className="text-xs text-slate-500 capitalize">{enemy.type}</div>
                    </div>
                    <span className={`text-xs px-2 py-0.5 rounded-full border ${DIFFICULTY_COLORS[enemy.difficulty] ?? "text-slate-400"}`}>
                      {enemy.difficulty}
                    </span>
                  </div>

                  <div className="grid grid-cols-2 gap-1 text-xs font-mono text-slate-400 mb-3">
                    <div>HP: <span className="text-white">{enemy.hitPoints * 25}</span></div>
                    <div>Accuracy: <span className="text-white">{Math.round(enemy.cannonAccuracy * 100)}%</span></div>
                    <div>Behavior: <span className="text-white capitalize">{enemy.behavior}</span></div>
                    <div>Attack: <span className="text-white capitalize">{enemy.attackMode}</span></div>
                    <div>Speed: <span className="text-white">{enemy.speed}x</span></div>
                    <div>Loot: <span className="text-yellow-400">{enemy.lootValue}g</span></div>
                    <div>Zone: <span className="text-white">({enemy.zoneX}, {enemy.zoneZ})</span></div>
                    <div>Radius: <span className="text-white">{enemy.zoneRadius}</span></div>
                    <div>Spawns: <span className="text-white">{enemy.spawnCount}</span></div>
                    <div>Flee @: <span className="text-white">{Math.round(enemy.fleeThreshold * 100)}% HP</span></div>
                  </div>

                  {enemy.modelUrl && (
                    <div className="text-xs text-purple-400 mb-2">Custom 3D model ✓</div>
                  )}

                  <div className="flex gap-2">
                    <button
                      onClick={() => setEditingEnemy({ ...enemy })}
                      className="flex-1 py-1.5 text-xs bg-slate-800 hover:bg-slate-700 rounded-lg text-slate-200 transition-all"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => deleteEnemy(enemy.id)}
                      className="px-3 py-1.5 text-xs bg-red-900/40 hover:bg-red-700/40 rounded-lg text-red-300 transition-all"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>

            {editingEnemy && (
              <EnemyModal
                enemy={editingEnemy}
                onChange={setEditingEnemy}
                onSave={saveEnemy}
                onCancel={() => setEditingEnemy(null)}
                uploadFile={uploadFile}
              />
            )}
          </div>
        )}

        {/* ===== SHIPS TAB ===== */}
        {activeTab === "ships" && (
          <div>
            <div className="flex items-center justify-between mb-6">
              <div>
                <h2 className="text-2xl font-bold text-white">Ships & 3D Models</h2>
                <p className="text-slate-500 text-sm mt-1">Upload custom 3D models for ships and vessels (.glb, .gltf)</p>
              </div>
              <button
                onClick={() => setEditingShip({ name: "", type: "player", isActive: true })}
                className="px-4 py-2 bg-cyan-700 hover:bg-cyan-600 rounded-xl text-white text-sm font-bold transition-all"
              >
                + Add Ship
              </button>
            </div>

            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {ships.map((ship) => (
                <div key={ship.id} className="bg-slate-900 border border-slate-700 rounded-xl p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-2xl">⛵</span>
                    <div>
                      <h3 className="font-bold text-white">{ship.name}</h3>
                      <div className="text-xs text-slate-500 capitalize">{ship.type}</div>
                    </div>
                  </div>
                  {ship.modelUrl ? (
                    <div className="text-xs text-purple-400 mb-3">✓ Custom 3D model loaded</div>
                  ) : (
                    <div className="text-xs text-slate-600 mb-3">Using default procedural model</div>
                  )}
                  <button
                    onClick={() => setEditingShip({ ...ship })}
                    className="w-full py-1.5 text-xs bg-slate-800 hover:bg-slate-700 rounded-lg text-slate-200 transition-all"
                  >
                    Edit / Upload Model
                  </button>
                </div>
              ))}
            </div>

            {editingShip && (
              <ShipModal
                ship={editingShip}
                onChange={setEditingShip}
                onSave={saveShip}
                onCancel={() => setEditingShip(null)}
                uploadFile={uploadFile}
              />
            )}
          </div>
        )}

        {/* ===== MAP TAB ===== */}
        {activeTab === "map" && (
          <div>
            <div className="mb-6">
              <h2 className="text-2xl font-bold text-white">Sea Map Overview</h2>
              <p className="text-slate-500 text-sm mt-1">Visual overview of the game world — islands, enemy zones, and player start</p>
            </div>
            <div className="flex gap-6 flex-col lg:flex-row">
              <div className="bg-slate-900 border border-slate-700 rounded-xl overflow-hidden">
                <canvas
                  ref={mapCanvasRef}
                  width={600}
                  height={500}
                  className="block"
                  style={{ imageRendering: "crisp-edges" }}
                />
              </div>
              <div className="flex-1 space-y-3">
                <div className="bg-slate-900 border border-slate-700 rounded-xl p-4">
                  <h3 className="font-bold text-white mb-3">Legend</h3>
                  <div className="space-y-2 text-sm">
                    <div className="flex items-center gap-2">
                      <div className="w-3 h-3 rounded-full bg-cyan-400" />
                      <span className="text-slate-300">Player Start</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="w-3 h-3 rounded bg-green-500" />
                      <span className="text-slate-300">Island</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="w-3 h-3 rounded-full bg-red-500" />
                      <span className="text-slate-300">Enemy Ship Zone</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="w-3 h-3 rounded-full bg-purple-500" />
                      <span className="text-slate-300">Sea Monster Zone</span>
                    </div>
                  </div>
                </div>
                <div className="bg-slate-900 border border-slate-700 rounded-xl p-4">
                  <h3 className="font-bold text-white mb-3">World Stats</h3>
                  <div className="space-y-1 text-sm font-mono text-slate-400">
                    <div>Islands: <span className="text-green-400">{islands.filter((i) => i.isActive).length}</span></div>
                    <div>Enemy Ships: <span className="text-red-400">{enemies.filter((e) => e.type === "ship" && e.isActive).length}</span></div>
                    <div>Sea Monsters: <span className="text-purple-400">{enemies.filter((e) => e.type === "monster" && e.isActive).length}</span></div>
                    <div>Projects: <span className="text-cyan-400">{projects.filter((p) => p.isActive).length}</span></div>
                    <div>World Size: <span className="text-white">2000 × 2000</span></div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ===== MODALS =====

function ModalWrapper({ title, onSave, onCancel, children }: {
  title: string;
  onSave: () => void;
  onCancel: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/70 backdrop-blur-sm overflow-y-auto p-4">
      <div className="bg-slate-900 border border-slate-600 rounded-2xl w-full max-w-2xl my-4">
        <div className="flex items-center justify-between p-5 border-b border-slate-700">
          <h3 className="text-lg font-bold text-white">{title}</h3>
          <button onClick={onCancel} className="text-slate-400 hover:text-white text-xl">✕</button>
        </div>
        <div className="p-5 space-y-4">{children}</div>
        <div className="flex gap-3 p-5 border-t border-slate-700">
          <button onClick={onSave} className="flex-1 py-3 bg-cyan-700 hover:bg-cyan-600 rounded-xl text-white font-bold transition-all">
            Save
          </button>
          <button onClick={onCancel} className="px-6 py-3 bg-slate-800 hover:bg-slate-700 rounded-xl text-slate-300 transition-all">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function FormField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-xs text-slate-400 uppercase tracking-widest block mb-1.5">{label}</label>
      {children}
    </div>
  );
}

const inputCls = "w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2.5 text-white focus:outline-none focus:border-cyan-500 text-sm";
const selectCls = "w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2.5 text-white focus:outline-none focus:border-cyan-500 text-sm";

function FileUploadField({ label, category, currentUrl, onUpload }: {
  label: string;
  category: string;
  currentUrl?: string;
  onUpload: (url: string) => void;
}) {
  const [uploading, setUploading] = useState(false);

  const handleChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("category", category);
      const res = await fetch("/api/upload", { method: "POST", body: fd });
      const data = await res.json();
      if (data.url) onUpload(data.url);
    } catch {
      // ignore
    } finally {
      setUploading(false);
    }
  };

  return (
    <FormField label={label}>
      <div className="space-y-2">
        <input type="file" onChange={handleChange} className="block text-sm text-slate-400 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-bold file:bg-slate-700 file:text-slate-200 hover:file:bg-slate-600 cursor-pointer" />
        {uploading && <div className="text-xs text-cyan-400 animate-pulse">Uploading...</div>}
        {currentUrl && <div className="text-xs text-purple-400 truncate">✓ {currentUrl}</div>}
      </div>
    </FormField>
  );
}

function ProjectModal({ project, islands, onChange, onSave, onCancel, uploadFile }: {
  project: Partial<Project>;
  islands: Island[];
  onChange: (p: Partial<Project>) => void;
  onSave: () => void;
  onCancel: () => void;
  uploadFile: (f: File, c: string) => Promise<string>;
}) {
  void uploadFile;
  return (
    <ModalWrapper title={project.id ? "Edit Project" : "Add Project"} onSave={onSave} onCancel={onCancel}>
      <div className="grid grid-cols-2 gap-4">
        <div className="col-span-2">
          <FormField label="Title">
            <input className={inputCls} value={project.title ?? ""} onChange={(e) => onChange({ ...project, title: e.target.value })} placeholder="My Awesome App" />
          </FormField>
        </div>
        <div className="col-span-2">
          <FormField label="Description">
            <textarea className={`${inputCls} h-20 resize-none`} value={project.description ?? ""} onChange={(e) => onChange({ ...project, description: e.target.value })} placeholder="Describe your project..." />
          </FormField>
        </div>
        <div className="col-span-2">
          <FormField label="URL">
            <input className={inputCls} value={project.url ?? ""} onChange={(e) => onChange({ ...project, url: e.target.value })} placeholder="https://myproject.com" />
          </FormField>
        </div>
        <div>
          <FormField label="Assign to Island">
            <select className={selectCls} value={project.islandId ?? ""} onChange={(e) => onChange({ ...project, islandId: e.target.value || undefined })}>
              <option value="">— No Island —</option>
              {islands.map((i) => (
                <option key={i.id} value={i.id}>{i.name}</option>
              ))}
            </select>
          </FormField>
        </div>
        <div>
          <FormField label="Order">
            <input type="number" className={inputCls} value={project.order ?? 0} onChange={(e) => onChange({ ...project, order: Number(e.target.value) })} />
          </FormField>
        </div>
        <div className="col-span-2">
          <FormField label="Tags (comma separated)">
            <input className={inputCls} value={(() => { try { return JSON.parse(project.tags ?? "[]").join(", "); } catch { return ""; } })()} onChange={(e) => onChange({ ...project, tags: JSON.stringify(e.target.value.split(",").map((t) => t.trim()).filter(Boolean)) })} placeholder="React, Node.js, TypeScript" />
          </FormField>
        </div>
        <div>
          <FileUploadField
            label="Project Image"
            category="images"
            currentUrl={project.imageUrl}
            onUpload={(url) => onChange({ ...project, imageUrl: url })}
          />
        </div>
        <div>
          <FileUploadField
            label="Portal Icon"
            category="icons"
            currentUrl={project.iconUrl}
            onUpload={(url) => onChange({ ...project, iconUrl: url })}
          />
        </div>
        <div>
          <FormField label="Status">
            <select className={selectCls} value={project.isActive ? "active" : "hidden"} onChange={(e) => onChange({ ...project, isActive: e.target.value === "active" })}>
              <option value="active">Active (Visible)</option>
              <option value="hidden">Hidden</option>
            </select>
          </FormField>
        </div>
      </div>
    </ModalWrapper>
  );
}

function IslandModal({ island, onChange, onSave, onCancel, uploadFile }: {
  island: Partial<Island>;
  onChange: (i: Partial<Island>) => void;
  onSave: () => void;
  onCancel: () => void;
  uploadFile: (f: File, c: string) => Promise<string>;
}) {
  void uploadFile;
  return (
    <ModalWrapper title={island.id ? "Edit Island" : "Add Island"} onSave={onSave} onCancel={onCancel}>
      <div className="grid grid-cols-2 gap-4">
        <div className="col-span-2">
          <FormField label="Island Name">
            <input className={inputCls} value={island.name ?? ""} onChange={(e) => onChange({ ...island, name: e.target.value })} placeholder="Treasure Cove" />
          </FormField>
        </div>
        <FormField label="Position X (East/West)">
          <input type="number" className={inputCls} value={island.posX ?? 0} onChange={(e) => onChange({ ...island, posX: Number(e.target.value) })} />
        </FormField>
        <FormField label="Position Z (North/South)">
          <input type="number" className={inputCls} value={island.posZ ?? -200} onChange={(e) => onChange({ ...island, posZ: Number(e.target.value) })} />
        </FormField>
        <FormField label="Scale">
          <input type="number" step="0.1" min="0.3" max="3" className={inputCls} value={island.scale ?? 1} onChange={(e) => onChange({ ...island, scale: Number(e.target.value) })} />
        </FormField>
        <FormField label="Status">
          <select className={selectCls} value={island.isActive ? "active" : "hidden"} onChange={(e) => onChange({ ...island, isActive: e.target.value === "active" })}>
            <option value="active">Active (Visible)</option>
            <option value="hidden">Hidden</option>
          </select>
        </FormField>
        <div className="col-span-2">
          <FileUploadField
            label="Custom 3D Island Model (.glb/.gltf)"
            category="models/islands"
            currentUrl={island.modelUrl}
            onUpload={(url) => onChange({ ...island, modelUrl: url })}
          />
        </div>
      </div>
    </ModalWrapper>
  );
}

function EnemyModal({ enemy, onChange, onSave, onCancel, uploadFile }: {
  enemy: Partial<Enemy>;
  onChange: (e: Partial<Enemy>) => void;
  onSave: () => void;
  onCancel: () => void;
  uploadFile: (f: File, c: string) => Promise<string>;
}) {
  void uploadFile;
  return (
    <ModalWrapper title={enemy.id ? "Edit Enemy" : "Add Enemy"} onSave={onSave} onCancel={onCancel}>
      <div className="grid grid-cols-2 gap-4">
        <FormField label="Name">
          <input className={inputCls} value={enemy.name ?? ""} onChange={(e) => onChange({ ...enemy, name: e.target.value })} placeholder="Dread Pirate" />
        </FormField>
        <FormField label="Type">
          <select className={selectCls} value={enemy.type ?? "ship"} onChange={(e) => onChange({ ...enemy, type: e.target.value })}>
            <option value="ship">Ship</option>
            <option value="monster">Sea Monster</option>
          </select>
        </FormField>
        <FormField label="Hit Points (×25 HP each)">
          <input type="number" min="1" max="20" className={inputCls} value={enemy.hitPoints ?? 3} onChange={(e) => onChange({ ...enemy, hitPoints: Number(e.target.value) })} />
        </FormField>
        <FormField label="Cannon Accuracy (0–1)">
          <input type="number" step="0.05" min="0" max="1" className={inputCls} value={enemy.cannonAccuracy ?? 0.5} onChange={(e) => onChange({ ...enemy, cannonAccuracy: Number(e.target.value) })} />
        </FormField>
        <FormField label="Difficulty">
          <select className={selectCls} value={enemy.difficulty ?? "normal"} onChange={(e) => onChange({ ...enemy, difficulty: e.target.value })}>
            <option value="easy">Easy</option>
            <option value="normal">Normal</option>
            <option value="hard">Hard</option>
            <option value="legendary">Legendary</option>
          </select>
        </FormField>
        <FormField label="Behavior">
          <select className={selectCls} value={enemy.behavior ?? "fight"} onChange={(e) => onChange({ ...enemy, behavior: e.target.value })}>
            <option value="fight">Fight to the Death</option>
            <option value="flee">Flee Immediately</option>
            <option value="fleeBeforeSink">Flee Before Sinking</option>
          </select>
        </FormField>
        <FormField label="Attack Mode">
          <select className={selectCls} value={enemy.attackMode ?? "cannon"} onChange={(e) => onChange({ ...enemy, attackMode: e.target.value })}>
            <option value="cannon">Cannon Fire</option>
            <option value="ram">Ramming</option>
            <option value="tentacle">Tentacle (Monster)</option>
            <option value="bite">Bite (Monster)</option>
            <option value="charge">Charge Attack</option>
          </select>
        </FormField>
        <FormField label="Flee Threshold (HP %)">
          <input type="number" step="0.05" min="0" max="1" className={inputCls} value={enemy.fleeThreshold ?? 0.25} onChange={(e) => onChange({ ...enemy, fleeThreshold: Number(e.target.value) })} />
        </FormField>
        <FormField label="Loot Value (gold)">
          <input type="number" min="0" className={inputCls} value={enemy.lootValue ?? 100} onChange={(e) => onChange({ ...enemy, lootValue: Number(e.target.value) })} />
        </FormField>
        <FormField label="Loot Difficulty">
          <select className={selectCls} value={enemy.lootDifficulty ?? "normal"} onChange={(e) => onChange({ ...enemy, lootDifficulty: e.target.value })}>
            <option value="easy">Easy to Loot</option>
            <option value="normal">Normal</option>
            <option value="hard">Hard to Loot</option>
            <option value="legendary">Legendary Haul</option>
          </select>
        </FormField>
        <FormField label="Speed Multiplier">
          <input type="number" step="0.1" min="0.1" max="3" className={inputCls} value={enemy.speed ?? 1} onChange={(e) => onChange({ ...enemy, speed: Number(e.target.value) })} />
        </FormField>
        <FormField label="Spawn Count">
          <input type="number" min="1" max="10" className={inputCls} value={enemy.spawnCount ?? 1} onChange={(e) => onChange({ ...enemy, spawnCount: Number(e.target.value) })} />
        </FormField>
        <FormField label="Zone Center X">
          <input type="number" className={inputCls} value={enemy.zoneX ?? 0} onChange={(e) => onChange({ ...enemy, zoneX: Number(e.target.value) })} />
        </FormField>
        <FormField label="Zone Center Z">
          <input type="number" className={inputCls} value={enemy.zoneZ ?? -200} onChange={(e) => onChange({ ...enemy, zoneZ: Number(e.target.value) })} />
        </FormField>
        <div className="col-span-2">
          <FormField label="Zone Patrol Radius">
            <input type="number" min="50" max="600" className={inputCls} value={enemy.zoneRadius ?? 200} onChange={(e) => onChange({ ...enemy, zoneRadius: Number(e.target.value) })} />
          </FormField>
        </div>
        <div className="col-span-2">
          <FileUploadField
            label="Custom 3D Model (.glb/.gltf)"
            category="models/enemies"
            currentUrl={enemy.modelUrl}
            onUpload={(url) => onChange({ ...enemy, modelUrl: url })}
          />
        </div>
        <div className="col-span-2">
          <FileUploadField
            label="Loot Image (shown when looted)"
            category="images/loot"
            currentUrl={enemy.lootImageUrl}
            onUpload={(url) => onChange({ ...enemy, lootImageUrl: url })}
          />
        </div>
      </div>
    </ModalWrapper>
  );
}

function ShipModal({ ship, onChange, onSave, onCancel, uploadFile }: {
  ship: Partial<Ship>;
  onChange: (s: Partial<Ship>) => void;
  onSave: () => void;
  onCancel: () => void;
  uploadFile: (f: File, c: string) => Promise<string>;
}) {
  void uploadFile;
  return (
    <ModalWrapper title={ship.id ? "Edit Ship" : "Add Ship"} onSave={onSave} onCancel={onCancel}>
      <div className="grid grid-cols-2 gap-4">
        <FormField label="Ship Name">
          <input className={inputCls} value={ship.name ?? ""} onChange={(e) => onChange({ ...ship, name: e.target.value })} placeholder="The Black Pearl" />
        </FormField>
        <FormField label="Ship Type">
          <select className={selectCls} value={ship.type ?? "player"} onChange={(e) => onChange({ ...ship, type: e.target.value })}>
            <option value="player">Player Ship</option>
            <option value="ally">Ally Ship</option>
            <option value="merchant">Merchant Ship</option>
            <option value="ghost">Ghost Ship</option>
          </select>
        </FormField>
        <div className="col-span-2">
          <FileUploadField
            label="Custom 3D Ship Model (.glb/.gltf)"
            category="models/ships"
            currentUrl={ship.modelUrl}
            onUpload={(url) => onChange({ ...ship, modelUrl: url })}
          />
          <p className="text-xs text-slate-500 mt-2">
            Upload a .glb or .gltf file. The model will automatically replace the procedural ship in-game.
            Recommended scale: ~10 units long. Forward direction should face +Z axis.
          </p>
        </div>
      </div>
    </ModalWrapper>
  );
}
