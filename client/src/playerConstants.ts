// Shared between App.tsx's local Player and RemotePlayer.tsx (the duel
// opponent's avatar) — broken out to a standalone module so RemotePlayer
// can reuse the exact eye-height-to-capsule-center relationship without
// creating a circular import with App.tsx.
export const EYE_HEIGHT = 0.40;
