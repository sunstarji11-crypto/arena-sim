import { useEffect, useMemo, useRef, useState } from "react";

type AIBehavior = "aggressive" | "kite" | "opportunist";
type MapElementType = "wall" | "slowZone" | "boostZone" | "damageZone" | "healZone";

type Vec2 = { x: number; y: number };

interface ArenaConfig {
  width: number;
  height: number;
  background: string;
  wallBounce: number;
  friction: number;
  maxSpeed: number;
  timeScale: number;
  roundTimeLimit: number;
  showTrails: boolean;
  trailLength: number;
}

interface UnitAI {
  behavior: AIBehavior;
  preferredDistance: number;
  focusLowestHp: boolean;
  avoidStrongerEnemies: boolean;
  bravery: number;
}

interface ProjectileConfig {
  type: "normal" | "pierce" | "explosive";
  speed: number;
  radius: number;
  life: number;
  color: string;
  homing: number;
  pierceCount: number;
  explosionRadius: number;
}

interface UnitType {
  id: string;
  name: string;
  color: string;
  radius: number;
  maxHp: number;
  moveSpeed: number;
  attackDamage: number;
  attackRange: number;
  attackCooldown: number;
  aggroRange: number;
  knockback: number;
  contactDamage: number;
  defense: number;
  attackType: "normal" | "punch";
  punchMultiplier: number;
  projectile: ProjectileConfig | null;
  ai: UnitAI;
}

interface UnitDeployment {
  id: string;
  unitTypeId: string;
  team: string;
  x: number;
  y: number;
  count: number;
  spread: number;
}

interface MapElement {
  id: string;
  type: MapElementType;
  x: number;
  y: number;
  width: number;
  height: number;
  intensity: number;
  color: string;
}

interface EventConfig {
  id: string;
  time: number;
  type: "message";
  payload: { text: string };
}

interface SimulatorConfig {
  arena: ArenaConfig;
  unitTypes: UnitType[];
  units: UnitDeployment[];
  mapElements: MapElement[];
  events: EventConfig[];
}

interface RuntimeUnit {
  id: string;
  team: string;
  unitTypeId: string;
  name: string;
  color: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  hp: number;
  maxHp: number;
  alive: boolean;
  kills: number;
  attackTimer: number;
  attackCount: number;
  buffs: { speedMult: number; damageMult: number };
  trail: Vec2[];
}

interface RuntimeProjectile {
  id: string;
  ownerId: string;
  ownerTeam: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  damage: number;
  knockback: number;
  radius: number;
  life: number;
  color: string;
  homing: number;
  type: "normal" | "pierce" | "explosive";
  pierceLeft: number;
  explosionRadius: number;
}

interface SimulationState {
  config: SimulatorConfig;
  runtimeUnits: RuntimeUnit[];
  projectiles: RuntimeProjectile[];
  effects: RuntimeEffect[];
  time: number;
  running: boolean;
  paused: boolean;
  winner: string | null;
  eventLog: string[];
  firedEvents: Set<string>;
}

interface RuntimeEffect {
  id: string;
  type: "punch" | "explosion" | "pierce";
  x: number;
  y: number;
  radius: number;
  life: number;
  maxLife: number;
  color: string;
}

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const distance = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);
const dot = (a: Vec2, b: Vec2) => a.x * b.x + a.y * b.y;
const normalize = (v: Vec2): Vec2 => {
  const len = Math.hypot(v.x, v.y);
  return len < 1e-6 ? { x: 0, y: 0 } : { x: v.x / len, y: v.y / len };
};
const pointInRect = (p: Vec2, r: MapElement) => p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;
const rectCenter = (r: MapElement): Vec2 => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
const distancePointToRect = (p: Vec2, r: MapElement) => {
  const dx = Math.max(r.x - p.x, 0, p.x - (r.x + r.width));
  const dy = Math.max(r.y - p.y, 0, p.y - (r.y + r.height));
  return Math.hypot(dx, dy);
};
const getHealthRatio = (u: RuntimeUnit) => (u.maxHp <= 0 ? 0 : u.hp / u.maxHp);

const segmentIntersectsRect = (a: Vec2, b: Vec2, r: MapElement) => {
  const steps = 16;
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    if (pointInRect(p, r)) return true;
  }
  return false;
};

const findBlockingWall = (a: Vec2, b: Vec2, mapElements: MapElement[]) =>
  mapElements.find((m) => m.type === "wall" && segmentIntersectsRect(a, b, m)) || null;

const nearestElementByType = (p: Vec2, mapElements: MapElement[], type: MapElementType) => {
  const candidates = mapElements.filter((m) => m.type === type);
  if (!candidates.length) return null;
  let best = candidates[0];
  let bestD = distancePointToRect(p, best);
  for (let i = 1; i < candidates.length; i += 1) {
    const d = distancePointToRect(p, candidates[i]);
    if (d < bestD) {
      best = candidates[i];
      bestD = d;
    }
  }
  return best;
};

