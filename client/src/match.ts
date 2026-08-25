import * as THREE from "three";

export type GameMode = "ffa" | "tdm";
export type Team = "friendly" | "enemy";

export const SCORE_LIMIT_OPTIONS = [0, 10, 20, 30] as const;
export const TIME_LIMIT_OPTIONS = [0, 180, 300, 600] as const; // seconds; 0 = no limit

export function formatTimeLimit(seconds: number): string {
  if (seconds === 0) return "No Limit";
  const m = Math.round(seconds / 60);
  return `${m} min`;
}

export function formatScoreLimit(n: number): string {
  return n === 0 ? "No Limit" : `${n} Kills`;
}

// A lightweight shared registry so bots can find and attack the nearest
// opposing-team combatant — the player, or another bot — without every
// bot scanning the whole scene graph each frame. Entries are mutated in
// place (position/alive) rather than replaced, so updating them every
// frame doesn't trigger React re-renders or allocate garbage.
export interface Combatant {
  id: string;
  team: Team;
  position: THREE.Vector3;
  alive: boolean;
  damage: (amount: number) => void;
}

export type CombatantRegistry = Map<string, Combatant>;

export function findNearestOpponent(
  registry: CombatantRegistry,
  myTeam: Team,
  myPos: THREE.Vector3
): Combatant | null {
  let nearest: Combatant | null = null;
  let nearestDistSq = Infinity;
  registry.forEach((c) => {
    if (c.team === myTeam || !c.alive) return;
    const distSq = c.position.distanceToSquared(myPos);
    if (distSq < nearestDistSq) {
      nearestDistSq = distSq;
      nearest = c;
    }
  });
  return nearest;
}
