import { forwardRef, useImperativeHandle, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

export interface CompassHandle {
  setHeading: (degrees: number) => void;
}

const MARKS: { label: string; angle: number }[] = [
  { label: "N", angle: 0 },
  { label: "NE", angle: 45 },
  { label: "E", angle: 90 },
  { label: "SE", angle: 135 },
  { label: "S", angle: 180 },
  { label: "SW", angle: 225 },
  { label: "W", angle: 270 },
  { label: "NW", angle: 315 },
];

const PX_PER_DEGREE = 3.2;
// The strip is w-64 (256px), so marks clip out of view past ~128/3.2 = 40°
// from center regardless of opacity — matching the fade range to that means
// marks actually fade out before hitting the hard edge, instead of popping.
const VISIBLE_RANGE_DEG = 40;

function shortestDelta(a: number, b: number) {
  let d = (a - b) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

// The visual strip — pure HUD DOM, lives outside the Canvas. Positions are
// pushed in imperatively via the ref (see CompassDriver) rather than React
// state, so a 60fps heading update never triggers a React re-render.
export const Compass = forwardRef<CompassHandle>((_, ref) => {
  const markRefs = useRef<(HTMLSpanElement | null)[]>([]);

  useImperativeHandle(ref, () => ({
    setHeading: (heading: number) => {
      MARKS.forEach((mark, i) => {
        const el = markRefs.current[i];
        if (!el) return;
        const delta = shortestDelta(mark.angle, heading);
        if (Math.abs(delta) > VISIBLE_RANGE_DEG) {
          el.style.opacity = "0";
        } else {
          const fade = 1 - Math.abs(delta) / VISIBLE_RANGE_DEG;
          el.style.opacity = mark.label.length === 1 ? String(0.55 + fade * 0.45) : String(0.3 + fade * 0.4);
          // Bake the -50%/-50% centering into this transform too, since
          // setting style.transform imperatively replaces the element's
          // whole computed transform — it can't be layered on top of the
          // -translate-x-1/2/-translate-y-1/2 Tailwind utilities below.
          el.style.transform = `translate(calc(-50% + ${delta * PX_PER_DEGREE}px), -50%)`;
        }
      });
    },
  }));

  return (
    <div className="pointer-events-none absolute top-2 left-1/2 -translate-x-1/2 z-20 w-64 h-6 overflow-hidden rounded-full bg-neutral-900/70 backdrop-blur-md border border-neutral-700/50">
      <div className="absolute left-1/2 top-0 h-full w-px bg-emerald-400/70" />
      {MARKS.map((mark, i) => (
        <span
          key={mark.label}
          ref={(el) => {
            markRefs.current[i] = el;
          }}
          className={`absolute top-1/2 left-1/2 font-mono tracking-widest ${
            mark.label.length === 1 ? "text-emerald-300 text-xs font-bold" : "text-neutral-400 text-[9px]"
          }`}
        >
          {mark.label}
        </span>
      ))}
    </div>
  );
});
Compass.displayName = "Compass";

// Lives inside the Canvas (has access to the frame loop + camera) and feeds
// the DOM strip above through the imperative handle. Reuses one scratch
// vector instead of allocating a fresh THREE.Vector3 every frame.
export function CompassDriver({ compassRef }: { compassRef: React.RefObject<CompassHandle | null> }) {
  const dirVec = useRef(new THREE.Vector3());

  useFrame((state) => {
    state.camera.getWorldDirection(dirVec.current);
    const headingRad = Math.atan2(dirVec.current.x, -dirVec.current.z);
    const headingDeg = (THREE.MathUtils.radToDeg(headingRad) + 360) % 360;
    compassRef.current?.setHeading(headingDeg);
  });

  return null;
}