const DEFAULT_CONFIG: SimulatorConfig = {
  arena: {
    width: 1400,
    height: 900,
    background: "#0f172a",
    wallBounce: 0.99,
    friction: 0.995,
    maxSpeed: 300,
    timeScale: 1,
    roundTimeLimit: 120,
    showTrails: true,
    trailLength: 30,
  },
  unitTypes: [
    {
      id: "red_fighter",
      name: "Red Fighter",
      color: "#ef4444",
      radius: 14,
      maxHp: 120,
      moveSpeed: 92,
      attackDamage: 14,
      attackRange: 24,
      attackCooldown: 0.72,
      aggroRange: 340,
      knockback: 120,
      contactDamage: 0,
      defense: 0,
      attackType: "normal",
      punchMultiplier: 1.7,
      projectile: null,
      ai: { behavior: "aggressive", preferredDistance: 12, focusLowestHp: false, avoidStrongerEnemies: false, bravery: 1 },
    },
    {
      id: "blue_archer",
      name: "Blue Archer",
      color: "#3b82f6",
      radius: 12,
      maxHp: 84,
      moveSpeed: 96,
      attackDamage: 9,
      attackRange: 240,
      attackCooldown: 0.9,
      aggroRange: 380,
      knockback: 75,
      contactDamage: 0,
      defense: 0,
      attackType: "normal",
      punchMultiplier: 1.7,
      projectile: { type: "normal", speed: 270, radius: 4, life: 3, color: "#93c5fd", homing: 0, pierceCount: 1, explosionRadius: 70 },
      ai: { behavior: "kite", preferredDistance: 150, focusLowestHp: true, avoidStrongerEnemies: false, bravery: 0.95 },
    },
    {
      id: "green_tank",
      name: "Green Tank",
      color: "#22c55e",
      radius: 18,
      maxHp: 220,
      moveSpeed: 62,
      attackDamage: 20,
      attackRange: 28,
      attackCooldown: 1.18,
      aggroRange: 290,
      knockback: 165,
      contactDamage: 3,
      defense: 4,
      attackType: "punch",
      punchMultiplier: 2.2,
      projectile: null,
      ai: { behavior: "aggressive", preferredDistance: 10, focusLowestHp: false, avoidStrongerEnemies: false, bravery: 1.2 },
    },
    {
      id: "yellow_rogue",
      name: "Yellow Rogue",
      color: "#facc15",
      radius: 11,
      maxHp: 72,
      moveSpeed: 128,
      attackDamage: 12,
      attackRange: 22,
      attackCooldown: 0.46,
      aggroRange: 320,
      knockback: 92,
      contactDamage: 0,
      defense: 0,
      attackType: "normal",
      punchMultiplier: 1.6,
      projectile: null,
      ai: { behavior: "opportunist", preferredDistance: 10, focusLowestHp: true, avoidStrongerEnemies: true, bravery: 0.75 },
    },
  ],
  units: [
    { id: "deploy_red", unitTypeId: "red_fighter", team: "Red", x: 180, y: 170, count: 4, spread: 40 },
    { id: "deploy_blue", unitTypeId: "blue_archer", team: "Blue", x: 1220, y: 170, count: 4, spread: 40 },
    { id: "deploy_green", unitTypeId: "green_tank", team: "Green", x: 180, y: 720, count: 2, spread: 28 },
    { id: "deploy_yellow", unitTypeId: "yellow_rogue", team: "Yellow", x: 1220, y: 720, count: 5, spread: 36 },
  ],
  mapElements: [
    { id: "wall_1", type: "wall", x: 650, y: 270, width: 110, height: 280, intensity: 1, color: "#64748b" },
    { id: "slow_1", type: "slowZone", x: 260, y: 360, width: 180, height: 120, intensity: 1.1, color: "#38bdf8" },
    { id: "boost_1", type: "boostZone", x: 960, y: 360, width: 180, height: 120, intensity: 1.2, color: "#a78bfa" },
    { id: "damage_1", type: "damageZone", x: 590, y: 620, width: 220, height: 100, intensity: 8, color: "#f97316" },
    { id: "heal_1", type: "healZone", x: 1120, y: 620, width: 170, height: 110, intensity: 10, color: "#22c55e" },
  ],
  events: [{ id: "ev1", time: 10, type: "message", payload: { text: "Expanded arena battle in progress" } }],
};

function sanitizeConfig(config: SimulatorConfig): SimulatorConfig {
  return {
    arena: {
      ...config.arena,
      width: clamp(Number(config.arena.width) || 1400, 200, 6000),
      height: clamp(Number(config.arena.height) || 900, 200, 4000),
      wallBounce: clamp(Number(config.arena.wallBounce) || 0.99, 0, 1.5),
      friction: clamp(Number(config.arena.friction) || 0.995, 0.8, 1),
      maxSpeed: clamp(Number(config.arena.maxSpeed) || 300, 20, 2000),
      timeScale: clamp(Number(config.arena.timeScale) || 1, 0.05, 10),
      roundTimeLimit: clamp(Number(config.arena.roundTimeLimit) || 120, 5, 3600),
      trailLength: clamp(Math.floor(Number(config.arena.trailLength) || 30), 0, 250),
      showTrails: !!config.arena.showTrails,
    },
    unitTypes: config.unitTypes.map((u, i) => ({
      ...u,
      id: u.id || `unit_${i}`,
      name: u.name || `Unit ${i + 1}`,
      radius: clamp(Number(u.radius) || 10, 2, 120),
      maxHp: clamp(Number(u.maxHp) || 100, 1, 5000),
      moveSpeed: clamp(Number(u.moveSpeed) || 100, 1, 1500),
      attackDamage: clamp(Number(u.attackDamage) || 1, 0, 3000),
      attackRange: clamp(Number(u.attackRange) || 10, 0, 2500),
      attackCooldown: clamp(Number(u.attackCooldown) || 0.8, 0.05, 20),
      aggroRange: clamp(Number(u.aggroRange) || 300, 1, 3000),
      knockback: clamp(Number(u.knockback) || 0, 0, 3000),
      contactDamage: clamp(Number(u.contactDamage) || 0, 0, 2000),
      defense: clamp(Number(u.defense) || 0, 0, 1000),
      attackType: u.attackType || "normal",
      punchMultiplier: clamp(Number(u.punchMultiplier) || 1.7, 1, 10),
      ai: {
        behavior: u.ai?.behavior || "aggressive",
        preferredDistance: clamp(Number(u.ai?.preferredDistance) || 10, 0, 3000),
        focusLowestHp: !!u.ai?.focusLowestHp,
        avoidStrongerEnemies: !!u.ai?.avoidStrongerEnemies,
        bravery: clamp(Number(u.ai?.bravery) || 1, 0.1, 3),
      },
      projectile: u.projectile
        ? {
            speed: clamp(Number(u.projectile.speed) || 200, 1, 3000),
            radius: clamp(Number(u.projectile.radius) || 3, 1, 200),
            life: clamp(Number(u.projectile.life) || 2, 0.05, 40),
            color: u.projectile.color || u.color,
            homing: clamp(Number(u.projectile.homing) || 0, 0, 1),
            type: u.projectile.type || "normal",
            pierceCount: clamp(Math.floor(Number(u.projectile.pierceCount) || 1), 1, 20),
            explosionRadius: clamp(Number(u.projectile.explosionRadius) || 70, 5, 1000),
          }
        : null,
    })),
    units: config.units.map((d, i) => ({
      ...d,
      id: d.id || `deploy_${i}`,
      team: d.team || `Team${i + 1}`,
      x: Number(d.x) || 0,
      y: Number(d.y) || 0,
      count: clamp(Math.floor(Number(d.count) || 1), 0, 300),
      spread: clamp(Number(d.spread) || 20, 0, 1000),
    })),
    mapElements: config.mapElements.map((m, i) => ({
      ...m,
      id: m.id || `map_${i}`,
      x: Number(m.x) || 0,
      y: Number(m.y) || 0,
      width: clamp(Number(m.width) || 10, 1, 5000),
      height: clamp(Number(m.height) || 10, 1, 5000),
      intensity: clamp(Number(m.intensity) || 1, 0, 500),
      color: m.color || "#64748b",
    })),
    events: config.events.map((e, i) => ({ ...e, id: e.id || `event_${i}` })),
  };
}

function expandUnits(config: SimulatorConfig): RuntimeUnit[] {
  const unitTypeMap = new Map(config.unitTypes.map((u) => [u.id, u]));
  const out: RuntimeUnit[] = [];
  config.units.forEach((deployment) => {
    const t = unitTypeMap.get(deployment.unitTypeId);
    if (!t) return;
    for (let i = 0; i < deployment.count; i += 1) {
      const a = (Math.PI * 2 * i) / Math.max(1, deployment.count);
      const r = deployment.spread * (0.3 + (i % 3) * 0.35);
      out.push({
        id: `${deployment.id}_${i}`,
        team: deployment.team,
        unitTypeId: t.id,
        name: t.name,
        color: t.color,
        x: deployment.x + Math.cos(a) * r,
        y: deployment.y + Math.sin(a) * r,
        vx: 0,
        vy: 0,
        radius: t.radius,
        hp: t.maxHp,
        maxHp: t.maxHp,
        alive: true,
        kills: 0,
        attackTimer: 0,
        attackCount: 0,
        buffs: { speedMult: 1, damageMult: 1 },
        trail: [],
      });
    }
  });
  return out;
}

