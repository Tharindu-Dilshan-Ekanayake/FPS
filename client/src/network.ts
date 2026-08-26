// Client for the duel (1v1 online) server — see server/src/protocol.ts,
// which this mirrors by hand (no shared package between the two apps).
//
// The server is authoritative for combat: it owns both players' health,
// kills/deaths/headshots, and the match timer. This client still does its
// own raycast (same mechanism as hitting a bot) and reports "I hit my
// opponent, headshot: true/false" — the server decides the resulting
// damage/kill and tells both sides what happened. The client no longer
// self-reports its own health.

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

export interface PlayerStats {
  kills: number;
  deaths: number;
  headshots: number;
}

export type DuelStatus = "idle" | "connecting" | "queued" | "matched" | "error";
export type MatchEndReason = "killLimit" | "timeLimit" | "opponentDisconnected";
export type MatchResult = "won" | "lost" | "draw";

export interface DuelCallbacks {
  onStatusChange?: (status: DuelStatus) => void;
  // Fires with the code we're waiting in, only when queued via a room
  // code (see connect()) — undefined for anonymous quick-match.
  onQueued?: (roomCode?: string) => void;
  onMatched?: (isPlayerOne: boolean, killLimit: number, timeLimitSeconds: number, spawnIndex: number) => void;
  onOpponentState?: (position: Vec3, quaternion: Quat, moving: boolean) => void;
  onOpponentShot?: (from: Vec3, to: Vec3) => void;
  // We landed a hit on the opponent.
  onHitResult?: (headshot: boolean, damage: number, killed: boolean, yourStats: PlayerStats, opponentStats: PlayerStats, opponentHealth: number) => void;
  // The opponent hit us.
  onDamaged?: (headshot: boolean, damage: number, health: number, yourStats: PlayerStats, opponentStats: PlayerStats) => void;
  // A dead player (us or them) is back up at full health at their spawn.
  // spawnIndex picks which of the verified-safe spawn pairs to use.
  onRespawn?: (forYou: boolean, spawnIndex: number) => void;
  onTimer?: (remaining: number) => void;
  onMatchEnded?: (result: MatchResult, reason: MatchEndReason, yourStats: PlayerStats, opponentStats: PlayerStats) => void;
}

// Same-origin dev convenience: the client and duel server run on different
// ports locally, so default to localhost:8787 unless overridden at build
// time (VITE_DUEL_SERVER_URL) for a real deployment.
const DEFAULT_URL = "ws://localhost:8787";

function round(n: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}
function roundVec3(v: Vec3): Vec3 {
  return [round(v[0], 3), round(v[1], 3), round(v[2], 3)];
}
function roundQuat(q: Quat): Quat {
  return [round(q[0], 4), round(q[1], 4), round(q[2], 4), round(q[3], 4)];
}

export class DuelConnection {
  private socket: WebSocket | null = null;
  private callbacks: DuelCallbacks;
  private url: string;

  constructor(callbacks: DuelCallbacks = {}, url: string = import.meta.env.VITE_DUEL_SERVER_URL || DEFAULT_URL) {
    this.callbacks = callbacks;
    this.url = url;
  }

