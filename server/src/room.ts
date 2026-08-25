import { WebSocket } from "ws";
import {
  BASE_DAMAGE,
  HEADSHOT_MULTIPLIER,
  DEFAULT_KILL_LIMIT,
  DEFAULT_TIME_LIMIT_SECONDS,
  RESPAWN_DELAY_MS,
  MIN_KILL_LIMIT,
  MAX_KILL_LIMIT,
  MIN_TIME_LIMIT_SECONDS,
  MAX_TIME_LIMIT_SECONDS,
  DUEL_SPAWN_PAIR_COUNT,
  type PlayerStats,
  type ServerMessage,
  type MatchEndReason,
} from "./protocol.js";

export interface RoomSettings {
  killLimit?: number;
  timeLimitSeconds?: number;
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function randomSpawnIndex(): number {
  return Math.floor(Math.random() * DUEL_SPAWN_PAIR_COUNT);
}

export interface RoomPlayer {
  id: number;
  socket: WebSocket;
}

function send(socket: WebSocket, message: ServerMessage) {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(message));
}

interface Combatant {
  player: RoomPlayer;
  stats: PlayerStats;
  health: number;
  alive: boolean;
}

// Owns one 1v1 match end-to-end: both players' health/kills/deaths/
// headshots, the countdown timer, and the win-condition check. Created once
// two players are paired (see index.ts's pairUp) and torn down when the
// match ends for any reason.
export class Room {
  private a: Combatant;
  private b: Combatant;
  private killLimit: number;
  private timeRemaining: number;
  private ended = false;
  private timer: ReturnType<typeof setInterval>;
  private onEnded: () => void;

  constructor(playerA: RoomPlayer, playerB: RoomPlayer, onEnded: () => void, settings: RoomSettings = {}) {
    this.onEnded = onEnded;
    this.killLimit = clampInt(settings.killLimit, DEFAULT_KILL_LIMIT, MIN_KILL_LIMIT, MAX_KILL_LIMIT);
    this.timeRemaining = clampInt(
      settings.timeLimitSeconds,
      DEFAULT_TIME_LIMIT_SECONDS,
      MIN_TIME_LIMIT_SECONDS,
      MAX_TIME_LIMIT_SECONDS
    );
    this.a = { player: playerA, stats: { kills: 0, deaths: 0, headshots: 0 }, health: 100, alive: true };
    this.b = { player: playerB, stats: { kills: 0, deaths: 0, headshots: 0 }, health: 100, alive: true };

    const spawnIndex = randomSpawnIndex();
    const matchedMsg = (isPlayerOne: boolean) =>
      ({
        type: "matched",
        isPlayerOne,
        killLimit: this.killLimit,
        timeLimitSeconds: this.timeRemaining,
        spawnIndex,
      }) as const;
    send(this.a.player.socket, matchedMsg(true));
    send(this.b.player.socket, matchedMsg(false));

    this.timer = setInterval(() => this.tick(), 1000);
  }

  hasPlayer(playerId: number): boolean {
    return this.a.player.id === playerId || this.b.player.id === playerId;
  }

  private other(id: number): Combatant {
    return this.a.player.id === id ? this.b : this.a;
  }

  private self(id: number): Combatant {
    return this.a.player.id === id ? this.a : this.b;
  }

  private tick() {
    if (this.ended) return;
    this.timeRemaining -= 1;
    send(this.a.player.socket, { type: "timer", remaining: this.timeRemaining });
    send(this.b.player.socket, { type: "timer", remaining: this.timeRemaining });

    if (this.timeRemaining <= 0) {
      if (this.a.stats.kills === this.b.stats.kills) {
        this.finish(null, "timeLimit");
      } else {
        this.finish(this.a.stats.kills > this.b.stats.kills ? this.a : this.b, "timeLimit");
      }
    }
  }

  // shooterId reports a hit they scored on their opponent. Server decides
  // the damage and whether it's a kill — the client only claims "I hit them
  // and here's whether it looked like a headshot from my raycast."
  registerHit(shooterId: number, headshot: boolean) {
    if (this.ended) return;
    const shooter = this.self(shooterId);
    const defender = this.other(shooterId);
    if (!defender.alive) return; // already dead from a hit processed earlier this tick

    const damage = headshot ? Math.round(BASE_DAMAGE * HEADSHOT_MULTIPLIER) : BASE_DAMAGE;
    defender.health = Math.max(0, defender.health - damage);
    const killed = defender.health <= 0;

    if (headshot) shooter.stats.headshots += 1;
    if (killed) {
      defender.alive = false;
      shooter.stats.kills += 1;
      defender.stats.deaths += 1;
    }

    send(shooter.player.socket, {
      type: "hit_result",
      headshot,
      damage,
      killed,
      yourStats: shooter.stats,
      opponentStats: defender.stats,
      opponentHealth: defender.health,
    });
    send(defender.player.socket, {
      type: "damaged",
      headshot,
      damage,
      health: defender.health,
      yourStats: defender.stats,
      opponentStats: shooter.stats,
    });

    if (killed) {
      if (shooter.stats.kills >= this.killLimit) {
        this.finish(shooter, "killLimit");
      } else {
        this.scheduleRespawn(defender);
      }
    }
  }

  private scheduleRespawn(combatant: Combatant) {
    setTimeout(() => {
      if (this.ended) return;
      combatant.health = 100;
      combatant.alive = true;
      const spawnIndex = randomSpawnIndex();
      send(this.a.player.socket, { type: "respawn", forYou: combatant === this.a, spawnIndex });
      send(this.b.player.socket, { type: "respawn", forYou: combatant === this.b, spawnIndex });
    }, RESPAWN_DELAY_MS);
  }

  // Called when a player disconnects mid-match — the remaining player wins
  // by default, distinct from a real killLimit/timeLimit win.
  handleDisconnect(playerId: number) {
    if (this.ended) return;
    const remaining = this.other(playerId);
    this.finish(remaining, "opponentDisconnected");
  }

  private finish(winner: Combatant | null, reason: MatchEndReason) {
    if (this.ended) return;
    this.ended = true;
    clearInterval(this.timer);
    this.onEnded();

    const resultFor = (c: Combatant): "won" | "lost" | "draw" =>
      winner === null ? "draw" : winner === c ? "won" : "lost";

    send(this.a.player.socket, {
      type: "match_ended",
      result: resultFor(this.a),
      reason,
      yourStats: this.a.stats,
      opponentStats: this.b.stats,
    });
    send(this.b.player.socket, {
      type: "match_ended",
      result: resultFor(this.b),
      reason,
      yourStats: this.b.stats,
      opponentStats: this.a.stats,
    });
  }

  destroy() {
    clearInterval(this.timer);
  }
}