function buildInitialState(config: SimulatorConfig): SimulationState {
  const sanitized = sanitizeConfig(config);
  return {
    config: sanitized,
    runtimeUnits: expandUnits(sanitized),
    projectiles: [],
    effects: [],
    time: 0,
    running: false,
    paused: false,
    winner: null,
    eventLog: ["Simulation reset."],
    firedEvents: new Set<string>(),
  };
}

function chooseTarget(unit: RuntimeUnit, state: SimulationState, unitType: UnitType): RuntimeUnit | null {
  const enemies = state.runtimeUnits.filter((u) => u.alive && u.team !== unit.team);
  const allies = state.runtimeUnits.filter((u) => u.alive && u.team === unit.team && u.id !== unit.id);
  const healZones = state.config.mapElements.filter((m) => m.type === "healZone");
  if (!enemies.length) return null;
  let best: RuntimeUnit | null = null;
  let bestScore = -Infinity;
  for (const enemy of enemies) {
    const d = distance(unit, enemy);
    if (d > unitType.aggroRange) continue;
    let score = 2000 - d;
    const enemyNearHeal = healZones.some((z) => distancePointToRect(enemy, z) < enemy.radius + 40);
    const allyPressure = allies.filter((a) => distance(a, enemy) < unitType.aggroRange * 0.65).length;
    if (unitType.ai.focusLowestHp) score += (1 - getHealthRatio(enemy)) * 200;
    if (unitType.ai.avoidStrongerEnemies && enemy.hp > unit.hp * 1.4) score -= 260;
    if (unitType.ai.behavior === "opportunist") {
      if (enemy.hp < unit.hp * 0.9) score += 170;
      score += allyPressure * 85;
    }
    if (unitType.ai.behavior === "aggressive" && enemyNearHeal) score += 260;
    if (unitType.ai.behavior === "kite" && d < unitType.ai.preferredDistance * 0.7) score -= 180;
    if (score > bestScore) {
      bestScore = score;
      best = enemy;
    }
  }
  return best;
}

function scoreCandidateDirection(unit: RuntimeUnit, target: RuntimeUnit | null, candidate: Vec2, state: SimulationState, unitType: UnitType): number {
  const { arena, mapElements } = state.config;
  const n = normalize(candidate);
  const speed = unitType.moveSpeed * unit.buffs.speedMult;
  const predict = { x: unit.x + n.x * speed * 0.35, y: unit.y + n.y * speed * 0.35 };
  let score = 0;
  if (predict.x < 0 || predict.x > arena.width || predict.y < 0 || predict.y > arena.height) score -= 500;

  const wall = mapElements.find((m) => m.type === "wall" && pointInRect(predict, m));
  if (wall) score -= 1000;

  for (const m of mapElements) {
    const inside = pointInRect(predict, m);
    if (!inside) continue;
    if (m.type === "slowZone") score -= unitType.ai.behavior === "kite" ? 120 : 55;
    if (m.type === "boostZone") score += unitType.ai.behavior === "aggressive" || unitType.ai.behavior === "opportunist" ? 110 : 35;
    if (m.type === "damageZone") score -= unitType.ai.behavior === "opportunist" || unitType.ai.behavior === "kite" ? 280 : 140;
    if (m.type === "healZone") score += (1 - getHealthRatio(unit)) * (unitType.ai.behavior === "opportunist" ? 260 : 180);
  }

  const vDir = normalize({ x: unit.vx, y: unit.vy });
  score += dot(vDir, n) * 25;

  if (target) {
    const d = distance(predict, target);
    const pref = unitType.ai.preferredDistance;
    if (unitType.ai.behavior === "aggressive") {
      score += (1500 - d) * 0.24;
      const heal = nearestElementByType(target, mapElements, "healZone");
      if (heal && distancePointToRect(target, heal) < target.radius + 55) score += 160;
    }
    if (unitType.ai.behavior === "kite") {
      score -= Math.abs(d - pref) * 1.05;
      if (d < pref * 0.8) score -= 240;
      if (d > pref * 1.45) score -= 85;
    }
    if (unitType.ai.behavior === "opportunist") {
      score -= Math.abs(d - pref) * 0.45;
      if (target.hp < unit.hp) score += 80;
      if (target.hp > unit.hp * 1.35) score -= 110;
      const nearbyAllies = state.runtimeUnits.filter((u) => u.alive && u.team === unit.team && distance(u, predict) < 150).length;
      score += nearbyAllies * 30;
    }

    const blocking = findBlockingWall(unit, target, mapElements);
    if (blocking && unitType.ai.behavior !== "aggressive") score -= 70;
  } else {
    const heal = nearestElementByType(unit, mapElements, "healZone");
    if (heal && getHealthRatio(unit) < 0.55) {
      const dc = distance(predict, rectCenter(heal));
      score += (700 - dc) * 0.2;
    }
  }

  return score;
}

