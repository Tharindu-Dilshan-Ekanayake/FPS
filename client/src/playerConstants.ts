// Shared between App.tsx's local Player and RemotePlayer.tsx (the duel
// opponent's avatar) — broken out to a standalone module so RemotePlayer
// can reuse the exact eye-height-to-capsule-center relationship without
// creating a circular import with App.tsx.
export const EYE_HEIGHT = 0.40;

// The local Player's actual CapsuleCollider dimensions (App.tsx). Also
// used by RemotePlayer.tsx to align the opponent's visible model against
// their real capsule — not a "reasonable-looking" independent guess.
// RemotePlayer previously derived its own capsule from TARGET_HEIGHT
// (0.19 half-height) instead of matching these real values (0.06), so the
// model's feet were aligned to a capsule ~0.13 units taller than the one
// interpPos.y actually reconstructs the sender's center for — a constant
// sinking offset present even standing upright, not just while crouching.
// Bots never hit this because they're locally simulated, with no remote
// camera position to reconstruct against — there was nothing to mismatch.
export const PLAYER_CAPSULE_HALF_HEIGHT = 0.06;
export const PLAYER_CAPSULE_RADIUS = 0.06;
