// Client for the duel (1v1 online) server — see server/src/protocol.ts,
// which this mirrors by hand (no shared package between the two apps).
//
// The server is just a matchmaking queue + relay: it does not validate
// hits or run physics. Each client stays authoritative over its own
// health (applies damage to itself when told it got hit, then reports
// the resulting value back) and over its own shot raycasts, reusing the
// same flat-20-damage-per-hit rule the existing bot combat already uses.
// That's enough for a trusted 1v1 between two people, not hardened
// against a cheating client.

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

export type DuelStatus = "idle" | "connecting" | "queued" | "matched" | "opponent_left" | "error";

export interface DuelCallbacks {
  onStatusChange?: (status: DuelStatus) => void;
  // Fires with the code we're waiting in, only when queued via a room
  // code (see connect()) — undefined for anonymous quick-match.
  onQueued?: (roomCode?: string) => void;
  onMatched?: (isPlayerOne: boolean) => void;
  onOpponentState?: (position: Vec3, quaternion: Quat, moving: boolean) => void;
  onOpponentShot?: (from: Vec3, to: Vec3) => void;
  onDamage?: () => void;
  onOpponentHealth?: (health: number) => void;
  onOpponentLeft?: () => void;
}

// Same-origin dev convenience: the client and duel server run on different
// ports locally, so default to localhost:8787 unless overridden at build
// time (VITE_DUEL_SERVER_URL) for a real deployment.
const DEFAULT_URL = "ws://localhost:8787";

export class DuelConnection {
  private socket: WebSocket | null = null;
  private callbacks: DuelCallbacks;
  private url: string;

  constructor(callbacks: DuelCallbacks = {}, url: string = import.meta.env.VITE_DUEL_SERVER_URL || DEFAULT_URL) {
    this.callbacks = callbacks;
    this.url = url;
  }

  // roomCode: join/wait for a specific private match instead of anonymous
  // quick-match. Both players must pass the same code.
  connect(roomCode?: string) {
    if (this.socket) return;
    this.callbacks.onStatusChange?.("connecting");
    const socket = new WebSocket(this.url);
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.send({ type: "find_match", roomCode });
    });

    socket.addEventListener("message", (event) => {
      this.handleMessage(event.data);
    });

    socket.addEventListener("close", () => {
      this.socket = null;
    });

    socket.addEventListener("error", () => {
      this.callbacks.onStatusChange?.("error");
    });
  }

  private handleMessage(raw: string) {
    let msg: {
      type: string;
      isPlayerOne?: boolean;
      position?: Vec3;
      quaternion?: Quat;
      moving?: boolean;
      from?: Vec3;
      to?: Vec3;
      health?: number;
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
        this.callbacks.onMatched?.(!!msg.isPlayerOne);
        break;
      case "opponent_state":
        if (msg.position && msg.quaternion) {
          this.callbacks.onOpponentState?.(msg.position, msg.quaternion, !!msg.moving);
        }
        break;
      case "opponent_shot":
        if (msg.from && msg.to) this.callbacks.onOpponentShot?.(msg.from, msg.to);
        break;
      case "damage":
        this.callbacks.onDamage?.();
        break;
      case "opponent_health":
        if (typeof msg.health === "number") this.callbacks.onOpponentHealth?.(msg.health);
        break;
      case "opponent_left":
        this.callbacks.onStatusChange?.("opponent_left");
        this.callbacks.onOpponentLeft?.();
        break;
    }
  }

  private send(message: unknown) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }

  sendState(position: Vec3, quaternion: Quat, moving: boolean) {
    this.send({ type: "state", position, quaternion, moving });
  }

  sendShot(from: Vec3, to: Vec3) {
    this.send({ type: "shoot", from, to });
  }

  sendHit() {
    this.send({ type: "hit" });
  }

  sendHealth(health: number) {
    this.send({ type: "health", health });
  }

  disconnect() {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.send({ type: "leave" });
      this.socket.close();
    }
    this.socket = null;
  }
}
