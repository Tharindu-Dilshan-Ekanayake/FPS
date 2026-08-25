// Graphics settings: lets the player trade visual fidelity for smoothness
// directly, rather than being stuck with one fixed quality level. Persisted
// to localStorage so the choice survives a reload.
export interface GraphicsSettings {
  shadows: boolean;
  postProcessing: boolean;
  resolutionScale: number; // 0.6–1, multiplies the render's device pixel ratio
}

export const DEFAULT_GRAPHICS_SETTINGS: GraphicsSettings = {
  shadows: true,
  postProcessing: true,
  resolutionScale: 1,
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
