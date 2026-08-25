import type { GraphicsSettings } from "./graphicsSettings";

const RESOLUTION_OPTIONS: { value: number; label: string }[] = [
  { value: 0.6, label: "60%" },
  { value: 0.75, label: "75%" },
  { value: 1, label: "100%" },
];

interface GraphicsSettingsPanelProps {
  settings: GraphicsSettings;
  onChange: (next: GraphicsSettings) => void;
  onClose: () => void;
}

export function GraphicsSettingsPanel({ settings, onChange, onClose }: GraphicsSettingsPanelProps) {
  return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
    >
      <div
        className="bg-neutral-900/95 border border-emerald-500/40 rounded-2xl px-8 py-7 text-center shadow-[0_0_60px_rgba(16,185,129,0.15)] max-w-sm w-[90vw]"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="text-emerald-400 font-bold text-lg tracking-wider uppercase mb-1">Graphics</p>
        <p className="text-neutral-500 text-[11px] mb-6">
          Lower these if the game feels choppy on your machine.
        </p>

        <div className="flex items-center justify-between mb-4">
          <div className="text-left">
            <p className="text-neutral-200 text-sm font-bold">Shadows</p>
            <p className="text-neutral-500 text-[10px]">Biggest performance cost. Turn off first.</p>
          </div>
          <button
            type="button"
            onClick={() => onChange({ ...settings, shadows: !settings.shadows })}
            className={`shrink-0 w-14 h-7 rounded-full border transition-colors relative ${
              settings.shadows ? "bg-emerald-500/30 border-emerald-500/70" : "bg-neutral-800 border-neutral-700"
            }`}
          >
            <span
              className={`absolute top-0.5 w-5 h-5 rounded-full transition-all ${
                settings.shadows ? "left-7 bg-emerald-400" : "left-0.5 bg-neutral-500"
              }`}
            />
          </button>
        </div>

        <div className="flex items-center justify-between mb-6">
          <div className="text-left">
            <p className="text-neutral-200 text-sm font-bold">Bloom &amp; Effects</p>
            <p className="text-neutral-500 text-[10px]">Screen glow, vignette, chromatic edges.</p>
          </div>
          <button
            type="button"
            onClick={() => onChange({ ...settings, postProcessing: !settings.postProcessing })}
            className={`shrink-0 w-14 h-7 rounded-full border transition-colors relative ${
              settings.postProcessing ? "bg-emerald-500/30 border-emerald-500/70" : "bg-neutral-800 border-neutral-700"
            }`}
          >
            <span
              className={`absolute top-0.5 w-5 h-5 rounded-full transition-all ${
                settings.postProcessing ? "left-7 bg-emerald-400" : "left-0.5 bg-neutral-500"
              }`}
            />
          </button>
        </div>

        <div className="mb-6">
          <p className="text-neutral-200 text-sm font-bold text-left mb-1">Render Resolution</p>
          <p className="text-neutral-500 text-[10px] text-left mb-2">Lower = fewer pixels drawn = faster.</p>
          <div className="grid grid-cols-3 gap-2">
            {RESOLUTION_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => onChange({ ...settings, resolutionScale: opt.value })}
                className={`rounded-lg border py-1.5 text-xs font-bold transition-colors ${
                  settings.resolutionScale === opt.value
                    ? "bg-emerald-500/20 border-emerald-500/70 text-emerald-300"
                    : "bg-neutral-800/60 border-neutral-700 text-neutral-400 hover:border-neutral-500"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <button
          type="button"
          onClick={onClose}
          className="w-full bg-emerald-500 hover:bg-emerald-400 text-neutral-950 font-bold uppercase tracking-wider text-sm py-2.5 rounded-xl shadow-lg transition-colors"
        >
          Done
        </button>
      </div>
    </div>
  );
}
