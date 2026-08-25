// gunXor wordmark — used sparingly (menu, matchmaking screen, in-HUD
// corner watermark), not decoration plastered everywhere. Condensed,
// heavy-weight, tight tracking to match the tactical/military HUD style
// already established across the rest of the UI — no new font files, just
// a deliberate Tailwind treatment.

const SIZES = {
  sm: "text-sm",
  md: "text-2xl",
  lg: "text-4xl",
} as const;

export function GunXorLogo({ size = "md", className = "" }: { size?: keyof typeof SIZES; className?: string }) {
  return (
    <span className={`font-black uppercase tracking-tighter select-none ${SIZES[size]} ${className}`}>
      <span className="text-neutral-100">gun</span>
      <span className="text-emerald-400">X</span>
      <span className="text-neutral-100">or</span>
    </span>
  );
}
