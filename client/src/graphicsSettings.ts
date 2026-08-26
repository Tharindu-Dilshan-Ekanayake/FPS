// Graphics settings: lets the player trade visual fidelity for smoothness
// directly, rather than being stuck with one fixed quality level. Persisted
// to localStorage so the choice survives a reload.
export interface GraphicsSettings {
  shadows: boolean;
  postProcessing: boolean;
  resolutionScale: number; // 0.6–1, multiplies the render's device pixel ratio
}

// Defaults lean toward "runs smoothly on weak/integrated hardware" rather
// than max fidelity — a low-end PC's very first match should be playable
// without the player needing to find the settings panel first:
//  - shadows: real-time shadow map rendering, the single priciest toggle.
//  - postProcessing: three extra full-screen passes (bloom/chromatic
//    aberration/vignette) purely for visual flair.
//  - resolutionScale 0.75 (one of Settings.tsx's own preset buttons — keep
//    this in sync with RESOLUTION_OPTIONS there, or the settings panel
//    would show no option as selected on a fresh install): cuts rendered
//    pixel count by ~44% vs. native — fill-rate (GPU work per pixel) is
//    often the actual bottleneck on integrated GPUs, more so than any
//    single effect toggle.
// All three are still fully adjustable in-game; a capable machine can turn
// them back up in a couple of clicks.
export const DEFAULT_GRAPHICS_SETTINGS: GraphicsSettings = {
  shadows: false,
  postProcessing: false,
  resolutionScale: 0.75,
};

const STORAGE_KEY = "gunxor:graphics-settings";

export function loadGraphicsSettings(): GraphicsSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_GRAPHICS_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<GraphicsSettings>;
    return { ...DEFAULT_GRAPHICS_SETTINGS, ...parsed };
  } catch {
    return DEFAULT_GRAPHICS_SETTINGS;
  }
}

export function saveGraphicsSettings(settings: GraphicsSettings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // localStorage unavailable (private mode / disabled) — setting just
    // won't persist across reloads, which is fine.
  }
}
