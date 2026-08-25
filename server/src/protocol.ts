// Wire protocol shared conceptually with the client's src/network.ts (kept
// in sync by hand — no shared package, this project is small enough that a
// monorepo/workspace split isn't worth the added tooling).
//
// The server is authoritative for 1v1 combat: it owns both players' health,
// kills/deaths/headshots, and the match timer. A shooter's client still does
// its own raycast (same as it always has) and reports "I hit my opponent,
// here's whether it was a headshot" — but the SERVER decides the resulting
// damage, whether that's a kill, and when the match ends. This closes the
// original "each client just trusts what it's told" gap without needing a
// full server-side physics simulation.

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

export interface PlayerStats {
  kills: number;
  deaths: number;
  headshots: number;
}

export const BASE_DAMAGE = 20;
export const HEADSHOT_MULTIPLIER = 2.5; // tune here — one constant, easy to rebalance
export const DEFAULT_KILL_LIMIT = 20;
export const DEFAULT_TIME_LIMIT_SECONDS = 300; // 5 min
export const RESPAWN_DELAY_MS = 2500;

// Custom kill/time limits are only honored for room-code matches (two
// friends who explicitly agreed to play each other) — an anonymous
// quick-match stranger shouldn't be able to force e.g. a 1-kill instant
// match on whoever they're paired with. Clamped server-side either way
// since the client value is just a request, never trusted outright.
export const MIN_KILL_LIMIT = 1;
export const MAX_KILL_LIMIT = 100;
export const MIN_TIME_LIMIT_SECONDS = 30;
export const MAX_TIME_LIMIT_SECONDS = 3600;

// Number of verified-safe spawn pairs (see App.tsx's DUEL_SPAWN_PAIRS,
// hand-mirrored here) the server can pick between for match start and
// every respawn, so both players aren't always placed at the exact same
// two spots. Keep this equal to DUEL_SPAWN_PAIRS.length on the client.
export const DUEL_SPAWN_PAIR_COUNT = 6;

export type ClientMessage =
  | { type: "find_match"; roomCode?: string; killLimit?: number; timeLimitSeconds?: number }
  | { type: "state"; position: Vec3; quaternion: Quat; moving: boolean }
  | { type: "shoot"; from: Vec3; to: Vec3 }
  | { type: "hit"; headshot: boolean }
  | { type: "leave" };

export type MatchEndReason = "killLimit" | "timeLimit" | "opponentDisconnected";

export type ServerMessage =
  | { type: "queued"; roomCode?: string }
  | { type: "matched"; isPlayerOne: boolean; killLimit: number; timeLimitSeconds: number; spawnIndex: number }
  | { type: "opponent_state"; position: Vec3; quaternion: Quat; moving: boolean }
  | { type: "opponent_shot"; from: Vec3; to: Vec3 }
  // Sent to the shooter right after a hit lands.
  | {
      type: "hit_result";
      headshot: boolean;
      damage: number;
      killed: boolean;
      yourStats: PlayerStats;
      opponentStats: PlayerStats;
      opponentHealth: number;
    }
  // Sent to the player who got hit.
  | {
      type: "damaged";
      headshot: boolean;
      damage: number;
      health: number;
      yourStats: PlayerStats;
      opponentStats: PlayerStats;
    }
  // Sent to both players a fixed delay after a non-match-ending kill —
  // the dead player is back up at full health at their spawn. spawnIndex
  // picks a fresh (possibly different) spawn pair for this respawn.
  | { type: "respawn"; forYou: boolean; spawnIndex: number }
  | { type: "timer"; remaining: number }
  | {
      type: "match_ended";
      result: "won" | "lost" | "draw";
      reason: MatchEndReason;
      yourStats: PlayerStats;
      opponentStats: PlayerStats;
    }
  | { type: "error"; message: string };
