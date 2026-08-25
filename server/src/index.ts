import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type { ClientMessage, ServerMessage } from "./protocol.js";

const PORT = Number(process.env.PORT) || 8787;

interface Player {
  id: number;
  socket: WebSocket;
  opponent: Player | null;
  isAlive: boolean;
}

let nextPlayerId = 1;
const queue: Player[] = []; // anonymous quick-match
const codeRooms = new Map<string, Player>(); // roomCode -> player waiting in it
const players = new Map<WebSocket, Player>();

function send(socket: WebSocket, message: ServerMessage) {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(message));
}

function removeFromWaiting(player: Player) {
  const idx = queue.indexOf(player);
  if (idx !== -1) queue.splice(idx, 1);
  for (const [code, waiting] of codeRooms) {
    if (waiting === player) codeRooms.delete(code);
  }
}

function pairUp(player: Player, waiting: Player) {
  player.opponent = waiting;
  waiting.opponent = player;
  // Deterministic by id so both clients agree on who spawns where.
  const playerIsOne = player.id < waiting.id;
  send(player.socket, { type: "matched", isPlayerOne: playerIsOne });
  send(waiting.socket, { type: "matched", isPlayerOne: !playerIsOne });
}

function handleFindMatch(player: Player, roomCode?: string) {
  if (player.opponent) return; // already in a match
  removeFromWaiting(player);

  const code = roomCode?.trim().toUpperCase();

  if (code) {
    const waiting = codeRooms.get(code);
    // A dead/expired entry left under this code shouldn't block a fresh
    // pairing — same reasoning as the quick-match queue below.
    if (waiting && waiting.socket.readyState === WebSocket.OPEN && waiting !== player) {
      codeRooms.delete(code);
      pairUp(player, waiting);
    } else {
      codeRooms.set(code, player);
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

  pairUp(player, waiting);
}

function handleLeave(player: Player) {
  removeFromWaiting(player);
  const opponent = player.opponent;
  if (opponent) {
    opponent.opponent = null;
    send(opponent.socket, { type: "opponent_left" });
  }
  player.opponent = null;
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
      handleFindMatch(player, msg.roomCode);
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
    case "hit": {
      const opponent = player.opponent;
      if (!opponent) return;
      send(opponent.socket, { type: "damage" });
      break;
    }
    case "health": {
      const opponent = player.opponent;
      if (!opponent) return;
      send(opponent.socket, { type: "opponent_health", health: msg.health });
      break;
    }
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
  const player: Player = { id: nextPlayerId++, socket, opponent: null, isAlive: true };
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