  // roomCode: join/wait for a specific private match instead of anonymous
  // quick-match. Both players must pass the same code. killLimit/
  // timeLimitSeconds are only honored server-side when creating a NEW
  // room code (ignored for anonymous quick-match, and ignored if you're
  // joining a code someone else already opened — see server/src/index.ts).
  connect(roomCode?: string, killLimit?: number, timeLimitSeconds?: number) {
    if (this.socket) return;
    this.callbacks.onStatusChange?.("connecting");
    const socket = new WebSocket(this.url);
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.send({ type: "find_match", roomCode, killLimit, timeLimitSeconds });
    });

    socket.addEventListener("message", (event) => {
      this.handleMessage(event.data);
    });

    socket.addEventListener("close", () => {
      // disconnect() (a deliberate leave) already nulls out this.socket
      // synchronously before the actual close event arrives, so if it's
      // still pointing at this exact socket here, nothing intentional
      // caused this — a flaky connection dropped out from under the
      // player mid-queue or mid-match. Without surfacing that, they'd be
      // left staring at a frozen "Searching…"/match screen forever with
      // no sign anything went wrong or way to retry.
      const wasIntentional = this.socket !== socket;
      this.socket = null;
      if (!wasIntentional) {
        this.callbacks.onStatusChange?.("error");
      }
    });

    socket.addEventListener("error", () => {
      this.callbacks.onStatusChange?.("error");
    });
  }

  private handleMessage(raw: string) {
    let msg: {
      type: string;
      isPlayerOne?: boolean;
      killLimit?: number;
      timeLimitSeconds?: number;
      spawnIndex?: number;
      position?: Vec3;
      quaternion?: Quat;
      moving?: boolean;
      from?: Vec3;
      to?: Vec3;
      headshot?: boolean;
      damage?: number;
      killed?: boolean;
      health?: number;
      forYou?: boolean;
      remaining?: number;
      result?: MatchResult;
      reason?: MatchEndReason;
      yourStats?: PlayerStats;
      opponentStats?: PlayerStats;
      opponentHealth?: number;
      roomCode?: string;
    };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    switch (msg.type) {
      case "queued":
        this.callbacks.onStatusChange?.("queued");
        this.callbacks.onQueued?.(msg.roomCode);
        break;
      case "matched":
        this.callbacks.onStatusChange?.("matched");
        if (
          typeof msg.killLimit === "number" &&
          typeof msg.timeLimitSeconds === "number" &&
          typeof msg.spawnIndex === "number"
        ) {
          this.callbacks.onMatched?.(!!msg.isPlayerOne, msg.killLimit, msg.timeLimitSeconds, msg.spawnIndex);
        }
        break;
      case "opponent_state":
        if (msg.position && msg.quaternion) {
          this.callbacks.onOpponentState?.(msg.position, msg.quaternion, !!msg.moving);
        }
        break;
      case "opponent_shot":
        if (msg.from && msg.to) this.callbacks.onOpponentShot?.(msg.from, msg.to);
        break;
      case "hit_result":
        if (msg.yourStats && msg.opponentStats && typeof msg.opponentHealth === "number") {
          this.callbacks.onHitResult?.(!!msg.headshot, msg.damage ?? 0, !!msg.killed, msg.yourStats, msg.opponentStats, msg.opponentHealth);
        }
        break;
      case "damaged":
        if (msg.yourStats && msg.opponentStats && typeof msg.health === "number") {
          this.callbacks.onDamaged?.(!!msg.headshot, msg.damage ?? 0, msg.health, msg.yourStats, msg.opponentStats);
        }
        break;
      case "respawn":
        if (typeof msg.spawnIndex === "number") {
          this.callbacks.onRespawn?.(!!msg.forYou, msg.spawnIndex);
        }
        break;
      case "timer":
        if (typeof msg.remaining === "number") this.callbacks.onTimer?.(msg.remaining);
        break;
      case "match_ended":
        if (msg.result && msg.reason && msg.yourStats && msg.opponentStats) {
          this.callbacks.onMatchEnded?.(msg.result, msg.reason, msg.yourStats, msg.opponentStats);
        }
        break;
    }
  }

  private send(message: unknown) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }

  sendState(position: Vec3, quaternion: Quat, moving: boolean) {
    // Rounded to keep the JSON payload compact — this is a text protocol
    // (not a packed binary one) so there's no fixed byte budget to hit,
    // but full float64 precision (~17 significant digits) buys nothing
    // for a value that's about to be damp()-interpolated on the other end
    // anyway, and it roughly halves the digits sent per number.
    this.send({ type: "state", position: roundVec3(position), quaternion: roundQuat(quaternion), moving });
  }

  sendShot(from: Vec3, to: Vec3) {
    this.send({ type: "shoot", from, to });
  }

  sendHit(headshot: boolean) {
    this.send({ type: "hit", headshot });
  }

  disconnect() {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.send({ type: "leave" });
      this.socket.close();
    }
    this.socket = null;
  }
}