function chooseSmartDirection(unit: RuntimeUnit, target: RuntimeUnit | null, state: SimulationState, unitType: UnitType): Vec2 {
  if (!target) {
    const heal = nearestElementByType(unit, state.config.mapElements, "healZone");
    if (heal && getHealthRatio(unit) < 0.55) {
      return normalize({ x: rectCenter(heal).x - unit.x, y: rectCenter(heal).y - unit.y });
    }
    return normalize({ x: unit.vx, y: unit.vy });
  }

  const toTarget = normalize({ x: target.x - unit.x, y: target.y - unit.y });
  const away = { x: -toTarget.x, y: -toTarget.y };
  const left = { x: -toTarget.y, y: toTarget.x };
  const right = { x: toTarget.y, y: -toTarget.x };
  const inertia = normalize({ x: unit.vx, y: unit.vy });

  const candidates: Vec2[] = [
    toTarget,
    away,
    left,
    right,
    inertia,
    { x: toTarget.x + left.x * 0.6, y: toTarget.y + left.y * 0.6 },
    { x: toTarget.x + right.x * 0.6, y: toTarget.y + right.y * 0.6 },
  ];

  if (unitType.ai.behavior === "opportunist") {
    const packCenterCandidates = state.runtimeUnits.filter((u) => u.alive && u.team === unit.team && u.id !== unit.id);
    if (packCenterCandidates.length > 0) {
      const cx = packCenterCandidates.reduce((acc, u) => acc + u.x, 0) / packCenterCandidates.length;
      const cy = packCenterCandidates.reduce((acc, u) => acc + u.y, 0) / packCenterCandidates.length;
      candidates.push(normalize({ x: (toTarget.x * 0.7 + (cx - unit.x) * 0.3), y: (toTarget.y * 0.7 + (cy - unit.y) * 0.3) }));
    }
  }

  const blocking = findBlockingWall(unit, target, state.config.mapElements);
  if (blocking) {
    candidates.push(
      normalize({ x: blocking.x - unit.x, y: blocking.y - unit.y }),
      normalize({ x: blocking.x + blocking.width - unit.x, y: blocking.y - unit.y }),
      normalize({ x: blocking.x - unit.x, y: blocking.y + blocking.height - unit.y }),
      normalize({ x: blocking.x + blocking.width - unit.x, y: blocking.y + blocking.height - unit.y }),
    );
  }

  let best = candidates[0];
  let bestScore = -Infinity;
  for (const c of candidates) {
    const score = scoreCandidateDirection(unit, target, c, state, unitType);
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return normalize(best);
}

function applyDamage(attacker: RuntimeUnit | null, target: RuntimeUnit, rawDamage: number): number {
  const damage = Math.max(0, rawDamage);
  target.hp = Math.max(0, target.hp - damage);
  if (target.hp <= 0 && target.alive) {
    target.alive = false;
    if (attacker) attacker.kills += 1;
  }
  return damage;
}

function collideWithArenaAndWalls(unit: RuntimeUnit, state: SimulationState) {
  const { arena, mapElements } = state.config;
  const bounce = arena.wallBounce;
  if (unit.x - unit.radius < 0) {
    unit.x = unit.radius;
    unit.vx = Math.abs(unit.vx) * bounce;
  }
  if (unit.x + unit.radius > arena.width) {
    unit.x = arena.width - unit.radius;
    unit.vx = -Math.abs(unit.vx) * bounce;
  }
  if (unit.y - unit.radius < 0) {
    unit.y = unit.radius;
    unit.vy = Math.abs(unit.vy) * bounce;
  }
  if (unit.y + unit.radius > arena.height) {
    unit.y = arena.height - unit.radius;
    unit.vy = -Math.abs(unit.vy) * bounce;
  }

  for (const wall of mapElements.filter((m) => m.type === "wall")) {
    if (!pointInRect(unit, wall)) continue;
    const left = Math.abs(unit.x - wall.x);
    const right = Math.abs(unit.x - (wall.x + wall.width));
    const top = Math.abs(unit.y - wall.y);
    const bottom = Math.abs(unit.y - (wall.y + wall.height));
    const minEdge = Math.min(left, right, top, bottom);
    if (minEdge === left) {
      unit.x = wall.x - unit.radius;
      unit.vx = -Math.abs(unit.vx) * bounce;
    } else if (minEdge === right) {
      unit.x = wall.x + wall.width + unit.radius;
      unit.vx = Math.abs(unit.vx) * bounce;
    } else if (minEdge === top) {
      unit.y = wall.y - unit.radius;
      unit.vy = -Math.abs(unit.vy) * bounce;
    } else {
      unit.y = wall.y + wall.height + unit.radius;
      unit.vy = Math.abs(unit.vy) * bounce;
    }
  }
}

function updateProjectiles(state: SimulationState, dt: number) {
  const unitById = new Map(state.runtimeUnits.map((u) => [u.id, u]));
  const walls = state.config.mapElements.filter((m) => m.type === "wall");
  const { width, height } = state.config.arena;

  state.projectiles = state.projectiles.filter((p) => {
    const projectileType = p.type === "explosive" || p.type === "pierce" ? p.type : "normal";
    p.life -= dt;
    if (p.life <= 0) return false;

    if (p.homing > 0) {
      const target = state.runtimeUnits
        .filter((u) => u.alive && u.team !== p.ownerTeam)
        .sort((a, b) => distance(p, a) - distance(p, b))[0];
      if (target) {
        const desired = normalize({ x: target.x - p.x, y: target.y - p.y });
        const cur = normalize({ x: p.vx, y: p.vy });
        const blended = normalize({ x: cur.x * (1 - p.homing) + desired.x * p.homing, y: cur.y * (1 - p.homing) + desired.y * p.homing });
        const speed = Math.hypot(p.vx, p.vy);
        p.vx = blended.x * speed;
        p.vy = blended.y * speed;
      }
    }

    p.x += p.vx * dt;
    p.y += p.vy * dt;

    if (p.x < 0 || p.x > width || p.y < 0 || p.y > height) return false;
    if (walls.some((w) => pointInRect(p, w))) return false;

    for (const unit of state.runtimeUnits) {
      if (!unit.alive || unit.team === p.ownerTeam) continue;
      if (distance(unit, p) <= unit.radius + p.radius) {
        const owner = unitById.get(p.ownerId) || null;
        if (projectileType === "explosive") {
          const radius = Math.max(5, p.explosionRadius);
          state.effects.push({
            id: `fx_explosion_${Math.random().toString(36).slice(2, 9)}`,
            type: "explosion",
            x: p.x,
            y: p.y,
            radius,
            life: 0.35,
            maxLife: 0.35,
            color: p.color,
          });
          const victims = state.runtimeUnits.filter((u) => u.alive && u.team !== p.ownerTeam && distance(u, p) <= radius + u.radius);
          victims.forEach((victim) => {
            const d = distance(victim, p);
            const falloff = clamp(1 - d / radius, 0.2, 1);
            applyDamage(owner, victim, p.damage * falloff);
            const n = normalize({ x: victim.x - p.x, y: victim.y - p.y });
            victim.vx += n.x * p.knockback * falloff;
            victim.vy += n.y * p.knockback * falloff;
          });
          return false;
        }

        applyDamage(owner, unit, p.damage);
        const n = normalize({ x: unit.x - p.x, y: unit.y - p.y });
        unit.vx += n.x * p.knockback;
        unit.vy += n.y * p.knockback;
        if (projectileType === "pierce") {
          state.effects.push({
            id: `fx_pierce_${Math.random().toString(36).slice(2, 9)}`,
            type: "pierce",
            x: unit.x,
            y: unit.y,
            radius: Math.max(8, p.radius * 3),
            life: 0.2,
            maxLife: 0.2,
            color: p.color,
          });
          p.pierceLeft -= 1;
          if (p.pierceLeft > 0) return true;
        }
        return false;
      }
    }

    return true;
  });
}

function updateSimulation(prev: SimulationState, dtRaw: number): SimulationState {
  if (!prev.running || prev.paused || prev.winner) return prev;
  const state: SimulationState = {
    ...prev,
    runtimeUnits: prev.runtimeUnits.map((u) => ({ ...u, buffs: { ...u.buffs }, trail: [...u.trail] })),
    projectiles: prev.projectiles.map((p) => ({ ...p })),
    effects: prev.effects.map((e) => ({ ...e })),
    firedEvents: new Set(prev.firedEvents),
    eventLog: [...prev.eventLog],
  };

  const dt = dtRaw * state.config.arena.timeScale;
  state.time += dt;

  const unitTypeMap = new Map(state.config.unitTypes.map((u) => [u.id, u]));
  state.effects = state.effects.filter((e) => {
    e.life -= dt;
    const validType = e.type === "punch" || e.type === "pierce" || e.type === "explosion";
    return validType && e.life > 0;
  });

  for (const event of state.config.events) {
    if (!state.firedEvents.has(event.id) && state.time >= event.time) {
      if (event.type === "message") state.eventLog.unshift(`[${event.time.toFixed(1)}s] ${event.payload.text}`);
      state.firedEvents.add(event.id);
    }
  }

  for (const unit of state.runtimeUnits) {
    if (!unit.alive) continue;
    const unitType = unitTypeMap.get(unit.unitTypeId);
    if (!unitType) continue;

    unit.attackTimer = Math.max(0, unit.attackTimer - dt);
    unit.buffs = { speedMult: 1, damageMult: 1 };

    for (const zone of state.config.mapElements) {
      if (!pointInRect(unit, zone)) continue;
      if (zone.type === "slowZone") unit.buffs.speedMult *= 1 / Math.max(1.01, zone.intensity);
      if (zone.type === "boostZone") unit.buffs.speedMult *= Math.max(1, zone.intensity);
      if (zone.type === "damageZone") applyDamage(null, unit, zone.intensity * dt);
      if (zone.type === "healZone") unit.hp = Math.min(unit.maxHp, unit.hp + zone.intensity * dt);
    }
    if (!unit.alive) continue;

    const target = chooseTarget(unit, state, unitType);
    const dir = chooseSmartDirection(unit, target, state, unitType);
    const accel = unitType.moveSpeed * unit.buffs.speedMult * (0.8 + 0.4 * unitType.ai.bravery);
    unit.vx += dir.x * accel * dt;
    unit.vy += dir.y * accel * dt;

    if (target) {
      const d = distance(unit, target);
      const nextAttackCount = unit.attackCount + 1;
      const isPunchAttack = unitType.attackType === "punch" && nextAttackCount % 2 === 0;
      const rangeMult = isPunchAttack ? 2 : 1;
      const damageMult = isPunchAttack ? unitType.punchMultiplier : 1;
      if (unit.attackTimer <= 0 && d <= unitType.attackRange * rangeMult + unit.radius + target.radius) {
        unit.attackTimer = unitType.attackCooldown;
        unit.attackCount = nextAttackCount;
        const outgoing = unitType.attackDamage * unit.buffs.damageMult * damageMult;
        if (isPunchAttack && !unitType.projectile) {
          state.effects.push({
            id: `fx_punch_${Math.random().toString(36).slice(2, 9)}`,
            type: "punch",
            x: target.x,
            y: target.y,
            radius: unitType.attackRange + target.radius,
            life: 0.18,
            maxLife: 0.18,
            color: unit.color,
          });
        }
        if (unitType.projectile) {
          const shotDir = normalize({ x: target.x - unit.x, y: target.y - unit.y });
          state.projectiles.push({
            id: `${unit.id}_p_${Math.random().toString(36).slice(2, 10)}`,
            ownerId: unit.id,
            ownerTeam: unit.team,
            x: unit.x + shotDir.x * (unit.radius + unitType.projectile.radius + 2),
            y: unit.y + shotDir.y * (unit.radius + unitType.projectile.radius + 2),
            vx: shotDir.x * unitType.projectile.speed,
            vy: shotDir.y * unitType.projectile.speed,
            damage: outgoing,
            knockback: unitType.knockback,
            radius: unitType.projectile.radius,
            life: unitType.projectile.life,
            color: unitType.projectile.color,
            homing: unitType.projectile.homing,
            type: unitType.projectile.type,
            pierceLeft: unitType.projectile.pierceCount,
            explosionRadius: unitType.projectile.explosionRadius,
          });
        } else {
          const targetType = unitTypeMap.get(target.unitTypeId);
          const reduced = Math.max(0, outgoing - (targetType?.defense ?? 0));
          applyDamage(unit, target, reduced);
          const kb = normalize({ x: target.x - unit.x, y: target.y - unit.y });
          target.vx += kb.x * unitType.knockback;
          target.vy += kb.y * unitType.knockback;
        }
      }
    }

    unit.vx *= state.config.arena.friction;
    unit.vy *= state.config.arena.friction;
    const speed = Math.hypot(unit.vx, unit.vy);
    if (speed > state.config.arena.maxSpeed) {
      const n = state.config.arena.maxSpeed / speed;
      unit.vx *= n;
      unit.vy *= n;
    }

    unit.x += unit.vx * dt;
    unit.y += unit.vy * dt;
    collideWithArenaAndWalls(unit, state);

    if (unitType.contactDamage > 0) {
      for (const enemy of state.runtimeUnits) {
        if (!enemy.alive || enemy.team === unit.team) continue;
        if (distance(unit, enemy) < unit.radius + enemy.radius) {
          const enemyType = unitTypeMap.get(enemy.unitTypeId);
          applyDamage(unit, enemy, Math.max(0, unitType.contactDamage - (enemyType?.defense ?? 0)) * dt);
        }
      }
    }

    if (state.config.arena.showTrails) {
      unit.trail.push({ x: unit.x, y: unit.y });
      if (unit.trail.length > state.config.arena.trailLength) unit.trail.shift();
    } else {
      unit.trail = [];
    }
  }

  for (let i = 0; i < state.runtimeUnits.length; i += 1) {
    for (let j = i + 1; j < state.runtimeUnits.length; j += 1) {
      const a = state.runtimeUnits[i];
      const b = state.runtimeUnits[j];
      if (!a.alive || !b.alive) continue;
      const d = distance(a, b);
      const minDist = a.radius + b.radius;
      if (d > 0 && d < minDist) {
        const n = { x: (a.x - b.x) / d, y: (a.y - b.y) / d };
        const overlap = minDist - d;
        a.x += n.x * overlap * 0.5;
        a.y += n.y * overlap * 0.5;
        b.x -= n.x * overlap * 0.5;
        b.y -= n.y * overlap * 0.5;
        a.vx += n.x * 12;
        a.vy += n.y * 12;
        b.vx -= n.x * 12;
        b.vy -= n.y * 12;
      }
    }
  }

  updateProjectiles(state, dt);

  const aliveTeams = Array.from(new Set(state.runtimeUnits.filter((u) => u.alive).map((u) => u.team)));
  if (aliveTeams.length <= 1) state.winner = aliveTeams[0] ?? "No team";
  if (!state.winner && state.time >= state.config.arena.roundTimeLimit) {
    const hpByTeam = new Map<string, number>();
    state.runtimeUnits.forEach((u) => {
      hpByTeam.set(u.team, (hpByTeam.get(u.team) || 0) + Math.max(0, u.hp));
    });
    let bestTeam: string | null = null;
    let bestHp = -1;
    for (const [team, hp] of hpByTeam.entries()) {
      if (hp > bestHp) {
        bestHp = hp;
        bestTeam = team;
      }
    }
    state.winner = bestTeam ?? "Draw";
    state.eventLog.unshift(`Time limit reached. Winner by remaining HP: ${state.winner}`);
  }

  if (state.eventLog.length > 80) state.eventLog = state.eventLog.slice(0, 80);
  return state;
}

function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj)) as T;
}

