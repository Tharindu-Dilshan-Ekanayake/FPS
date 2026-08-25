# gunXor

A browser-based 3D first-person shooter (FPS). You play it inside a web browser — no download, no install. It has bots to practice against, and a real online 1-vs-1 mode where you play against another real person over the internet.

This file explains, in simple terms: what the game is made of, what's special about it, and how to run it yourself.

---

## 1. The two parts of this project

```
FPS/
├── client/    ← the game itself (what you see and play, runs in the browser)
└── server/    ← the online-multiplayer referee (only used for 1v1 Online mode)
```

- **client** — this is 100% of the game. Menus, the 3D world, bots, shooting, sound, everything you see. It runs entirely in your web browser.
- **server** — a small always-on program that only matters for **1v1 Online**. Its job is to pair two players together and be the "referee" that decides damage, kills, and who won (explained more in section 4).

If you only ever play against bots (Free For All / Team Deathmatch), the server isn't even needed — those modes run 100% inside your browser.

---

## 2. Technology used, and why

### Client (the game)

| Technology | What it's for |
|---|---|
| **React** | Builds the menus, HUD (health bar, ammo, scoreboard, etc.) |
| **Three.js** | Draws the 3D world — the map, the gun, the characters, lighting |
| **React Three Fiber (R3F)** | Lets Three.js's 3D scene be written using React, so the 3D world and the menu UI can share the same code and state cleanly |
| **Rapier physics** (`@react-three/rapier`) | Real physics: gravity, collisions, so you can't walk through walls, and bullets/characters interact with the map correctly |
| **TypeScript** | JavaScript with type-checking — catches a lot of bugs before you even run the game |
| **Vite** | The dev server / build tool — makes the game reload instantly while coding, and packages it for real deployment |
| **Tailwind CSS** | Styling for all the menus/HUD (the buttons, boxes, colors you see) |

### Server (online 1v1 only)

| Technology | What it's for |
|---|---|
| **Node.js** | Runs the server program |
| **WebSocket** (`ws` library) | A live, always-open connection between the two players' browsers and the server, so hits/positions/timers update instantly (not slow "refresh the page" style) |
| **TypeScript** | Same as the client — type-safety |

### 3D Models

The map, weapon, and character models are `.glb` 3D files (a standard 3D file format), optimized using a tool called **gltf-transform** to make them small and fast to load without looking worse (details in section 5).

---

## 3. Game modes

| Mode | What it is | Who it runs against |
|---|---|---|
| **Free For All (FFA)** | You vs. up to several bots roaming the map. Clear them all, or win by kills/time. | Bots only — your browser controls them |
| **Team Deathmatch (TDM)** | You + allied bots vs. an enemy bot team. | Bots only |
| **1v1 Online** | You vs. one other **real person**, over the internet. | A real opponent, matched through the server |

For FFA/TDM you can pick: number of bots, difficulty, kill limit, and time limit — all before starting.

For 1v1 Online, see the next section — it works completely differently under the hood.

---

## 4. How the online 1v1 multiplayer actually works

This is the "special" part, so here's a simple explanation of what happens when two people play each other online:

1. Both players open **1v1 Online** and click **Find Match** (either with no code, to be paired with a random stranger, or with the same **room code** typed on both sides, to play a specific friend).
2. Both browsers open a live connection (WebSocket) to the **server**.
3. The server pairs the two of them together and starts a **match "Room"** — this Room lives only on the server, and it is the single source of truth for the whole match.
4. While playing:
   - Each player's own browser only tells the server "my gun fired, and here's whether I think I hit a headshot."
   - **The server — not your browser — decides the actual damage, whether it's a kill, and updates both players' health/kill count.** This is on purpose: if your own browser could just say "I did 1000 damage," a cheater could rewrite their own browser code to always report kills. Since the server is the one deciding, that trick doesn't work.
   - The server also runs the match clock and tells both browsers when to update the HUD.
5. When someone reaches the kill limit, or the timer runs out, the server ends the match and tells both players who won — again, decided by the server, not either player's browser.
6. If someone disconnects mid-match, the server notices (it "pings" both browsers every 15 seconds to check they're still alive) and automatically gives the win to whoever's left.

**Room codes**: whoever opens a room code first can choose the kill limit and time limit for that match (10/20/30/50 kills, 3/5/10 minutes) — a friend who joins with the same code automatically plays by those settings. Random quick-matches (no code) always use the safe default (20 kills / 5 minutes), so a stranger can't force a weird 1-kill match on you.

---

## 5. What's special / non-obvious about how this was built

A few things that took real work and aren't obvious just from playing:

- **The map was shrunk ~10x without looking worse.** The original 3D map file was ~32 MB and needed over a thousand separate draw calls (each one is a small performance cost) to render. It's now ~2.8 MB and only needs about 54 draw calls, using a technique called mesh-instancing (repeated objects like crates/barrels are drawn as one batched operation instead of one-by-one) — this is a big chunk of why the game runs smoother now.
- **Collision uses a separate, un-shrunk copy of the map.** The instancing trick above actually breaks physics/collision if used directly (the physics engine can't tell instanced copies apart), so there's a second, invisible version of the map used only for walls/floor collision, while the visible one is the fast optimized version. You never see this — it's invisible geometry sitting in the same place as what you see.
- **The server can't be tricked by a modified client.** As explained in section 4 — kills, health, and match results are all decided by the server, not trusted from either player's browser.
- **Headshots do 2.5x damage** (50 instead of 20), detected by comparing exactly where your shot's ray hit the opponent's body against their height.
- **Dead stale connections don't corrupt the matchmaking queue.** If someone's browser tab crashes without a clean disconnect, the server pings every connection every 15 seconds and drops any that don't answer — otherwise a "ghost" player could sit in the queue forever, blocking real matches.
- **The gun view-model (hands + weapon) is a separate render pass from the world**, so it never visually clips into walls even when you're standing right next to one, and has its own dedicated lighting so it always looks good regardless of the map's lighting.
- **Recoil, weapon sway, and footstep bob are all physically "damped"** (eased smoothly) rather than snapping instantly, which is what makes the gun feel like it has real weight instead of being glued to the screen.

---

## 6. Controls

| Key | Action |
|---|---|
| W / A / S / D | Move |
| Mouse | Look around |
| Left Click | Shoot |
| R | Reload |
| Space | Jump |
| C | Crouch |
| Ctrl | Prone |
| F | Inspect weapon |
| Tab (hold) | Show live scoreboard (1v1 Online only) |

---

## 7. Running it yourself

You need [Node.js](https://nodejs.org) installed. Then, in two separate terminals:

**Terminal 1 — the game itself:**
```bash
cd client
npm install
npm run dev
```
This opens the game in your browser (usually `http://localhost:5173` or similar — the terminal will show the exact address).

**Terminal 2 — the online-multiplayer server** (only needed if you want to play 1v1 Online):
```bash
cd server
npm install
npm run dev
```
This starts the matchmaking server on port `8787`.

You don't need the server running at all if you only want to play against bots (FFA / TDM).

---

## 8. Honest limitations (things this game doesn't do, on purpose)

- No login system / accounts — matches are anonymous, nothing is saved after the match ends.
- No dedicated server hosting setup included — running the server yourself (`npm run dev`) is meant for local/LAN testing, not a public production deployment.
- Keys (W/A/S/D, Tab, etc.) are fixed and can't currently be rebound in a settings menu.
- FFA/TDM bots are local-only — they don't run online multiplayer against other real people, only 1v1 does.
