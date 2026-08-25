// Wire protocol shared conceptually with the client's src/network.ts (kept
// in sync by hand — no shared package, this project is small enough that a
// monorepo/workspace split isn't worth the added tooling).
//
// Design: the server is just a matchmaking queue + a 1:1 relay between the
// two players in a room. It does not run authoritative physics or validate
// hits — each client stays authoritative over its OWN health (applies
// damage to itself when told it got hit, then reports the new value back)
// and over its OWN shot raycasts (same rule the existing bot combat already
// uses: a hit is a flat 20 damage). That's enough for a trusted 1v1 between
// two people; it is not hardened against a cheating client.

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

export type ClientMessage =
  | { type: "find_match"; roomCode?: string }
  | { type: "state"; position: Vec3; quaternion: Quat; moving: boolean }
  | { type: "shoot"; from: Vec3; to: Vec3 }
  | { type: "hit" }
  | { type: "health"; health: number }
  | { type: "leave" };

export type ServerMessage =
  | { type: "queued"; roomCode?: string }
  | { type: "matched"; isPlayerOne: boolean }
  | { type: "opponent_state"; position: Vec3; quaternion: Quat; moving: boolean }
  | { type: "opponent_shot"; from: Vec3; to: Vec3 }
  | { type: "damage" }
  | { type: "opponent_health"; health: number }
  | { type: "opponent_left" }
  | { type: "error"; message: string };