export default function ModdableArenaSimulator() {
  const [draftConfig, setDraftConfig] = useState<SimulatorConfig>(() => deepClone(DEFAULT_CONFIG));
  const [simState, setSimState] = useState<SimulationState>(() => buildInitialState(deepClone(DEFAULT_CONFIG)));
  const [tab, setTab] = useState<"units" | "arena" | "map">("units");
  const rafRef = useRef<number | null>(null);
  const lastTimeRef = useRef<number>(0);

  useEffect(() => {
    const tick = (t: number) => {
      if (!lastTimeRef.current) lastTimeRef.current = t;
      const dt = Math.min(0.05, (t - lastTimeRef.current) / 1000);
      lastTimeRef.current = t;
      setSimState((prev) => updateSimulation(prev, dt));
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  const teamStats = useMemo(() => {
    const map = new Map<string, { total: number; alive: number; hp: number; kills: number }>();
    simState.runtimeUnits.forEach((u) => {
      const s = map.get(u.team) || { total: 0, alive: 0, hp: 0, kills: 0 };
      s.total += 1;
      if (u.alive) s.alive += 1;
      s.hp += Math.max(0, u.hp);
      s.kills += u.kills;
      map.set(u.team, s);
    });
    return Array.from(map.entries());
  }, [simState.runtimeUnits]);

  const applyConfig = () => {
    const clean = sanitizeConfig(deepClone(draftConfig));
    setDraftConfig(clean);
    setSimState(buildInitialState(clean));
  };

  const start = () => setSimState((s) => ({ ...s, running: true, paused: false, winner: null, eventLog: ["Battle started.", ...s.eventLog] }));
  const togglePause = () => setSimState((s) => ({ ...s, paused: !s.paused, eventLog: [`Simulation ${s.paused ? "resumed" : "paused"}.`, ...s.eventLog] }));
  const reset = () => setSimState(buildInitialState(sanitizeConfig(deepClone(draftConfig))));

  const updateArenaField = (key: keyof ArenaConfig, value: string | boolean) => {
    setDraftConfig((c) => ({ ...c, arena: { ...c.arena, [key]: typeof value === "string" ? Number(value) || 0 : value } }));
  };

  const updateUnitTypeField = (idx: number, key: keyof UnitType, value: any) => {
    setDraftConfig((c) => {
      const unitTypes = [...c.unitTypes];
      unitTypes[idx] = { ...unitTypes[idx], [key]: value };
      return { ...c, unitTypes };
    });
  };

  const updateUnitAIField = (idx: number, key: keyof UnitAI, value: any) => {
    setDraftConfig((c) => {
      const unitTypes = [...c.unitTypes];
      unitTypes[idx] = { ...unitTypes[idx], ai: { ...unitTypes[idx].ai, [key]: value } };
      return { ...c, unitTypes };
    });
  };

  const updateProjectileField = (idx: number, key: keyof ProjectileConfig, value: any) => {
    setDraftConfig((c) => {
      const unitTypes = [...c.unitTypes];
      const current = unitTypes[idx].projectile || { type: "normal" as const, speed: 220, radius: 4, life: 2, color: unitTypes[idx].color, homing: 0, pierceCount: 1, explosionRadius: 70 };
      unitTypes[idx] = { ...unitTypes[idx], projectile: { ...current, [key]: value } };
      return { ...c, unitTypes };
    });
  };

  const updateDeploymentField = (unitTypeId: string, key: keyof UnitDeployment, value: any) => {
    setDraftConfig((c) => {
      const units = [...c.units];
      const idx = units.findIndex((u) => u.unitTypeId === unitTypeId);
      if (idx >= 0) units[idx] = { ...units[idx], [key]: value };
      else units.push({ id: `deploy_${unitTypeId}`, unitTypeId, team: "Team", x: 100, y: 100, count: 1, spread: 20, [key]: value });
      return { ...c, units };
    });
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-4 md:p-6">
      <div className="max-w-[1700px] mx-auto space-y-4">
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-lg shadow-slate-950/30">
          <h1 className="text-2xl font-bold">Moddable Arena Simulator</h1>
          <p className="text-slate-400 mt-1">MrBouncerson-style sandbox with map-aware AI, zones, projectiles, and live controls.</p>
          <div className="flex flex-wrap gap-2 mt-3">
            <button className="px-4 py-2 rounded bg-emerald-600 hover:bg-emerald-500" onClick={applyConfig}>Apply</button>
            <button className="px-4 py-2 rounded bg-blue-600 hover:bg-blue-500" onClick={start}>Start</button>
            <button className="px-4 py-2 rounded bg-amber-600 hover:bg-amber-500" onClick={togglePause}>{simState.paused ? "Resume" : "Pause"}</button>
            <button className="px-4 py-2 rounded bg-rose-600 hover:bg-rose-500" onClick={reset}>Reset</button>
          </div>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-[1fr_360px] gap-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-3 overflow-auto max-h-[70vh]">
            <svg width={simState.config.arena.width} height={simState.config.arena.height} className="rounded-lg" style={{ background: simState.config.arena.background }}>
              {simState.config.mapElements.map((m) => (
                <rect key={m.id} x={m.x} y={m.y} width={m.width} height={m.height} fill={m.color} opacity={m.type === "wall" ? 0.8 : 0.3} stroke={m.type === "wall" ? "#cbd5e1" : m.color} strokeWidth={1.2} />
              ))}

              {simState.config.arena.showTrails && simState.runtimeUnits.map((u) => (
                <polyline
                  key={`trail-${u.id}`}
                  points={u.trail.map((p) => `${p.x},${p.y}`).join(" ")}
                  fill="none"
                  stroke={u.color}
                  opacity={0.35}
                  strokeWidth={1.5}
                />
              ))}

              {simState.projectiles.map((p) => <circle key={p.id} cx={p.x} cy={p.y} r={p.radius} fill={p.color} />)}
              {simState.effects.map((fx) => {
                const alpha = clamp(fx.life / fx.maxLife, 0, 1);
                if (fx.type === "explosion") {
                  return <circle key={fx.id} cx={fx.x} cy={fx.y} r={fx.radius * (1 - alpha * 0.35)} fill={fx.color} opacity={0.18 * alpha} stroke={fx.color} strokeWidth={3} />;
                }
                if (fx.type === "pierce") {
                  return <circle key={fx.id} cx={fx.x} cy={fx.y} r={fx.radius} fill="none" stroke={fx.color} strokeWidth={2} opacity={0.7 * alpha} />;
                }
                if (fx.type === "punch") {
                  return <circle key={fx.id} cx={fx.x} cy={fx.y} r={fx.radius * (0.4 + (1 - alpha) * 0.8)} fill="none" stroke={fx.color} strokeWidth={4} opacity={0.65 * alpha} />;
                }
                return null;
              })}

              {simState.runtimeUnits.map((u) => (
                <g key={u.id} opacity={u.alive ? 1 : 0.35}>
                  <circle cx={u.x} cy={u.y} r={u.radius} fill={u.color} stroke="#0b1220" strokeWidth={2} />
                  <rect x={u.x - u.radius} y={u.y - u.radius - 10} width={u.radius * 2} height={4} fill="#1e293b" />
                  <rect x={u.x - u.radius} y={u.y - u.radius - 10} width={u.radius * 2 * clamp(u.hp / u.maxHp, 0, 1)} height={4} fill="#22c55e" />
                </g>
              ))}

              <text x={16} y={28} fill="#e2e8f0" fontSize={18}>Time: {simState.time.toFixed(1)}s</text>
              <text x={16} y={52} fill="#e2e8f0" fontSize={16}>Status: {simState.running ? (simState.paused ? "Paused" : "Running") : "Stopped"}</text>
              <text x={16} y={74} fill="#fbbf24" fontSize={16}>{simState.winner ? `Winner: ${simState.winner}` : "Winner: TBD"}</text>
            </svg>
          </div>

          <div className="space-y-4">
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
              <h2 className="font-semibold mb-3">Team Panels</h2>
              <div className="space-y-2">
                {teamStats.map(([team, s]) => (
                  <div key={team} className="bg-slate-800 rounded-lg p-3">
                    <div className="font-semibold">{team}</div>
                    <div className="text-sm text-slate-300">Alive / Total: {s.alive} / {s.total}</div>
                    <div className="text-sm text-slate-300">Total HP: {s.hp.toFixed(1)}</div>
                    <div className="text-sm text-slate-300">Kills: {s.kills}</div>
                    <div className="text-sm text-slate-300">Units count: {s.total}</div>
                  </div>
                ))}
              </div>
            </div>

            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
              <h2 className="font-semibold mb-3">Event Log</h2>
              <div className="space-y-1 max-h-[250px] overflow-auto text-sm text-slate-300">
                {simState.eventLog.map((e, i) => <div key={`${e}-${i}`}>• {e}</div>)}
              </div>
            </div>
          </div>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
          <div className="flex gap-2 mb-4">
            <button className={`px-3 py-1.5 rounded ${tab === "units" ? "bg-blue-600" : "bg-slate-800"}`} onClick={() => setTab("units")}>Unit Controls</button>
            <button className={`px-3 py-1.5 rounded ${tab === "arena" ? "bg-blue-600" : "bg-slate-800"}`} onClick={() => setTab("arena")}>Arena</button>
            <button className={`px-3 py-1.5 rounded ${tab === "map" ? "bg-blue-600" : "bg-slate-800"}`} onClick={() => setTab("map")}>Map Elements</button>
          </div>
          <p className="text-xs text-slate-400 mb-4">
            {tab === "units" && "Edit unit templates, team deployment, and AI behavior."}
            {tab === "arena" && "Tune arena physics, pacing, and round settings."}
            {tab === "map" && "Add and edit walls/zones with live color previews."}
          </p>

          {tab === "arena" && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {(["width", "height", "wallBounce", "friction", "maxSpeed", "timeScale", "roundTimeLimit", "trailLength"] as (keyof ArenaConfig)[]).map((k) => (
                <label key={k} className="text-sm">
                  <div className="mb-1 capitalize">{k}</div>
                  <input className="w-full bg-slate-800 rounded px-2 py-1" type="number" value={String(draftConfig.arena[k] as number)} onChange={(e) => updateArenaField(k, e.target.value)} />
                </label>
              ))}
            </div>
          )}

          {tab === "map" && (
            <div className="space-y-3">
              <button
                className="px-3 py-2 rounded bg-emerald-700"
                onClick={() => setDraftConfig((c) => ({ ...c, mapElements: [...c.mapElements, { id: `map_${Date.now()}`, type: "wall", x: 100, y: 100, width: 120, height: 80, intensity: 1, color: "#64748b" }] }))}
              >
                Add Map Element
              </button>
              {draftConfig.mapElements.map((m, idx) => (
                <div key={m.id} className="bg-slate-800 rounded-xl p-3 grid grid-cols-2 md:grid-cols-9 gap-2 items-end">
                  <label className="text-sm"><div>Type</div><select className="w-full bg-slate-700 rounded px-2 py-1" value={m.type} onChange={(e) => setDraftConfig((c) => { const mapElements = [...c.mapElements]; mapElements[idx] = { ...mapElements[idx], type: e.target.value as MapElementType }; return { ...c, mapElements }; })}><option value="wall">wall</option><option value="slowZone">slowZone</option><option value="boostZone">boostZone</option><option value="damageZone">damageZone</option><option value="healZone">healZone</option></select></label>
                  <label className="text-sm"><div>Color</div><input className="w-full bg-slate-700 rounded px-2 py-1" value={m.color} onChange={(e) => setDraftConfig((c) => { const mapElements = [...c.mapElements]; mapElements[idx] = { ...mapElements[idx], color: e.target.value }; return { ...c, mapElements }; })} /></label>
                  <label className="text-sm"><div>Picker</div><input className="w-full h-9 bg-slate-700 rounded px-1 py-1" type="color" value={m.color} onChange={(e) => setDraftConfig((c) => { const mapElements = [...c.mapElements]; mapElements[idx] = { ...mapElements[idx], color: e.target.value }; return { ...c, mapElements }; })} /></label>
                  {(["x", "y", "width", "height", "intensity"] as const).map((k) => (
                    <label key={k} className="text-sm"><div>{k}</div><input className="w-full bg-slate-700 rounded px-2 py-1" type="number" value={m[k]} onChange={(e) => setDraftConfig((c) => { const mapElements = [...c.mapElements]; mapElements[idx] = { ...mapElements[idx], [k]: Number(e.target.value) || 0 }; return { ...c, mapElements }; })} /></label>
                  ))}
                  <button className="px-3 py-1.5 rounded bg-rose-700" onClick={() => setDraftConfig((c) => ({ ...c, mapElements: c.mapElements.filter((_, i) => i !== idx) }))}>Remove</button>
                </div>
              ))}
            </div>
          )}

          {tab === "units" && (
            <div className="space-y-3">
              <button
                className="px-3 py-2 rounded bg-emerald-700"
                onClick={() => {
                  const id = `unit_${Date.now()}`;
                  setDraftConfig((c) => ({
                    ...c,
                    unitTypes: [...c.unitTypes, { id, name: "New Unit", color: "#f8fafc", radius: 12, maxHp: 100, moveSpeed: 90, attackDamage: 10, attackRange: 30, attackCooldown: 0.8, aggroRange: 300, knockback: 80, contactDamage: 0, defense: 0, attackType: "normal", punchMultiplier: 1.7, projectile: null, ai: { behavior: "aggressive", preferredDistance: 20, focusLowestHp: false, avoidStrongerEnemies: false, bravery: 1 } }],
                    units: [...c.units, { id: `deploy_${id}`, unitTypeId: id, team: "New", x: 200, y: 200, count: 2, spread: 20 }],
                  }));
                }}
              >
                Add Unit Template
              </button>

              {draftConfig.unitTypes.map((u, idx) => {
                const deploy = draftConfig.units.find((d) => d.unitTypeId === u.id);
                return (
                  <div key={u.id} className="bg-slate-800 rounded-xl p-3">
                    <div className="flex justify-between items-center mb-2">
                      <div className="font-semibold">{u.id}</div>
                      <button className="px-2 py-1 rounded bg-rose-700" onClick={() => setDraftConfig((c) => ({ ...c, unitTypes: c.unitTypes.filter((x) => x.id !== u.id), units: c.units.filter((d) => d.unitTypeId !== u.id) }))}>Remove Unit Template</button>
                    </div>
                    <div className="grid grid-cols-2 md:grid-cols-6 gap-2">
                      <label className="text-sm"><div>name</div><input className="w-full bg-slate-700 rounded px-2 py-1" value={u.name} onChange={(e) => updateUnitTypeField(idx, "name", e.target.value)} /></label>
                      <label className="text-sm"><div>color</div><input className="w-full bg-slate-700 rounded px-2 py-1" value={u.color} onChange={(e) => updateUnitTypeField(idx, "color", e.target.value)} /></label>
                      <label className="text-sm"><div>picker</div><input className="w-full h-9 bg-slate-700 rounded px-1 py-1" type="color" value={u.color} onChange={(e) => updateUnitTypeField(idx, "color", e.target.value)} /></label>
                      <label className="text-sm"><div>team</div><input className="w-full bg-slate-700 rounded px-2 py-1" value={deploy?.team || ""} onChange={(e) => updateDeploymentField(u.id, "team", e.target.value)} /></label>
                      {([
                        ["count", deploy?.count ?? 0, (v: number) => updateDeploymentField(u.id, "count", v)],
                        ["HP", u.maxHp, (v: number) => updateUnitTypeField(idx, "maxHp", v)],
                        ["speed", u.moveSpeed, (v: number) => updateUnitTypeField(idx, "moveSpeed", v)],
                        ["attack", u.attackDamage, (v: number) => updateUnitTypeField(idx, "attackDamage", v)],
                        ["range", u.attackRange, (v: number) => updateUnitTypeField(idx, "attackRange", v)],
                        ["cooldown", u.attackCooldown, (v: number) => updateUnitTypeField(idx, "attackCooldown", v)],
                        ["defense", u.defense, (v: number) => updateUnitTypeField(idx, "defense", v)],
                        ["radius", u.radius, (v: number) => updateUnitTypeField(idx, "radius", v)],
                        ["spread", deploy?.spread ?? 0, (v: number) => updateDeploymentField(u.id, "spread", v)],
                        ["pos X", deploy?.x ?? 0, (v: number) => updateDeploymentField(u.id, "x", v)],
                        ["pos Y", deploy?.y ?? 0, (v: number) => updateDeploymentField(u.id, "y", v)],
                        ["knockback", u.knockback, (v: number) => updateUnitTypeField(idx, "knockback", v)],
                        ["preferred", u.ai.preferredDistance, (v: number) => updateUnitAIField(idx, "preferredDistance", v)],
                        ["aggro", u.aggroRange, (v: number) => updateUnitTypeField(idx, "aggroRange", v)],
                        ["bravery", u.ai.bravery, (v: number) => updateUnitAIField(idx, "bravery", v)],
                      ] as const).map(([label, value, setter]) => (
                        <label key={label} className="text-sm"><div>{label}</div><input className="w-full bg-slate-700 rounded px-2 py-1" type="number" value={value} onChange={(e) => setter(Number(e.target.value) || 0)} /></label>
                      ))}

                      <label className="text-sm"><div>Attack type</div><select className="w-full bg-slate-700 rounded px-2 py-1" value={u.attackType} onChange={(e) => updateUnitTypeField(idx, "attackType", e.target.value as UnitType["attackType"])}><option value="normal">normal</option><option value="punch">punch</option></select></label>
                      <label className="text-sm"><div>Punch multiplier</div><input className="w-full bg-slate-700 rounded px-2 py-1" type="number" value={u.punchMultiplier} onChange={(e) => updateUnitTypeField(idx, "punchMultiplier", Number(e.target.value) || 0)} /></label>
                      <label className="text-sm"><div>AI behavior</div><select className="w-full bg-slate-700 rounded px-2 py-1" value={u.ai.behavior} onChange={(e) => updateUnitAIField(idx, "behavior", e.target.value as AIBehavior)}><option value="aggressive">aggressive</option><option value="kite">kite</option><option value="opportunist">opportunist</option></select></label>
                      <label className="text-sm"><div>focusLowestHp</div><input type="checkbox" checked={u.ai.focusLowestHp} onChange={(e) => updateUnitAIField(idx, "focusLowestHp", e.target.checked)} /></label>
                      <label className="text-sm"><div>avoidStrongerEnemies</div><input type="checkbox" checked={u.ai.avoidStrongerEnemies} onChange={(e) => updateUnitAIField(idx, "avoidStrongerEnemies", e.target.checked)} /></label>

                      <label className="text-sm col-span-2"><div>Projectile enable</div><input type="checkbox" checked={!!u.projectile} onChange={(e) => updateUnitTypeField(idx, "projectile", e.target.checked ? { type: "normal", speed: 220, radius: 4, life: 2, color: u.color, homing: 0, pierceCount: 1, explosionRadius: 70 } : null)} /></label>
                      {u.projectile && (
                        <>
                          <label className="text-sm"><div>projectile type</div><select className="w-full bg-slate-700 rounded px-2 py-1" value={u.projectile.type} onChange={(e) => updateProjectileField(idx, "type", e.target.value as ProjectileConfig["type"])}><option value="normal">normal</option><option value="pierce">pierce</option><option value="explosive">explosive</option></select></label>
                          <label className="text-sm"><div>projectile speed</div><input className="w-full bg-slate-700 rounded px-2 py-1" type="number" value={u.projectile.speed} onChange={(e) => updateProjectileField(idx, "speed", Number(e.target.value) || 0)} /></label>
                          <label className="text-sm"><div>projectile radius</div><input className="w-full bg-slate-700 rounded px-2 py-1" type="number" value={u.projectile.radius} onChange={(e) => updateProjectileField(idx, "radius", Number(e.target.value) || 0)} /></label>
                          <label className="text-sm"><div>projectile life</div><input className="w-full bg-slate-700 rounded px-2 py-1" type="number" value={u.projectile.life} onChange={(e) => updateProjectileField(idx, "life", Number(e.target.value) || 0)} /></label>
                          <label className="text-sm"><div>projectile homing</div><input className="w-full bg-slate-700 rounded px-2 py-1" type="number" value={u.projectile.homing} onChange={(e) => updateProjectileField(idx, "homing", Number(e.target.value) || 0)} /></label>
                          <label className="text-sm"><div>pierce count</div><input className="w-full bg-slate-700 rounded px-2 py-1" type="number" value={u.projectile.pierceCount} onChange={(e) => updateProjectileField(idx, "pierceCount", Number(e.target.value) || 0)} /></label>
                          <label className="text-sm"><div>explosion radius</div><input className="w-full bg-slate-700 rounded px-2 py-1" type="number" value={u.projectile.explosionRadius} onChange={(e) => updateProjectileField(idx, "explosionRadius", Number(e.target.value) || 0)} /></label>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}