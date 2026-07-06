"use client";
import { useState, useEffect } from "react";
import type { GameState, IslandState } from "@/lib/game/types";

interface GameHUDProps {
  hudState: Partial<GameState>;
  nearbyIsland: IslandState | null;
  onSailToIsland: () => void;
  onPortalClick: () => void;
  activeProject: { title: string; description: string; url: string } | null;
  onCloseProject: () => void;
}

export default function GameHUD({
  hudState,
  nearbyIsland,
  onSailToIsland,
  onPortalClick,
  activeProject,
  onCloseProject,
}: GameHUDProps) {
  const [showControls, setShowControls] = useState(true);
  const [mapZoom] = useState(1);

  const health = hudState.playerHealth ?? 100;
  const maxHealth = hudState.playerMaxHealth ?? 100;
  const healthPct = Math.max(0, (health / maxHealth) * 100);
  const cannonBalls = hudState.playerCannonBalls ?? 40;
  const gold = hudState.playerGold ?? 0;
  const speed = Math.abs(hudState.playerSpeed ?? 0);
  const pos = hudState.playerPosition ?? { x: 0, z: 0 };
  const fogOfWar = hudState.fogOfWar ?? new Map();
  const enemies = hudState.enemies ?? [];
  const phase = hudState.gamePhase ?? "sailing";

  // Minimap: 200x200 px, world scale factor
  const MAP_SIZE = 180;
  const WORLD_SCALE = MAP_SIZE / 600;

  const worldToMap = (x: number, z: number) => ({
    mx: MAP_SIZE / 2 + (x - pos.x) * WORLD_SCALE,
    mz: MAP_SIZE / 2 + (z - pos.z) * WORLD_SCALE,
  });

  return (
    <>
      {/* === TOP HUD BAR === */}
      <div className="absolute top-0 left-0 right-0 pointer-events-none z-10">
        <div className="flex items-start justify-between p-3 gap-3">
          {/* Health bar */}
          <div className="pointer-events-auto bg-black/60 backdrop-blur-sm border border-cyan-900/50 rounded-xl p-3 min-w-[220px]">
            <div className="text-xs text-cyan-400/80 uppercase tracking-widest mb-1.5 font-mono">Hull Integrity</div>
            <div className="w-full h-3 bg-slate-900 rounded-full overflow-hidden border border-slate-700">
              <div
                className="h-full rounded-full transition-all duration-300"
                style={{
                  width: `${healthPct}%`,
                  background: healthPct > 50
                    ? "linear-gradient(90deg, #16a34a, #22c55e)"
                    : healthPct > 25
                    ? "linear-gradient(90deg, #b45309, #f59e0b)"
                    : "linear-gradient(90deg, #991b1b, #ef4444)",
                  boxShadow: `0 0 8px ${healthPct > 50 ? "#22c55e" : healthPct > 25 ? "#f59e0b" : "#ef4444"}66`,
                }}
              />
            </div>
            <div className="text-xs text-slate-400 mt-1 font-mono">{Math.round(health)}/{maxHealth}</div>
          </div>

          {/* Site title */}
          <div className="pointer-events-auto text-center">
            <div
              className="text-3xl font-bold tracking-[0.3em] text-cyan-300"
              style={{ fontFamily: "serif", textShadow: "0 0 20px #00ffcc88, 0 0 40px #00ffcc44" }}
            >
              CAPIXELATE
            </div>
            <div className="text-xs text-slate-500 tracking-widest">PORTFOLIO WATERS</div>
          </div>

          {/* Resources */}
          <div className="pointer-events-auto bg-black/60 backdrop-blur-sm border border-cyan-900/50 rounded-xl p-3 min-w-[180px]">
            <div className="flex items-center gap-3 text-sm font-mono">
              <div className="flex items-center gap-1.5">
                <span className="text-slate-400">⚓</span>
                <span className="text-white">{Math.round(speed * 10) / 10}</span>
                <span className="text-slate-500 text-xs">kn</span>
              </div>
              <div className="w-px h-4 bg-slate-700" />
              <div className="flex items-center gap-1.5">
                <span className="text-orange-400">💣</span>
                <span className="text-white">{cannonBalls}</span>
              </div>
              <div className="w-px h-4 bg-slate-700" />
              <div className="flex items-center gap-1.5">
                <span className="text-yellow-400">🪙</span>
                <span className="text-yellow-300 font-bold">{gold}</span>
              </div>
            </div>
            <div className="text-xs text-slate-600 mt-1 font-mono">
              {Math.round(pos.x)}, {Math.round(pos.z)}
            </div>
          </div>
        </div>
      </div>

      {/* === MINIMAP (bottom-right) === */}
      <div className="absolute bottom-4 right-4 z-10 pointer-events-none">
        <div className="bg-black/70 backdrop-blur-sm border border-cyan-900/60 rounded-xl overflow-hidden"
          style={{ width: MAP_SIZE + 16, height: MAP_SIZE + 36 }}>
          <div className="text-[10px] text-cyan-500/70 uppercase tracking-widest px-2 py-1 font-mono border-b border-cyan-900/30">
            Sea Chart
          </div>
          <div className="relative" style={{ width: MAP_SIZE, height: MAP_SIZE }}>
            {/* Ocean background */}
            <div className="absolute inset-0 bg-slate-900/90" />

            {/* Fog of war — undiscovered tiles dark */}
            <div className="absolute inset-0 pointer-events-none">
              {Array.from(fogOfWar.entries()).map(([key]) => {
                const [tx, tz] = key.split(",").map(Number);
                const rx = MAP_SIZE / 2 + (tx * 100 - pos.x) * WORLD_SCALE;
                const rz = MAP_SIZE / 2 + (tz * 100 - pos.z) * WORLD_SCALE;
                return (
                  <div
                    key={key}
                    className="absolute bg-cyan-900/20"
                    style={{
                      left: rx,
                      top: rz,
                      width: 100 * WORLD_SCALE,
                      height: 100 * WORLD_SCALE,
                    }}
                  />
                );
              })}
            </div>

            {/* Enemy dots */}
            {enemies
              .filter((e) => e.state !== "dead")
              .map((enemy) => {
                const { mx, mz } = worldToMap(enemy.position.x, enemy.position.z);
                if (mx < 0 || mx > MAP_SIZE || mz < 0 || mz > MAP_SIZE) return null;
                return (
                  <div
                    key={enemy.id}
                    className="absolute w-2 h-2 rounded-full -translate-x-1 -translate-y-1"
                    style={{
                      left: mx,
                      top: mz,
                      background: enemy.type === "monster" ? "#a855f7" : "#ef4444",
                      boxShadow: `0 0 4px ${enemy.type === "monster" ? "#a855f7" : "#ef4444"}`,
                    }}
                  />
                );
              })}

            {/* Player dot */}
            <div
              className="absolute w-3 h-3 rounded-full -translate-x-1.5 -translate-y-1.5 z-10"
              style={{
                left: MAP_SIZE / 2,
                top: MAP_SIZE / 2,
                background: "#22d3ee",
                boxShadow: "0 0 8px #22d3ee",
              }}
            />

            {/* Island markers */}
            {hudState.islands?.map((isl) => {
              const { mx, mz } = worldToMap(isl.position.x, isl.position.z);
              if (mx < 0 || mx > MAP_SIZE || mz < 0 || mz > MAP_SIZE) return null;
              return (
                <div
                  key={isl.id}
                  className="absolute w-3 h-3 rounded-sm -translate-x-1.5 -translate-y-1.5"
                  style={{
                    left: mx,
                    top: mz,
                    background: "#22c55e",
                    boxShadow: "0 0 6px #22c55e88",
                  }}
                />
              );
            })}

            {/* Border overlay */}
            <div className="absolute inset-0 rounded-none"
              style={{ boxShadow: "inset 0 0 20px rgba(0,0,0,0.7)" }} />
          </div>
        </div>
      </div>

      {/* === CONTROLS (bottom-left) === */}
      <div className="absolute bottom-4 left-4 z-10">
        <button
          onClick={() => setShowControls(!showControls)}
          className="text-xs text-slate-500 hover:text-cyan-400 transition-colors mb-2 block font-mono tracking-wide"
        >
          {showControls ? "▼ Hide Controls" : "▲ Show Controls"}
        </button>
        {showControls && (
          <div className="bg-black/60 backdrop-blur-sm border border-cyan-900/50 rounded-xl p-3 text-xs font-mono text-slate-400 space-y-1">
            <div className="text-cyan-400/80 text-[10px] uppercase tracking-widest mb-2">Controls</div>
            <div className="flex items-center gap-2">
              <kbd className="bg-slate-800 border border-slate-600 px-1.5 py-0.5 rounded text-[10px] text-white">W</kbd>
              <kbd className="bg-slate-800 border border-slate-600 px-1.5 py-0.5 rounded text-[10px] text-white">↑</kbd>
              <span>Sail Forward</span>
            </div>
            <div className="flex items-center gap-2">
              <kbd className="bg-slate-800 border border-slate-600 px-1.5 py-0.5 rounded text-[10px] text-white">S</kbd>
              <kbd className="bg-slate-800 border border-slate-600 px-1.5 py-0.5 rounded text-[10px] text-white">↓</kbd>
              <span>Reverse</span>
            </div>
            <div className="flex items-center gap-2">
              <kbd className="bg-slate-800 border border-slate-600 px-1.5 py-0.5 rounded text-[10px] text-white">A</kbd>
              <kbd className="bg-slate-800 border border-slate-600 px-1.5 py-0.5 rounded text-[10px] text-white">D</kbd>
              <span>Steer</span>
            </div>
            <div className="flex items-center gap-2">
              <kbd className="bg-slate-800 border border-slate-600 px-2 py-0.5 rounded text-[10px] text-white">Space</kbd>
              <span>Fire Cannons</span>
            </div>
          </div>
        )}
      </div>

      {/* === SAIL TO ISLAND BUTTON === */}
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10">
        <button
          onClick={onSailToIsland}
          className="px-6 py-3 bg-cyan-900/60 hover:bg-cyan-700/70 border border-cyan-400/40 hover:border-cyan-400/80 rounded-xl text-cyan-300 text-sm font-bold tracking-widest transition-all duration-200 backdrop-blur-sm"
          style={{ textShadow: "0 0 10px #00ffcc88" }}
        >
          ⚓ SAIL TO NEAREST ISLAND
        </button>
      </div>

      {/* === NEARBY ISLAND PORTAL === */}
      {nearbyIsland && (
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-20 pointer-events-auto">
          <div
            className="bg-black/80 backdrop-blur-md border rounded-2xl p-6 max-w-sm text-center animate-pulse-slow"
            style={{ borderColor: "#00ffcc66", boxShadow: "0 0 40px #00ffcc33" }}
          >
            <div className="text-4xl mb-3">🏝️</div>
            <div className="text-xl font-bold text-cyan-300 mb-1"
              style={{ fontFamily: "serif" }}>
              {nearbyIsland.name}
            </div>
            {nearbyIsland.projectTitle && (
              <div className="text-slate-300 text-sm mb-4">
                {nearbyIsland.projectDescription}
              </div>
            )}
            {nearbyIsland.projectUrl ? (
              <button
                onClick={onPortalClick}
                className="px-6 py-2.5 bg-cyan-600 hover:bg-cyan-500 rounded-xl text-white font-bold text-sm transition-all"
                style={{ boxShadow: "0 0 20px #00ffcc44" }}
              >
                🌀 Enter Portal → {nearbyIsland.projectTitle}
              </button>
            ) : (
              <div className="text-slate-500 text-sm italic">
                This island awaits a project...
              </div>
            )}
          </div>
        </div>
      )}

      {/* === LOOT MESSAGES === */}
      <div className="absolute top-24 left-1/2 -translate-x-1/2 z-20 pointer-events-none flex flex-col items-center gap-2">
        {(hudState.lootMessages ?? []).map((msg) => (
          <div
            key={msg.id}
            className="text-yellow-300 font-bold text-lg font-mono tracking-wide px-4 py-2 bg-black/40 rounded-lg"
            style={{
              opacity: msg.opacity,
              textShadow: "0 0 10px #fbbf24",
              transform: `translateY(-${(1 - msg.opacity) * 30}px)`,
              transition: "none",
            }}
          >
            {msg.message}
          </div>
        ))}
      </div>

      {/* === GAME OVER === */}
      {phase === "dead" && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm">
          <div className="text-center">
            <div className="text-6xl mb-4">💀</div>
            <div className="text-4xl font-bold text-red-400 mb-4"
              style={{ fontFamily: "serif", textShadow: "0 0 20px #ef4444" }}>
              SHIP SUNK
            </div>
            <div className="text-slate-400 mb-6">
              Gold collected: <span className="text-yellow-400 font-bold">{gold}</span>
            </div>
            <button
              onClick={() => window.location.reload()}
              className="px-8 py-3 bg-red-900/60 hover:bg-red-700/60 border border-red-400/40 rounded-xl text-red-300 font-bold tracking-widest"
            >
              SAIL AGAIN
            </button>
          </div>
        </div>
      )}

      {/* === ACTIVE PROJECT MODAL === */}
      {activeProject && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
          <div className="bg-slate-900 border border-cyan-500/40 rounded-2xl p-8 max-w-lg w-full mx-4"
            style={{ boxShadow: "0 0 60px #00ffcc22" }}>
            <h2 className="text-2xl font-bold text-cyan-300 mb-3">{activeProject.title}</h2>
            <p className="text-slate-300 mb-6">{activeProject.description}</p>
            <div className="flex gap-3">
              <a
                href={activeProject.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex-1 py-3 bg-cyan-600 hover:bg-cyan-500 rounded-xl text-white font-bold text-center transition-all"
              >
                Visit Project
              </a>
              <button
                onClick={onCloseProject}
                className="px-4 py-3 bg-slate-800 hover:bg-slate-700 rounded-xl text-slate-300 transition-all"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
