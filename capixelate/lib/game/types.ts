import * as THREE from "three";

export interface GameState {
  playerHealth: number;
  playerMaxHealth: number;
  playerCannonBalls: number;
  playerGold: number;
  playerSpeed: number;
  playerRotation: number;
  playerPosition: { x: number; z: number };
  windDirection: number;
  windSpeed: number;
  discoveredTiles: Set<string>;
  enemies: EnemyState[];
  islands: IslandState[];
  projectiles: ProjectileState[];
  lootMessages: LootMessage[];
  gamePhase: "sailing" | "combat" | "docked" | "dead";
  fogOfWar: Map<string, boolean>;
}

export interface EnemyState {
  id: string;
  name: string;
  type: "ship" | "monster";
  position: { x: number; z: number };
  rotation: number;
  health: number;
  maxHealth: number;
  state: "patrol" | "chase" | "attack" | "flee" | "sinking" | "dead";
  behavior: "fight" | "flee" | "fleeBeforeSink";
  speed: number;
  cannonAccuracy: number;
  attackCooldown: number;
  zoneX: number;
  zoneZ: number;
  zoneRadius: number;
  fleeThreshold: number;
  lootValue: number;
  mesh?: THREE.Object3D;
  attackMode: string;
}

export interface IslandState {
  id: string;
  name: string;
  position: { x: number; z: number };
  scale: number;
  projectUrl?: string;
  projectTitle?: string;
  projectDescription?: string;
  projectIconUrl?: string;
  isDiscovered: boolean;
  mesh?: THREE.Object3D;
}

export interface ProjectileState {
  id: string;
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  owner: "player" | "enemy";
  enemyId?: string;
  mesh?: THREE.Mesh;
  lifetime: number;
}

export interface LootMessage {
  id: string;
  message: string;
  position: { x: number; z: number };
  opacity: number;
  timestamp: number;
}

export interface InputState {
  forward: boolean;
  backward: boolean;
  left: boolean;
  right: boolean;
  fire: boolean;
  fireCooldown: number;
  sailToIsland: boolean;
}

export interface GameRef {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  clock: THREE.Clock;
  gameState: GameState;
  inputState: InputState;
  playerShip: THREE.Group;
  water: THREE.Mesh;
  animationId: number;
}
