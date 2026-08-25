import * as THREE from "three";

export type GameMode = "ffa" | "tdm" | "duel";
export type Team = "friendly" | "enemy";

export const SCORE_LIMIT_OPTIONS = [0, 15, 30, 50] as const;
export const TIME_LIMIT_OPTIONS = [0, 300, 600, 900] as const; // seconds; 0 = no limit

// Sane per-mode defaults for a fresh match — 0 ("No Limit") stays available
// as an explicit choice in SCORE_LIMIT_OPTIONS/TIME_LIMIT_OPTIONS, but a
// brand-new match shouldn't default to unlimited.
export const DEFAULT_TIME_LIMIT = 600; // 10 min
export function defaultKillLimit(mode: GameMode): number {
  return mode === "tdm" ? 50 : 30;
}

export type MatchEndReason = "killLimit" | "timeLimit" | "eliminated" | "defeated" | null;

export function formatMatchEndReason(reason: MatchEndReason): string {
  switch (reason) {
    case "killLimit":
      return "Kill Limit Reached";
    case "timeLimit":
      return "Time Limit Reached";
    case "eliminated":
      return "All Enemies Eliminated";
    case "defeated":
      return "You Were Eliminated";
    default:
      return "";
  }
}

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
