import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type { ClientMessage, ServerMessage } from "./protocol.js";
import { Room, type RoomSettings } from "./room.js";

const PORT = Number(process.env.PORT) || 8787;

interface Player {
  id: number;
  socket: WebSocket;
  opponent: Player | null; // lightweight relay target for state/shoot only
  room: Room | null; // authoritative combat/timer/win-condition state
  isAlive: boolean;
}

// A player waiting under a private room code, plus the kill/time limits
// they asked for. Only code-based matches honor custom settings — two
// friends sharing a code explicitly agreed to them, whereas an anonymous
// quick-match stranger shouldn't be able to impose e.g. a 1-kill match on
// whoever they get paired with (Room clamps these either way, but this is
// the "do we even look at the client's request" gate).
interface WaitingInCode {
  player: Player;
  settings: RoomSettings;
}

let nextPlayerId = 1;
const queue: Player[] = []; // anonymous quick-match
const codeRooms = new Map<string, WaitingInCode>(); // roomCode -> player waiting in it
const players = new Map<WebSocket, Player>();

function send(socket: WebSocket, message: ServerMessage) {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(message));
}

function removeFromWaiting(player: Player) {
  const idx = queue.indexOf(player);
  if (idx !== -1) queue.splice(idx, 1);
  for (const [code, waiting] of codeRooms) {
    if (waiting.player === player) codeRooms.delete(code);
  }
}

function pairUp(player: Player, waiting: Player, settings: RoomSettings = {}) {
  player.opponent = waiting;
  waiting.opponent = player;

  // Deterministic by id so both clients agree on who spawns where.
  const playerIsOne = player.id < waiting.id;
  const [one, two] = playerIsOne ? [player, waiting] : [waiting, player];

  const room = new Room(
    { id: one.id, socket: one.socket },
    { id: two.id, socket: two.socket },
    () => {
      // Match over (any reason) — clear both sides so either can queue for
      // a new match/rematch without being treated as "still in a match".
      player.opponent = null;
      player.room = null;
      waiting.opponent = null;
      waiting.room = null;
    },
    settings
  );
  player.room = room;
  waiting.room = room;
}

function handleFindMatch(player: Player, roomCode?: string, killLimit?: number, timeLimitSeconds?: number) {
  if (player.room) return; // already in an active match
  removeFromWaiting(player);

  const code = roomCode?.trim().toUpperCase();

  if (code) {
    const waiting = codeRooms.get(code);
    // A dead/expired entry left under this code shouldn't block a fresh
    // pairing — same reasoning as the quick-match queue below.
    if (waiting && waiting.player.socket.readyState === WebSocket.OPEN && waiting.player !== player) {
      codeRooms.delete(code);
      // The player who was already WAITING in this code chose the match
      // settings — the joiner's own selection (if any) is ignored, same
      // as arriving at a friend's already-configured lobby.
      pairUp(player, waiting.player, waiting.settings);
    } else {
      codeRooms.set(code, { player, settings: { killLimit, timeLimitSeconds } });
      send(player.socket, { type: "queued", roomCode: code });
    }
    return;
  }

  // Skip anyone still sitting in the queue with a socket that's already
  // gone — a connection that dropped without a clean close (crashed tab,
  // network cut) would otherwise silently "match" a live player with a
  // dead one, and neither the state/shoot/hit relay nor anything else
  // would ever reach them again.
  let waiting = queue.shift();
  while (waiting && waiting.socket.readyState !== WebSocket.OPEN) {
    waiting = queue.shift();
  }
  if (!waiting) {
    queue.push(player);
    send(player.socket, { type: "queued" });
    return;
  }

  // Anonymous quick-match always uses defaults — see WaitingInCode comment.
  pairUp(player, waiting);
}

function handleLeave(player: Player) {
  removeFromWaiting(player);
  player.room?.handleDisconnect(player.id);
  player.opponent = null;
  player.room = null;
}

function handleMessage(player: Player, raw: string) {
  let msg: ClientMessage;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }

  switch (msg.type) {
    case "find_match":
      handleFindMatch(player, msg.roomCode, msg.killLimit, msg.timeLimitSeconds);
      break;
    case "state": {
      const opponent = player.opponent;
      if (!opponent) return;
      send(opponent.socket, {
        type: "opponent_state",
        position: msg.position,
        quaternion: msg.quaternion,
        moving: msg.moving,
      });
      break;
    }
    case "shoot": {
      const opponent = player.opponent;
      if (!opponent) return;
      send(opponent.socket, { type: "opponent_shot", from: msg.from, to: msg.to });
      break;
    }
    case "hit":
      player.room?.registerHit(player.id, msg.headshot);
      break;
    case "leave":
      handleLeave(player);
      break;
  }
}

const httpServer = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("gunXor duel server is running\n");
});

const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (socket) => {
  const player: Player = { id: nextPlayerId++, socket, opponent: null, room: null, isAlive: true };
  players.set(socket, player);

  socket.on("message", (data) => handleMessage(player, data.toString()));
  socket.on("pong", () => {
    player.isAlive = true;
  });

  const cleanup = () => {
    handleLeave(player);
    players.delete(socket);
  };
  socket.on("close", cleanup);
  socket.on("error", cleanup);
});

// A closed TCP connection doesn't always fire a clean 'close' event (a
// crashed tab or a network drop can leave a socket that looks alive to
// `ws` forever). Without this, a dead connection stays in the queue or
// stays "matched" to a live opponent, silently breaking that match —
// this is what a matchmaking-corruption bug from stale connections looks
// like in practice. Standard `ws` ping/pong liveness check: see
// https://github.com/websockets/ws#how-to-detect-and-close-broken-connections
const HEARTBEAT_INTERVAL_MS = 15000;
const heartbeat = setInterval(() => {
  for (const player of players.values()) {
    if (!player.isAlive) {
      player.socket.terminate(); // triggers 'close' -> cleanup above
      continue;
    }
    player.isAlive = false;
    player.socket.ping();
  }
}, HEARTBEAT_INTERVAL_MS);
wss.on("close", () => clearInterval(heartbeat));

httpServer.listen(PORT, () => {
  console.log(`[duel-server] listening on :${PORT}`);
});
