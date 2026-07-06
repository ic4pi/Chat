"use client";
import { useEffect, useRef, useState, useCallback } from "react";
import { GameEngine } from "@/lib/game/engine";
import type { GameState, IslandState } from "@/lib/game/types";
import GameHUD from "./GameHUD";

interface ProjectData {
  id: string;
  title: string;
  description: string;
  url: string;
  iconUrl?: string;
}

interface IslandData {
  id: string;
  name: string;
  posX: number;
  posZ: number;
  scale: number;
  projects: ProjectData[];
}

interface EnemyData {
  id: string;
  name: string;
  type: string;
  hitPoints: number;
  cannonAccuracy: number;
  difficulty: string;
  behavior: string;
  attackMode: string;
  fleeThreshold: number;
  lootValue: number;
  zoneX: number;
  zoneZ: number;
  zoneRadius: number;
  speed: number;
}

export default function GameCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<GameEngine | null>(null);
  const [hudState, setHudState] = useState<Partial<GameState>>({
    playerHealth: 100,
    playerMaxHealth: 100,
    playerCannonBalls: 40,
    playerGold: 0,
    playerSpeed: 0,
    playerPosition: { x: 0, z: 0 },
    lootMessages: [],
    fogOfWar: new Map(),
    gamePhase: "sailing",
    enemies: [],
  });
  const [nearbyIsland, setNearbyIsland] = useState<IslandState | null>(null);
  const [showPortal, setShowPortal] = useState(false);
  const [activeProject, setActiveProject] = useState<{
    title: string;
    description: string;
    url: string;
  } | null>(null);
  const [loading, setLoading] = useState(true);

  const handleIslandProximity = useCallback((island: IslandState) => {
    setNearbyIsland(island);
  }, []);

  const handleSailToIsland = useCallback(() => {
    engineRef.current?.fireSailToIsland();
  }, []);

  const handlePortalClick = useCallback(() => {
    if (nearbyIsland?.projectUrl) {
      window.open(nearbyIsland.projectUrl, "_blank");
    }
  }, [nearbyIsland]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let engine: GameEngine;

    const startGame = async () => {
      try {
        const [islandsRes, enemiesRes] = await Promise.all([
          fetch("/api/islands"),
          fetch("/api/enemies"),
        ]);
        const islandsJson: { islands: IslandData[] } = await islandsRes.json();
        const enemiesJson: { enemies: EnemyData[] } = await enemiesRes.json();

        const islandsData: IslandState[] = (islandsJson.islands || []).map(
          (isl: IslandData) => ({
            id: isl.id,
            name: isl.name,
            position: { x: isl.posX, z: isl.posZ },
            scale: isl.scale,
            projectUrl: isl.projects?.[0]?.url,
            projectTitle: isl.projects?.[0]?.title,
            projectDescription: isl.projects?.[0]?.description,
            projectIconUrl: isl.projects?.[0]?.iconUrl,
            isDiscovered: false,
          })
        );

        const enemiesData = (enemiesJson.enemies || []).map((en: EnemyData) => ({
          id: en.id,
          name: en.name,
          type: en.type as "ship" | "monster",
          position: { x: en.zoneX + (Math.random() - 0.5) * en.zoneRadius, z: en.zoneZ + (Math.random() - 0.5) * en.zoneRadius },
          rotation: Math.random() * Math.PI * 2,
          health: en.hitPoints * 25,
          maxHealth: en.hitPoints * 25,
          state: "patrol" as const,
          behavior: en.behavior as "fight" | "flee" | "fleeBeforeSink",
          speed: en.speed,
          cannonAccuracy: en.cannonAccuracy,
          attackCooldown: 0,
          zoneX: en.zoneX,
          zoneZ: en.zoneZ,
          zoneRadius: en.zoneRadius,
          fleeThreshold: en.fleeThreshold,
          lootValue: en.lootValue,
          attackMode: en.attackMode,
        }));

        engine = new GameEngine(canvas);
        engine.onStateUpdate = (state) => setHudState((prev) => ({ ...prev, ...state }));
        engine.onIslandProximity = handleIslandProximity;
        engineRef.current = engine;

        await engine.init(islandsData, enemiesData);
        setLoading(false);
      } catch (err) {
        console.error("Game init error:", err);
        // Start with defaults if API fails
        engine = new GameEngine(canvas);
        engine.onStateUpdate = (state) => setHudState((prev) => ({ ...prev, ...state }));
        engine.onIslandProximity = handleIslandProximity;
        engineRef.current = engine;

        const defaultIslands: IslandState[] = [
          {
            id: "main",
            name: "Portfolio Island",
            position: { x: 0, z: -180 },
            scale: 1.2,
            projectUrl: undefined,
            projectTitle: "Explore Projects",
            projectDescription: "Visit this island to see projects",
            isDiscovered: false,
          },
          {
            id: "island2",
            name: "Discovery Isle",
            position: { x: 300, z: -250 },
            scale: 0.9,
            isDiscovered: false,
          },
          {
            id: "island3",
            name: "Treasure Cove",
            position: { x: -280, z: -310 },
            scale: 1.0,
            isDiscovered: false,
          },
        ];

        await engine.init(defaultIslands, []);
        setLoading(false);
      }
    };

    startGame();

    const handleResize = () => {
      engineRef.current?.onResize();
    };
    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      engine?.destroy();
    };
  }, [handleIslandProximity]);

  // Clear nearby island when moving away
  useEffect(() => {
    const interval = setInterval(() => {
      setNearbyIsland((prev) => {
        if (!prev || !engineRef.current) return null;
        const { playerPosition } = engineRef.current.gameState;
        const dx = prev.position.x - playerPosition.x;
        const dz = prev.position.z - playerPosition.z;
        const dist = Math.sqrt(dx * dx + dz * dz);
        return dist > 50 ? null : prev;
      });
    }, 500);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="relative w-full h-full">
      {loading && (
        <div className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-slate-950">
          <div className="text-center">
            <div className="text-6xl font-bold text-cyan-400 mb-4 tracking-widest"
              style={{ fontFamily: "serif", textShadow: "0 0 30px #00ffcc" }}>
              CAPIXELATE
            </div>
            <div className="text-slate-400 text-lg mb-8">Charting the waters...</div>
            <div className="w-48 h-1.5 bg-slate-800 rounded-full overflow-hidden mx-auto">
              <div className="h-full bg-cyan-400 rounded-full animate-pulse" style={{ width: "70%" }} />
            </div>
          </div>
        </div>
      )}

      <canvas
        ref={canvasRef}
        className="w-full h-full block"
        style={{ touchAction: "none" }}
      />

      {!loading && (
        <GameHUD
          hudState={hudState}
          nearbyIsland={nearbyIsland}
          onSailToIsland={handleSailToIsland}
          onPortalClick={handlePortalClick}
          activeProject={activeProject}
          onCloseProject={() => setActiveProject(null)}
        />
      )}
    </div>
  );
}
