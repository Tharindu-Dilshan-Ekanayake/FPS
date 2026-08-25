import React, { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { useGLTF, useAnimations } from "@react-three/drei";
import * as THREE from "three";
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";
import { playGunshotSound, playReloadSound, playEmptyClickSound } from "./audio";

const WEAPON_URL = "/weapon.glb";
useGLTF.preload(WEAPON_URL);

// A Three.js light layer used only by the weapon's dedicated fill lights,
// so they illuminate the gun/hands without spilling onto nearby world
// geometry (the map is scaled tiny, so walls can be very close to camera).
const WEAPON_LIGHT_LAYER = 1;

// ── Viewmodel feel tuning ───────────────────────────────────────────────────
const WEAPON_BOB_SPEED = 9.5; // walking bob cycle rate
const WEAPON_BOB_AMOUNT_X = 0.012; // side-to-side sway per stride
const WEAPON_BOB_AMOUNT_Y = 0.011; // downward dip per footfall
const IDLE_SWAY_AMOUNT_X = 0.0035; // slow breathing sway when standing still
const IDLE_SWAY_AMOUNT_Y = 0.0025;
const RECOIL_PITCH_KICK = 0.013; // camera pitch-up per shot, in radians
const RECOIL_PITCH_MAX = 0.11; // clamp so sustained full-auto can't spin the view away
const RECOIL_PITCH_RECOVERY = 11; // higher = snappier return to aim

export interface WeaponProps {
  isMoving?: boolean;
  onShoot?: (muzzlePos: THREE.Vector3) => void;
  ammo: number;
  setAmmo: React.Dispatch<React.SetStateAction<number>>;
  isReloading: boolean;
  setIsReloading: React.Dispatch<React.SetStateAction<boolean>>;
}

// ─────────────────────────────────────────────────────────────────────────────
//  WEAPON MODEL
//  Uses WORLD-SPACE CAMERA SYNC via useFrame (NOT camera.add() which breaks R3F)
// ─────────────────────────────────────────────────────────────────────────────
function WeaponModel({
  isMoving = false,
  onShoot,
  ammo,
  setAmmo,
  isReloading,
  setIsReloading,
}: WeaponProps) {
  const { scene, animations } = useGLTF(WEAPON_URL);
  const { camera } = useThree();

  // The outer group follows the camera in world space every frame
  const weaponGroupRef = useRef<THREE.Group>(null);
  // The inner group is the model root — needed for useAnimations
  const modelRef = useRef<THREE.Group>(null);

  const recoilRef = useRef(0);
  // Remaining upward camera-pitch kick still to be eased back out — see the
  // recoil recovery step in the useFrame below and the kick applied in
  // doFire. Distinct from recoilRef above, which only nudges the
  // viewmodel's own local position/rotation, not the camera itself.
  const recoilPitchRef = useRef(0);
  // 0 → 1 blend between "idle breathing sway" and "walking bob", eased so
  // starting/stopping movement doesn't snap the viewmodel.
  const bobFadeRef = useRef(0);
  const [muzzleFlash, setMuzzleFlash] = useState(false);
  const flashTimer = useRef<number | null>(null);
  const lastShotTime = useRef(0);
  const localOffsetRef = useMemo(() => new THREE.Vector3(), []);

  // Mouse-look sway: nudges the viewmodel opposite the look direction, then
  // eases back to center — reads as weight/inertia on the gun.
  const swayTarget = useRef({ x: 0, y: 0 });
  const swayCurrent = useRef({ x: 0, y: 0 });

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      swayTarget.current.x = THREE.MathUtils.clamp(
        swayTarget.current.x - e.movementX * 0.0006,
        -0.045,
        0.045
      );
      swayTarget.current.y = THREE.MathUtils.clamp(
        swayTarget.current.y - e.movementY * 0.0006,
        -0.035,
        0.035
      );
    };
    window.addEventListener("mousemove", onMouseMove);
    return () => window.removeEventListener("mousemove", onMouseMove);
  }, []);

  // ── Clone with SkeletonUtils so SkinnedMesh animations work ─────────────
  const clonedScene = useMemo(() => {
    const cloned = cloneSkeleton(scene) as THREE.Group;

    cloned.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;

      // Always on top — never hidden by walls/floor depth buffer. But
      // depthTest is off for ALL weapon parts (see fixMat below), so the
      // gun's own pieces no longer depth-sort against each other either —
      // whichever draws last wins. The arms/hands mesh ("lambert1") needs
      // to draw after the gun body so gripping fingers don't get painted
      // over by the barrel/receiver.
      const srcMat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
      const isArmsMesh = srcMat?.name === "lambert1";
      mesh.renderOrder = isArmsMesh ? 1000 : 999;
      mesh.frustumCulled = false;
      // Shadow mapping is a separate light-space pass from the main depth
      // buffer, so this still works despite depthTest/depthWrite below —
      // it's what keeps the gun from looking like a flat pasted-on sprite.
      mesh.castShadow = true;
      // Opts into the dedicated viewmodel light layer (see below) in
      // addition to the default layer, without losing normal world lighting.
      mesh.layers.enable(WEAPON_LIGHT_LAYER);

      const fixMat = (mat: THREE.Material) => {
        const m = mat.clone();
        const standard = m as THREE.MeshStandardMaterial;
        // A light touch here (vs. the old 1.35x/0.12 wash) keeps the PBR
        // metal/roughness shading from the model's own materials readable
        // instead of flattening it out. The dedicated weapon light below
        // does the real work of making it look good, not this hack.
        standard.color?.multiplyScalar(1.05);
        standard.emissive?.set("#12151c");
        standard.emissiveIntensity = 0.04;
        // Only push metal parts shinier — applying this to skin/fabric
        // materials (metalness near 0) turned the arm into blown-out chrome
        // under the dedicated light below.
        if (standard.metalness !== undefined && standard.metalness > 0.35) {
          standard.metalness = THREE.MathUtils.clamp(standard.metalness + 0.12, 0, 1);
          if (standard.roughness !== undefined) {
            standard.roughness = THREE.MathUtils.clamp(standard.roughness - 0.12, 0.05, 1);
          }
        }
        m.depthTest  = false;  // ← render on top of everything
        m.depthWrite = false;
        m.needsUpdate = true;
        return m;
      };

      mesh.material = Array.isArray(mesh.material)
        ? mesh.material.map(fixMat)
        : fixMat(mesh.material as THREE.Material);
    });

    return cloned;
  }, [scene]);

  // ── Baked animations ─────────────────────────────────────────────────────
  const { actions } = useAnimations(animations, modelRef);

  // Draw → Idle on mount
  useEffect(() => {
    if (!actions) return;
    const draw = actions["Arms_Draw"];
    const idle = actions["Arms_Idle"];

    if (draw) {
      draw.reset().setLoop(THREE.LoopOnce, 1).play();
      const onEnd = () => idle?.reset().fadeIn(0.25).play();
      draw.getMixer().addEventListener("finished", onEnd);
      return () => draw.getMixer().removeEventListener("finished", onEnd);
    } else {
      idle?.reset().play();
    }
  }, [actions]);

  // Walk ↔ Idle transition
  useEffect(() => {
    if (!actions || isReloading) return;
    if (isMoving) {
      actions["Arms_Idle"]?.fadeOut(0.2);
      actions["Arms_Walk"]?.reset().fadeIn(0.2).play();
    } else {
      actions["Arms_Walk"]?.fadeOut(0.2);
      actions["Arms_Idle"]?.reset().fadeIn(0.2).play();
    }
  }, [isMoving, isReloading, actions]);

  // ── Fire handler ─────────────────────────────────────────────────────────
  const doFire = (now: number) => {
    if (now - lastShotTime.current < 110) return; // ~550 RPM cap
    if (isReloading) return;

    if (ammo <= 0) {
      playEmptyClickSound();
      doReload();
      return;
    }

    lastShotTime.current = now;
    setAmmo((prev) => Math.max(0, prev - 1));
    playGunshotSound();

    recoilRef.current = 1;

    // Real camera-pitch recoil kick — pushes the view (and next shot's aim)
    // up, then eases back down over subsequent frames below. Safe against
    // PointerLockControls: it re-derives its internal euler from the
    // camera's current quaternion on every mousemove rather than caching
    // its own absolute rotation, so this local rotateX composes cleanly
    // with mouse-look instead of fighting it (verified against
    // three-stdlib's PointerLockControls source).
    recoilPitchRef.current = Math.min(recoilPitchRef.current + RECOIL_PITCH_KICK, RECOIL_PITCH_MAX);
    camera.rotateX(RECOIL_PITCH_KICK);

    // Muzzle flash
    setMuzzleFlash(true);
    if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setMuzzleFlash(false), 55);

    // Fire animation
    if (actions?.["Arms_Fire"]) {
      actions["Arms_Fire"].reset().setLoop(THREE.LoopOnce, 1).play();
    }

    // Muzzle world position — small offset forward-right from camera
    if (onShoot && weaponGroupRef.current) {
      const muzzleLocal = new THREE.Vector3(0.08, -0.05, -0.55);
      const muzzleWorld = muzzleLocal.clone();
      // Will be updated in next useFrame, approximate here with camera data
      weaponGroupRef.current.localToWorld(muzzleWorld);
      onShoot(muzzleWorld);
    }
  };

  // ── Reload handler ────────────────────────────────────────────────────────
  const doReload = () => {
    if (isReloading || ammo >= 30) return;
    setIsReloading(true);
    playReloadSound();

    const clip = actions?.["Arms_fullreload"] ?? actions?.["Arms_notfullreload"];
    if (clip) {
      clip.reset().setLoop(THREE.LoopOnce, 1).play();
    }

    window.setTimeout(() => {
      setAmmo(30);
      setIsReloading(false);
      actions?.["Arms_Idle"]?.reset().fadeIn(0.01).play();
    }, 2200);
  };

  // ── Input listeners ───────────────────────────────────────────────────────
  useEffect(() => {
    const onMouse = (e: MouseEvent) => {
      if (e.button === 0) doFire(e.timeStamp);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "KeyR") doReload();
      if (e.code === "KeyF" && !isReloading) {
        actions?.["Arms_Inspect"]?.reset().setLoop(THREE.LoopOnce, 1).play();
      }
    };
    window.addEventListener("mousedown", onMouse);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onMouse);
      window.removeEventListener("keydown", onKey);
    };
  });

  // ── WORLD-SPACE CAMERA SYNC every frame ──────────────────────────────────
  // This is the KEY FIX:
  //   - group lives in R3F's scene (NOT added to camera object)
  //   - We copy camera.position + camera.quaternion each frame
  //   - Then add a local offset in camera space for the viewmodel corner position
  //   - depthTest:false on materials ensures gun renders on top of the map
  useFrame((state, delta) => {
    const group = weaponGroupRef.current;
    if (!group) return;

    // Ease the recoil-kicked camera pitch back toward where the player was
    // actually aiming — see the kick applied in doFire. Undoing a fraction
    // of the *remaining* kick each frame (rather than chasing an absolute
    // target) means it composes correctly no matter how the player's own
    // mouse-look moves the camera while it's recovering.
    if (recoilPitchRef.current > 0.00005) {
      const nextPitch = THREE.MathUtils.damp(recoilPitchRef.current, 0, RECOIL_PITCH_RECOVERY, delta);
      state.camera.rotateX(-(recoilPitchRef.current - nextPitch));
      recoilPitchRef.current = nextPitch;
    }

    // Damp recoil back to zero
    recoilRef.current = THREE.MathUtils.damp(recoilRef.current, 0, 18, delta);
    const r = recoilRef.current;

    // Sway: decay the impulse target back to center, then let the
    // viewmodel ease toward it — two damped stages give a springy lag.
    swayTarget.current.x = THREE.MathUtils.damp(swayTarget.current.x, 0, 6, delta);
    swayTarget.current.y = THREE.MathUtils.damp(swayTarget.current.y, 0, 6, delta);
    swayCurrent.current.x = THREE.MathUtils.damp(swayCurrent.current.x, swayTarget.current.x, 10, delta);
    swayCurrent.current.y = THREE.MathUtils.damp(swayCurrent.current.y, swayTarget.current.y, 10, delta);
    const sx = swayCurrent.current.x;
    const sy = swayCurrent.current.y;

    // Walking bob (footstep-synced weight) cross-fades with a slow idle
    // breathing sway, so the gun never looks perfectly bolted to the
    // screen even when standing still, and doesn't pop when movement
    // starts/stops.
    bobFadeRef.current = THREE.MathUtils.damp(bobFadeRef.current, isMoving ? 1 : 0, 6, delta);
    const bobFade = bobFadeRef.current;
    const bobPhase = state.clock.elapsedTime * WEAPON_BOB_SPEED;
    const bobX = Math.sin(bobPhase) * WEAPON_BOB_AMOUNT_X * bobFade;
    const bobY = Math.abs(Math.sin(bobPhase)) * WEAPON_BOB_AMOUNT_Y * bobFade;
    const idleFade = 1 - bobFade;
    const idleX = Math.sin(state.clock.elapsedTime * 0.8) * IDLE_SWAY_AMOUNT_X * idleFade;
    const idleY = Math.sin(state.clock.elapsedTime * 0.65) * IDLE_SWAY_AMOUNT_Y * idleFade;

    group.position.copy(state.camera.position);
    group.quaternion.copy(state.camera.quaternion);

    // Centered, sights-aligned stance (matches the weapon asset's own
    // reference pose) rather than an off-axis hip-fire corner position.
    // Kept far enough from the camera that our wide 75° gameplay FOV
    // doesn't fisheye-distort the two-handed grip — the asset's own
    // reference shot was framed with a much narrower/product-shot FOV, so
    // matching its close-up framing here warped the support hand out of a
    // natural pose (and partly out of frame).
    group.position.add(localOffsetRef.set(
      0.015 + sx * 0.6 + bobX + idleX,
      -0.36 - r * 0.02 + sy * 0.6 - bobY + idleY,
      -0.85 + r * 0.06,
    ).applyQuaternion(state.camera.quaternion));
    group.rotateY(Math.PI + sx * 0.35 + bobX * 0.4);

    // Recoil tilt on the group
    group.rotation.x -= r * 0.08 - sy * 0.3;
  });

  return (
    // renderOrder on the group so Three.js sorts it last. Named so
    // RaycastShooter (App.tsx) can walk up from any hit mesh and recognize
    // it as part of the viewmodel rig, excluding it from shot raycasts.
    <group ref={weaponGroupRef} name="weaponGroupRef" renderOrder={999}>
      {/* Dedicated viewmodel fill light — travels with the camera so the
          gun always reads with crisp, flattering highlights regardless of
          which way the world's sun is facing. Same technique real FPS
          games use rather than relying purely on scene lighting. Restricted
          to WEAPON_LIGHT_LAYER (see fixMat's mesh.layers.enable above) so
          it doesn't spill onto nearby walls in this tightly-scaled map. */}
      <pointLight
        ref={(l) => l?.layers.set(WEAPON_LIGHT_LAYER)}
        position={[0.15, 0.25, 0.55]}
        color="#fff4e0"
        intensity={1.0}
        distance={3}
        decay={2}
      />
      <pointLight
        ref={(l) => l?.layers.set(WEAPON_LIGHT_LAYER)}
        position={[-0.2, -0.1, 0.3]}
        color="#bcd8ff"
        intensity={0.35}
        distance={2}
        decay={2}
      />

      {/*
        Rotation Y=PI: model's +Z faces the camera (looks forward).
        scale=0.25: shrinks the ~1.5-unit model down to FPS viewmodel size.
        Adjust scale if weapon looks too big or too small.
      */}
      <group ref={modelRef} position={[-0, -0.79, 0]} rotation={[-0.01, -0.011, 0]} scale={0.6}>
        <primitive object={clonedScene} />

        {/* 3-D Muzzle Flash at barrel tip */}
        {muzzleFlash && (
          <group
            position={[-0.12, 1.18, 1.68]}  // local model space — barrel tip
          >
            <mesh renderOrder={1000}>
              <dodecahedronGeometry args={[0.22, 0]} />
              <meshBasicMaterial color="#fef08a" depthTest={false} />
            </mesh>
            <mesh renderOrder={1000}>
              <sphereGeometry args={[0.38, 8, 8]} />
              <meshBasicMaterial color="#f97316" transparent opacity={0.55} depthTest={false} />
            </mesh>
            <pointLight color="#fde047" intensity={10} distance={6} />
          </group>
        )}
      </group>
    </group>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  FALLBACK (simple gun shape while weapon.glb loads)
// ─────────────────────────────────────────────────────────────────────────────
function WeaponFallback() {
  const groupRef = useRef<THREE.Group>(null);

  useFrame((state) => {
    const group = groupRef.current;
    if (!group) return;

    group.position.copy(state.camera.position);
    group.quaternion.copy(state.camera.quaternion);
    group.position.add(new THREE.Vector3(0.13, -0.22, -0.8).applyQuaternion(state.camera.quaternion));
  });

  return (
    <group ref={groupRef} renderOrder={999}>
      {/* Receiver */}
      <mesh renderOrder={999}>
        <boxGeometry args={[0.06, 0.08, 0.32]} />
        <meshStandardMaterial color="#1e293b" depthTest={false} depthWrite={false} />
      </mesh>
      {/* Barrel */}
      <mesh position={[0.01, 0.015, -0.22]} rotation={[Math.PI / 2, 0, 0]} renderOrder={999}>
        <cylinderGeometry args={[0.013, 0.013, 0.24, 8]} />
        <meshStandardMaterial color="#0f172a" depthTest={false} depthWrite={false} />
      </mesh>
      {/* Grip */}
      <mesh position={[0, -0.07, 0.04]} rotation={[0.3, 0, 0]} renderOrder={999}>
        <boxGeometry args={[0.04, 0.1, 0.05]} />
        <meshStandardMaterial color="#334155" depthTest={false} depthWrite={false} />
      </mesh>
    </group>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  EXPORT
// ─────────────────────────────────────────────────────────────────────────────
export function Weapon(props: WeaponProps) {
  return (
    <Suspense fallback={<WeaponFallback />}>
      <WeaponModel {...props} />
    </Suspense>
  );
}
