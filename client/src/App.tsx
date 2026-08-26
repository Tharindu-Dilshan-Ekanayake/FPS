import { Suspense, useEffect, useRef, useState, useCallback, forwardRef, useImperativeHandle } from "react";
import { Canvas, useFrame, useThree, useStore } from "@react-three/fiber";
import { PointerLockControls, Sky } from "@react-three/drei";
import { EffectComposer, Bloom, Vignette, ChromaticAberration } from "@react-three/postprocessing";
import { BlendFunction } from "postprocessing";
import { Physics, RigidBody, RapierRigidBody, CapsuleCollider, useRapier } from "@react-three/rapier";
import * as THREE from "three";
import { Weapon } from "./Weapon";
import { GameMap } from "./GameMap";
import { BulletEffects, type BulletEffectsHandle } from "./BulletEffects";
import { Bot } from "./Bot";
import { DIFFICULTY_PRESETS, type Difficulty } from "./difficulty";
import {
  formatScoreLimit,
  formatTimeLimit,
  formatMatchEndReason,
  defaultKillLimit,
  DEFAULT_TIME_LIMIT,
  SCORE_LIMIT_OPTIONS,
  TIME_LIMIT_OPTIONS,
  type CombatantRegistry,
  type GameMode,
  type MatchEndReason,
} from "./match";
import {
  playHitSound,
  playHeadshotSound,
  playFootstepSound,
  playJumpSound,
  playLandSound,
  playPlayerHurtSound,
  startAmbientAmbience,
  stopAmbientAmbience,
} from "./audio";
import { GraphicsSettingsPanel } from "./Settings";
import { loadGraphicsSettings, saveGraphicsSettings, type GraphicsSettings } from "./graphicsSettings";
import { Compass, CompassDriver, type CompassHandle } from "./Compass";
import { EYE_HEIGHT } from "./playerConstants";
import { RemotePlayer, type RemotePlayerHandle } from "./RemotePlayer";
import { GunXorLogo } from "./Logo";
import {
  DuelConnection,
  type DuelStatus,
  type PlayerStats,
  type MatchEndReason as DuelMatchEndReason,
} from "./network";

type GameState = "menu" | "playing" | "won" | "lost" | "draw";

// ──────────────────────────────────────────────────────
//  TUNING CONSTANTS (Adjusted for scale={0.16} GameMap)
// ──────────────────────────────────────────────────────
// The player capsule is ~0.5 units tall (see Bot.tsx's TARGET_HEIGHT, which
// matches it). The old 4.5/5.5 values covered ~9x that height per second of
// walking and jumped ~1.7x the player's own height, which felt wildly fast
// and floaty for how small the map actually is — these are scaled back down
// to a believable, controllable pace instead (still a bit quicker than the
// toughest bot's own moveSpeed, see difficulty.ts).
const MOVE_SPEED = 3.0;
const JUMP_FORCE = 3.4;
const GRAVITY = -18;
const CROUCH_HEIGHT = EYE_HEIGHT * 0.6;
const PRONE_HEIGHT = EYE_HEIGHT * 0.22;
const CROUCH_SPEED_MULT = 0.55;
const PRONE_SPEED_MULT = 0.28;

// Spread across the map's real footprint (see Bot.tsx's WANDER bounds),
// away from the player's spawn near the origin.
const ENEMY_SPAWN_POINTS: [number, number, number][] = [
  [0, 2, -3],
  [5, 2, -10],
  [-5, 2, -10],
  [6, 2, 6],
  [-6, 2, 6],
];
const MAX_BOTS = ENEMY_SPAWN_POINTS.length;

// Ally bots (TDM) start close to the player, on "our side" of the map.
const ALLY_SPAWN_POINTS: [number, number, number][] = [
  [1.6, 2, 1.5],
  [-1.6, 2, 1.5],
  [2.4, 2, 3.2],
];
const MAX_TEAM_SIZE = ALLY_SPAWN_POINTS.length + 1; // + the player

// FFA/TDM bots respawn instead of staying dead — matches are meant to run
// to the kill limit (or time limit), not end the moment however many bots
// were on the map at once happen to all be dead simultaneously.
const RESPAWN_DELAY_MS = 3000;

// Picks a spawn point index different from the one just used, so a
// respawning bot doesn't reappear exactly where it died.
function pickRespawnSpawnIndex(current: number, poolSize: number): number {
  if (poolSize <= 1) return 0;
  let next = Math.floor(Math.random() * poolSize);
  while (next === current) next = Math.floor(Math.random() * poolSize);
  return next;
}

// 1v1 duel arena. The x=-4 lane was chosen by actually ray-casting it
// against the map's collision geometry (not eyeballed) — the x=0 corridor
// down the map's center looks open in screenshots but is blocked by props
// around z=-3.2 and z=0, and the original z=+6/-6 choice sat right next to
// a large barrel/tire stack. x=-4 is verified clear from z=7 to z=-7 at
// gameplay height (0.3-0.8 units), with margin on both sides.
//
// Multiple pairs (varying separation, and which side each player lands
// on) all sit on that same verified-clear line, so match start and every
// respawn can pick a different one instead of always the same two spots,
// without re-running the offline collision check for brand-new geometry.
// The server (see server/src/protocol.ts's DUEL_SPAWN_PAIR_COUNT) picks
// the index for both clients — keep this array's length in sync with it.
const DUEL_SPAWN_PAIRS: [[number, number, number], [number, number, number]][] = [
  [[-4, 2, 6], [-4, 2, -6]],
  [[-4, 2, -6], [-4, 2, 6]],
  [[-4, 2, 5], [-4, 2, -5]],
  [[-4, 2, -5], [-4, 2, 5]],
  [[-4, 2, 4], [-4, 2, -4]],
  [[-4, 2, -4], [-4, 2, 4]],
];

// Choices offered when a player is about to CREATE a room code — see the
// "duelKillLimitChoice"/"duelTimeLimitChoice" state below.
const DUEL_KILL_LIMIT_OPTIONS = [10, 20, 30, 50] as const;
const DUEL_TIME_LIMIT_OPTIONS = [180, 300, 600] as const; // 3 / 5 / 10 min

const ROOM_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I — easy to misread aloud
function generateRoomCode(length = 5): string {
  const bytes = new Uint32Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => ROOM_CODE_CHARS[b % ROOM_CODE_CHARS.length]).join("");
}

const movementKeys = new Set([
  "KeyW", "KeyA", "KeyS", "KeyD",
  "ArrowUp", "ArrowLeft", "ArrowDown", "ArrowRight",
  "Space",
]);

interface PlayerProps {
  onMoveStateChange: (moving: boolean) => void;
  registry: CombatantRegistry;
  onDamageTaken: (damage: number) => void;
  spawnPosition?: [number, number, number];
  // Duel mode only — the default camera facing (-Z) is fine for one spawn
  // but leaves the other player facing away from their opponent, so this
  // sets the initial look direction once on mount.
  spawnYaw?: number;
  // Duel mode only — throttled (not every frame) so the network isn't fed
  // 60 updates/sec for something a 15-20Hz tick already reads smoothly
  // once RemotePlayer interpolates between samples.
  onNetworkTick?: (position: [number, number, number], quaternion: [number, number, number, number], moving: boolean) => void;
}

export interface PlayerHandle {
  // Duel mode only — teleport back to a spawn point after a server-driven
  // respawn (a kill that didn't end the match).
  respawn: (position: [number, number, number]) => void;
}

// ──────────────────────────────────────────────────────
//  PLAYER – Rapier KinematicCharacterController
// ──────────────────────────────────────────────────────
const Player = forwardRef<PlayerHandle, PlayerProps>(function Player(
  { onMoveStateChange, registry, onDamageTaken, spawnPosition = [0, 1.5, 0], spawnYaw, onNetworkTick },
  ref
) {
  const rigidBodyRef = useRef<RapierRigidBody>(null);
  const pressedKeys = useRef(new Set<string>());
  const { world } = useRapier();
  const { camera } = useThree();
  const cc = useRef<ReturnType<typeof world.createCharacterController> | null>(null);
  const yVelocity = useRef(0);
  const isMovingRef = useRef(false);
  const wasGroundedRef = useRef(true);
  const jumpHeldRef = useRef(false);
  const stepTimerRef = useRef(0);
  const stanceRef = useRef<"stand" | "crouch" | "prone">("stand");
  const eyeHeightRef = useRef(EYE_HEIGHT);
  const crouchKeyHeldRef = useRef(false);
  const proneKeyHeldRef = useRef(false);
  // Scratch vectors reused every frame instead of `new THREE.Vector3(...)`
  // — this runs once per player (not per-bot), so it's a smaller win than
  // the same fix in Bot.tsx, but free to avoid all the same.
  const camDirVec = useRef(new THREE.Vector3());
  const camRightVec = useRef(new THREE.Vector3());
  const horizontalVec = useRef(new THREE.Vector3());
  const netTimerRef = useRef(0);

  // Register as a combat target so enemy bots (and, in TDM, ally bots avoiding
  // friendly fire) can find the player through the shared registry.
  useEffect(() => {
    registry.set("player", {
      id: "player",
      team: "friendly",
      position: new THREE.Vector3(),
      alive: true,
      damage: onDamageTaken,
    });
    return () => {
      registry.delete("player");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registry]);

  useEffect(() => {
    const controller = world.createCharacterController(0.005);
    controller.setMaxSlopeClimbAngle(50 * (Math.PI / 180));
    controller.setMinSlopeSlideAngle(60 * (Math.PI / 180));
    controller.enableAutostep(0.16, 0.05, true);
    controller.enableSnapToGround(0.08);
    cc.current = controller;
    return () => {
      world.removeCharacterController(controller);
    };
  }, [world]);

  useEffect(() => {
    const getId = (e: KeyboardEvent) => e.code || e.key;
    const onDown = (e: KeyboardEvent) => {
      if (movementKeys.has(e.code)) e.preventDefault();
      pressedKeys.current.add(getId(e));
      pressedKeys.current.add(e.key.toLowerCase());
    };
    const onUp = (e: KeyboardEvent) => {
      pressedKeys.current.delete(getId(e));
      pressedKeys.current.delete(e.key.toLowerCase());
    };
    const onBlur = () => pressedKeys.current.clear();

    window.addEventListener("keydown", onDown, { passive: false });
    window.addEventListener("keyup", onUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  // Duel mode: face the opponent's spawn instead of always defaulting to
  // the scene's -Z. Set once on mount only — PointerLockControls re-derives
  // its own tracking from the camera's current quaternion on every
  // mousemove (never caches an absolute value), so this composes safely
  // with mouse-look instead of fighting it.
  useEffect(() => {
    if (spawnYaw !== undefined) camera.rotation.set(0, spawnYaw, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useFrame((state, delta) => {
    if (!rigidBodyRef.current || !cc.current) return;

    const pressed = (k: string) => pressedKeys.current.has(k);

    const fwd = pressed("KeyW") || pressed("w");
    const bwd = pressed("KeyS") || pressed("s");
    const lft = pressed("KeyA") || pressed("a");
    const rgt = pressed("KeyD") || pressed("d");
    const jump = pressed("Space") || pressed(" ");

    // Crouch (C) / Prone (Ctrl) — edge-triggered toggles, prone wins if both
    // are pressed. Standing back up cancels either.
    const crouchKey = pressed("KeyC") || pressed("c");
    const proneKey = pressed("ControlLeft") || pressed("ControlRight") || pressed("control");
    if (crouchKey && !crouchKeyHeldRef.current) {
      stanceRef.current = stanceRef.current === "crouch" ? "stand" : "crouch";
    }
    if (proneKey && !proneKeyHeldRef.current) {
      stanceRef.current = stanceRef.current === "prone" ? "stand" : "prone";
    }
    crouchKeyHeldRef.current = crouchKey;
    proneKeyHeldRef.current = proneKey;
    if (jump && stanceRef.current !== "stand") stanceRef.current = "stand"; // jumping stands you up

    const targetEyeHeight =
      stanceRef.current === "prone" ? PRONE_HEIGHT : stanceRef.current === "crouch" ? CROUCH_HEIGHT : EYE_HEIGHT;
    eyeHeightRef.current = THREE.MathUtils.damp(eyeHeightRef.current, targetEyeHeight, 8, delta);
    const stanceSpeedMult =
      stanceRef.current === "prone" ? PRONE_SPEED_MULT : stanceRef.current === "crouch" ? CROUCH_SPEED_MULT : 1;

    const currentlyMoving = fwd || bwd || lft || rgt;
    if (currentlyMoving !== isMovingRef.current) {
      isMovingRef.current = currentlyMoving;
      onMoveStateChange(currentlyMoving);
    }

    // Horizontal direction relative to camera
    const camDir = camDirVec.current;
    state.camera.getWorldDirection(camDir);
    camDir.y = 0;
    camDir.normalize();

    const camRight = camRightVec.current.set(1, 0, 0).applyQuaternion(state.camera.quaternion);
    camRight.y = 0;
    camRight.normalize();

    const horizontal = horizontalVec.current.set(0, 0, 0);
    if (fwd) horizontal.add(camDir);
    if (bwd) horizontal.sub(camDir);
    if (rgt) horizontal.add(camRight);
    if (lft) horizontal.sub(camRight);
    if (horizontal.lengthSq() > 0) horizontal.normalize().multiplyScalar(MOVE_SPEED * stanceSpeedMult);

    // Gravity & Grounding
    const grounded = cc.current.computedGrounded();
    if (grounded && jump && !jumpHeldRef.current) playJumpSound();
    if (!wasGroundedRef.current && grounded) playLandSound();
    wasGroundedRef.current = grounded;
    jumpHeldRef.current = jump;

    if (grounded) {
      yVelocity.current = jump ? JUMP_FORCE : -0.1;
    } else {
      yVelocity.current = Math.max(yVelocity.current + GRAVITY * delta, -20);
    }

    const collider = rigidBodyRef.current.collider(0);
    if (!collider) return;

    cc.current.computeColliderMovement(collider, {
      x: horizontal.x * delta,
      y: yVelocity.current * delta,
      z: horizontal.z * delta,
    });

    const corrected = cc.current.computedMovement();
    const pos = rigidBodyRef.current.translation();
    rigidBodyRef.current.setNextKinematicTranslation({
      x: pos.x + corrected.x,
      y: pos.y + corrected.y,
      z: pos.z + corrected.z,
    });

    // Camera sync with a small movement bob for a grounded FPS feel.
    const newPos = rigidBodyRef.current.translation();
    const bobSpeed = stanceRef.current === "stand" ? 10 : 7;
    const bobAmount = stanceRef.current === "stand" ? 0.018 : 0.01;
    const bob = currentlyMoving && grounded ? Math.sin(state.clock.elapsedTime * bobSpeed) * bobAmount : 0;
    state.camera.position.set(newPos.x, newPos.y + eyeHeightRef.current + bob, newPos.z);

    const playerEntry = registry.get("player");
    if (playerEntry) playerEntry.position.copy(state.camera.position);

    // Duel mode: broadcast this player's camera pose to the opponent.
    if (onNetworkTick) {
      netTimerRef.current -= delta;
      if (netTimerRef.current <= 0) {
        netTimerRef.current = 0.05; // ~20Hz
        const camPos = state.camera.position;
        const camQuat = state.camera.quaternion;
        onNetworkTick(
          [camPos.x, camPos.y, camPos.z],
          [camQuat.x, camQuat.y, camQuat.z, camQuat.w],
          currentlyMoving
        );
      }
    }

    // Footsteps, timed to the bob cycle (slower and quieter while crouched/prone)
    if (currentlyMoving && grounded) {
      stepTimerRef.current += delta;
      const stepInterval = stanceRef.current === "stand" ? 0.33 : stanceRef.current === "crouch" ? 0.48 : 0.7;
      if (stepTimerRef.current >= stepInterval) {
        stepTimerRef.current = 0;
        playFootstepSound();
      }
    } else {
      stepTimerRef.current = 0;
    }
  });

  useImperativeHandle(ref, () => ({
    respawn: (position) => {
      rigidBodyRef.current?.setTranslation({ x: position[0], y: position[1], z: position[2] }, true);
      yVelocity.current = 0;
      stanceRef.current = "stand";
      eyeHeightRef.current = EYE_HEIGHT;
    },
  }));

  return (
    <RigidBody
      ref={rigidBodyRef}
      type="kinematicPosition"
      colliders={false}
      position={spawnPosition}
      enabledRotations={[false, false, false]}
      canSleep={false}
    >
      <CapsuleCollider args={[0.06, 0.06]} friction={0} restitution={0} />
    </RigidBody>
  );
});

function HumanTarget({ position }: { position: [number, number, number] }) {
  return (
    <group position={position}>
      <mesh position={[0, 0.9, 0]} castShadow>
        <capsuleGeometry args={[0.22, 0.7, 8, 16]} />
        <meshStandardMaterial color="#2563eb" roughness={0.65} metalness={0.15} />
      </mesh>
      <mesh position={[0, 1.55, 0]} castShadow>
        <sphereGeometry args={[0.22, 16, 12]} />
        <meshStandardMaterial color="#f1b089" roughness={0.8} />
      </mesh>
      <mesh position={[-0.36, 0.92, 0]} rotation={[0, 0, -0.18]} castShadow>
        <capsuleGeometry args={[0.08, 0.58, 8, 12]} />
        <meshStandardMaterial color="#1d4ed8" roughness={0.7} />
      </mesh>
      <mesh position={[0.36, 0.92, 0]} rotation={[0, 0, 0.18]} castShadow>
        <capsuleGeometry args={[0.08, 0.58, 8, 12]} />
        <meshStandardMaterial color="#1d4ed8" roughness={0.7} />
      </mesh>
      <mesh position={[-0.13, 0.08, 0]} castShadow>
        <capsuleGeometry args={[0.09, 0.62, 8, 12]} />
        <meshStandardMaterial color="#111827" roughness={0.85} />
      </mesh>
      <mesh position={[0.13, 0.08, 0]} castShadow>
        <capsuleGeometry args={[0.09, 0.62, 8, 12]} />
        <meshStandardMaterial color="#111827" roughness={0.85} />
      </mesh>
    </group>
  );
}

// ──────────────────────────────────────────────────────
//  INTERACTIVE TARGET DUMMIES
// ──────────────────────────────────────────────────────
interface TargetProps {
  position: [number, number, number];
  color: string;
}

function ShootableTarget({ position, color }: TargetProps) {
  const bodyRef = useRef<RapierRigidBody>(null);
  const [hitCount, setHitCount] = useState(0);

  return (
    <RigidBody
      ref={bodyRef}
      position={position}
      type="dynamic"
      colliders="cuboid"
      linearDamping={0.5}
      angularDamping={0.5}
      userData={{ isTarget: true, onHit: () => setHitCount((h) => h + 1) }}
    >
      <mesh castShadow receiveShadow>
        <boxGeometry args={[0.3, 0.6, 0.3]} />
        <meshStandardMaterial
          color={hitCount % 2 === 1 ? "#ef4444" : color}
          metalness={0.4}
          roughness={0.3}
          emissive={hitCount > 0 ? "#f97316" : "#000000"}
          emissiveIntensity={0.3}
        />
      </mesh>
      {/* Bullseye Ring */}
      <mesh position={[0, 0.1, 0.16]}>
        <ringGeometry args={[0.04, 0.08, 16]} />
        <meshBasicMaterial color="#ef4444" side={THREE.DoubleSide} />
      </mesh>
    </RigidBody>
  );
}

// ──────────────────────────────────────────────────────
//  RAYCAST SHOOTING CONTROLLER (Inside Canvas)
// ──────────────────────────────────────────────────────
interface RaycastShooterProps {
  onRegisterShot: (fn: (muzzlePos: THREE.Vector3) => void) => void;
  bulletEffectsRef: React.RefObject<BulletEffectsHandle | null>;
  onTargetHit: (headshot: boolean) => void;
  // Duel mode only — lets the opponent see this shot's tracer too.
  onShotFired?: (from: THREE.Vector3, to: THREE.Vector3) => void;
}

// Walks up from a mesh to see if it hangs off the first-person weapon rig
// (named "weaponGroupRef" — see Weapon.tsx), so shots never hit the player's
// own gun/hands.
function isWeaponDescendant(obj: THREE.Object3D): boolean {
  let cur: THREE.Object3D | null = obj;
  while (cur) {
    if (cur.name === "weaponGroupRef") return true;
    cur = cur.parent;
  }
  return false;
}

// Right-click hold zooms the aim in; releasing eases it back out. Expressed
// as a fraction of the resting FOV, applied to the same `baseFov` the shot
// recoil "punch" below already eases the camera toward every frame — so
// aiming in and out both animate for free through that existing damp(),
// instead of needing a second FOV chase.
const AIM_ZOOM_FOV_MULT = 0.7;

function RaycastShooter({ onRegisterShot, bulletEffectsRef, onTargetHit, onShotFired }: RaycastShooterProps) {
  const { scene } = useThree();
  const store = useStore();
  const raycaster = useRef(new THREE.Raycaster());
  const baseFov = useRef((store.getState().camera as THREE.PerspectiveCamera).fov);
  // The un-zoomed resting FOV, captured once — baseFov itself now flips
  // between this and the zoomed value while aiming (see the mouse listeners
  // below), rather than always being the fixed rest value.
  const restFov = useRef((store.getState().camera as THREE.PerspectiveCamera).fov);
  const centerNdc = useRef(new THREE.Vector2(0, 0));
  const farPointVec = useRef(new THREE.Vector3());

  // Shootable meshes are collected by walking the whole scene graph, which
  // is too expensive to redo on every single shot (a full-auto spray fires
  // ~9x/sec) — it was previously the single biggest cause of stutter while
  // firing. The map/bots/targets barely change shape mid-match, so a cache
  // refreshed a couple times a second is indistinguishable in gameplay
  // terms but removes that per-shot spike entirely.
  const shootableCache = useRef<THREE.Object3D[]>([]);
  const cacheRefreshTimer = useRef(0);

  // Tiny FOV "punch" per shot, eased back every frame — cheap recoil feel
  // that can't fight PointerLockControls since it never touches rotation.
  // Camera is read via the useFrame `state` param (like Player/Weapon do)
  // rather than a destructured useThree() value, since R3F's render model
  // relies on mutating three.js objects every frame.
  useFrame((state, delta) => {
    const cam = state.camera as THREE.PerspectiveCamera;
    if (Math.abs(cam.fov - baseFov.current) > 0.001) {
      cam.fov = THREE.MathUtils.damp(cam.fov, baseFov.current, 10, delta);
      cam.updateProjectionMatrix();
    }

    cacheRefreshTimer.current -= delta;
    if (cacheRefreshTimer.current <= 0) {
      cacheRefreshTimer.current = 0.5;
      const list: THREE.Object3D[] = [];
      scene.traverse((child) => {
        if ((child as THREE.Mesh).isMesh && !isWeaponDescendant(child)) {
          list.push(child);
        }
      });
      shootableCache.current = list;
    }
  });

  const shootRay = useCallback(
    (muzzlePos: THREE.Vector3) => {
      // Imperative store access — safe to mutate outside the render/frame loop.
      const cam = store.getState().camera as THREE.PerspectiveCamera;
      cam.fov = Math.min(cam.fov + 1.4, baseFov.current + 2.5);
      cam.updateProjectionMatrix();

      raycaster.current.setFromCamera(centerNdc.current, cam);

      const intersects = raycaster.current.intersectObjects(shootableCache.current, false);

      if (intersects.length > 0) {
        const hit = intersects[0];
        const hitPoint = hit.point;
        const hitNormal = hit.face ? hit.face.normal.clone().applyQuaternion(hit.object.quaternion) : new THREE.Vector3(0, 1, 0);

        bulletEffectsRef.current?.addShot(muzzlePos, hitPoint, hitNormal);
        onShotFired?.(muzzlePos, hitPoint);

        // Check if target was hit. hitPoint is passed through for targets
        // that care where exactly they were hit — Bot/RemotePlayer use it
        // for headshot detection and report the verdict back via onHit's
        // return value, so the hitmarker/sound can react immediately
        // instead of waiting on anything async. ShootableTarget's onHit
        // takes no arguments and returns nothing, which reads as "not a
        // headshot" below.
        let currentObj: THREE.Object3D | null = hit.object;
        while (currentObj) {
          if (currentObj.userData?.isTarget) {
            const headshot = !!currentObj.userData.onHit?.(hitPoint);
            onTargetHit(headshot);
            break;
          }
          currentObj = currentObj.parent;
        }
      } else {
        // Did not hit any object; shoot ray far forward
        const farPoint = raycaster.current.ray.at(100, farPointVec.current);
        bulletEffectsRef.current?.addShot(muzzlePos, farPoint);
        onShotFired?.(muzzlePos, farPoint);
      }
    },
    [store, bulletEffectsRef, onTargetHit, onShotFired]
  );

  useEffect(() => {
    onRegisterShot(shootRay);
  }, [shootRay, onRegisterShot]);

  // Right-click-hold aim zoom. Only the target (baseFov) changes here — the
  // useFrame damp() above does the actual smooth in/out animation either
  // way, so releasing eases back to normal instead of snapping.
  useEffect(() => {
    const setAiming = (aiming: boolean) => {
      baseFov.current = aiming ? restFov.current * AIM_ZOOM_FOV_MULT : restFov.current;
    };
    const onMouseDown = (e: MouseEvent) => {
      if (e.button === 2 && document.pointerLockElement) setAiming(true);
    };
    const onMouseUp = (e: MouseEvent) => {
      if (e.button === 2) setAiming(false);
    };
    // Right-click would otherwise pop the browser's context menu.
    const onContextMenu = (e: MouseEvent) => e.preventDefault();
    // Losing pointer lock mid-aim (Esc, alt-tab) would otherwise leave the
    // camera stuck zoomed in with no mouseup ever coming.
    const onPointerLockChange = () => {
      if (!document.pointerLockElement) setAiming(false);
    };
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mouseup", onMouseUp);
    window.addEventListener("contextmenu", onContextMenu);
    document.addEventListener("pointerlockchange", onPointerLockChange);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("contextmenu", onContextMenu);
      document.removeEventListener("pointerlockchange", onPointerLockChange);
    };
  }, []);

  return null;
}

// ──────────────────────────────────────────────────────
//  ENVIRONMENT LIGHTING
// ──────────────────────────────────────────────────────
const SUN_POSITION: [number, number, number] = [60, 55, 35];

function Environment({ shadowsEnabled }: { shadowsEnabled: boolean }) {
  return (
    <>
      <color attach="background" args={["#bfe3ff"]} />
      <fog attach="fog" args={["#cfe9ff", 22, 75]} />
      <Sky sunPosition={SUN_POSITION} turbidity={3.5} rayleigh={1.2} mieCoefficient={0.006} mieDirectionalG={0.85} />

      <hemisphereLight args={["#bde3ff", "#7a6a52", 0.75]} />
      <ambientLight intensity={0.45} />
      <directionalLight
        position={SUN_POSITION}
        intensity={2.6}
        color="#fff6e0"
        castShadow={shadowsEnabled}
        shadow-mapSize={[1024, 1024]}
        shadow-camera-left={-22}
        shadow-camera-right={22}
        shadow-camera-top={22}
        shadow-camera-bottom={-22}
        shadow-camera-far={70}
        shadow-bias={-0.0004}
      />
      {/* Subtle colorful accents so the container-yard props still pop up close */}
      <pointLight position={[-10, 5, -10]} intensity={0.5} color="#38bdf8" distance={20} />
      <pointLight position={[10, 5, 10]} intensity={0.5} color="#f97316" distance={20} />
    </>
  );
}

// ──────────────────────────────────────────────────────
//  MAIN APP
// ──────────────────────────────────────────────────────
export default function App() {
  const [isLocked, setIsLocked] = useState(false);
  const [isMoving, setIsMoving] = useState(false);
  const [ammo, setAmmo] = useState(30);
  const [isReloading, setIsReloading] = useState(false);
  const [score, setScore] = useState(0);
  const [hitmarker, setHitmarker] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [settings, setSettings] = useState<GraphicsSettings>(() => loadGraphicsSettings());
  const [showSettings, setShowSettings] = useState(false);
  const compassRef = useRef<CompassHandle>(null);

  const updateSettings = useCallback((next: GraphicsSettings) => {
    setSettings(next);
    saveGraphicsSettings(next);
  }, []);

  // 1v1 duel (online multiplayer) — see network.ts / server/. The server is
  // authoritative for health/kills/deaths/headshots/the timer; this state
  // is just a mirror of what it last told us. Declared early since several
  // handlers below reference these.
  const [duelStatus, setDuelStatus] = useState<DuelStatus>("idle");
  const [isPlayerOne, setIsPlayerOne] = useState(true);
  const [opponentHealth, setOpponentHealth] = useState(100);
  const [duelStats, setDuelStats] = useState<PlayerStats>({ kills: 0, deaths: 0, headshots: 0 });
  const [duelOpponentStats, setDuelOpponentStats] = useState<PlayerStats>({ kills: 0, deaths: 0, headshots: 0 });
  const [duelKillLimit, setDuelKillLimit] = useState(20);
  const [duelTimeLimit, setDuelTimeLimit] = useState(300);
  const [duelTimeRemaining, setDuelTimeRemaining] = useState(300);
  const [duelEndReason, setDuelEndReason] = useState<DuelMatchEndReason | null>(null);
  const [showScoreboard, setShowScoreboard] = useState(false); // hold-Tab
  const [headshotMarker, setHeadshotMarker] = useState(false);
  // Which of DUEL_SPAWN_PAIRS the initial match placement uses — set from
  // the server's "matched" message so both clients always agree. (Later
  // respawns get their own spawnIndex passed straight into onRespawn,
  // since that's an imperative reposition, not something to re-render.)
  const [duelSpawnIndex, setDuelSpawnIndex] = useState(0);
  // What the player TYPES (editable pre-match) vs. the code the server
  // actually confirmed we're waiting in (shown while queued — lets us
  // display a code even if the player left it blank and the server
  // didn't assign one, i.e. anonymous quick-match).
  const [roomCodeInput, setRoomCodeInput] = useState("");
  const [waitingRoomCode, setWaitingRoomCode] = useState<string | undefined>(undefined);
  // True only right after clicking "Generate" — typing/editing the code by
  // hand (pasting a friend's code to join their room) clears it. Gates the
  // match-settings picker below: only the person creating the room (the one
  // who generated its code) should be choosing kill/time limits, not
  // whoever is about to join with a code someone shared with them.
  const [roomCodeIsGenerated, setRoomCodeIsGenerated] = useState(false);
  // Pre-match picks for a room the player is about to CREATE. Only take
  // effect when they're the first one waiting under a room code — an
  // anonymous quick-match or joining someone else's code ignores these
  // (see network.ts's connect() and server/src/index.ts).
  const [duelKillLimitChoice, setDuelKillLimitChoice] = useState(20);
  const [duelTimeLimitChoice, setDuelTimeLimitChoice] = useState(300);
  const duelConnectionRef = useRef<DuelConnection | null>(null);
  const remotePlayerRef = useRef<RemotePlayerHandle>(null);
  const playerRef = useRef<PlayerHandle>(null);

  const [gameState, setGameState] = useState<GameState>("menu");
  const [mode, setMode] = useState<GameMode>("ffa");
  const [difficulty, setDifficulty] = useState<Difficulty>("medium");
  const [botCount, setBotCount] = useState(3); // FFA enemy count
  const [teamSize, setTeamSize] = useState(2); // TDM: combatants per side, including the player
  const [scoreLimit, setScoreLimit] = useState<number>(defaultKillLimit("ffa"));
  const [timeLimit, setTimeLimit] = useState<number>(DEFAULT_TIME_LIMIT);
  // TDM only: what happens on a tied score at time-out. Off (default) = draw.
  const [suddenDeath, setSuddenDeath] = useState(false);
  const [matchEndReason, setMatchEndReason] = useState<MatchEndReason>(null);

  const [playerHealth, setPlayerHealth] = useState(100);
  const [botHealths, setBotHealths] = useState<number[]>([]); // enemy team
  const [allyHealths, setAllyHealths] = useState<number[]>([]); // TDM only
  // Which ENEMY_SPAWN_POINTS/ALLY_SPAWN_POINTS index each bot slot currently
  // uses — reassigned to a different point each time that slot respawns.
  const [botSpawnIndices, setBotSpawnIndices] = useState<number[]>([]);
  const [allySpawnIndices, setAllySpawnIndices] = useState<number[]>([]);
  const [friendlyKills, setFriendlyKills] = useState(0);
  const [enemyKills, setEnemyKills] = useState(0);
  const [matchElapsed, setMatchElapsed] = useState(0);
  const [damageFlash, setDamageFlash] = useState(false);
  const [matchId, setMatchId] = useState(0);
  const [killFeed, setKillFeed] = useState<{ id: number; text: string; tone: "good" | "bad" }[]>([]);

  const bulletEffectsRef = useRef<BulletEffectsHandle | null>(null);
  const shootCallbackRef = useRef<((muzzlePos: THREE.Vector3) => void) | null>(null);
  // A stable mutable Map, not swapped for the app's lifetime — expressed via
  // useState's lazy initializer (not useRef) so passing it down as a prop
  // during render doesn't trip the "no ref access during render" lint rule.
  const [registry] = useState<CombatantRegistry>(() => new Map());
  const killFeedIdRef = useRef(0);

  // Mirrors of state read inside handlers that must stay referentially
  // stable for the component's whole lifetime (Bot/Player capture them
  // once, at mount, into the shared combat registry — see Bot.tsx).
  const scoreLimitRef = useRef(scoreLimit);
  const modeRef = useRef(mode);
  const timeLimitRef = useRef(timeLimit);
  const suddenDeathRef = useRef(suddenDeath);
  // True once a tied TDM match has gone to sudden death — the very next
  // confirmed kill (either side) ends the match immediately, bypassing the
  // normal kill-limit check. Reset per match in startMatch.
  const suddenDeathActiveRef = useRef(false);
  const timeUpProcessedRef = useRef(false);
  const botHealthsRef = useRef<number[]>([]);
  const allyHealthsRef = useRef<number[]>([]);
  const botSpawnIndicesRef = useRef<number[]>([]);
  const allySpawnIndicesRef = useRef<number[]>([]);
  const friendlyKillsRef = useRef(0);
  const enemyKillsRef = useRef(0);
  const playerHealthRef = useRef(100);
  // Guards pending respawn timeouts: a timeout only applies its revive if
  // it's still the same match and the match is still actually being played
  // (not the "Match Over" screen, which keeps rendering bots at h > 0 but
  // freezes their AI — see Bot.tsx's `active` check).
  const matchIdRef = useRef(0);
  const gameStateRef = useRef<GameState>("menu");
  useEffect(() => {
    gameStateRef.current = gameState;
  }, [gameState]);
  useEffect(() => {
    scoreLimitRef.current = scoreLimit;
  }, [scoreLimit]);
  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);
  useEffect(() => {
    timeLimitRef.current = timeLimit;
  }, [timeLimit]);
  useEffect(() => {
    suddenDeathRef.current = suddenDeath;
  }, [suddenDeath]);

  // Fresh match config screen: default the kill limit to something sane for
  // whichever mode is selected, rather than carrying over the other mode's
  // number (or an unlimited 0). Set directly where mode changes (the menu's
  // mode buttons) rather than in an effect, so switching modes doesn't
  // trigger an extra cascading render.
  const selectMode = useCallback((next: GameMode) => {
    setMode(next);
    if (next === "ffa" || next === "tdm") setScoreLimit(defaultKillLimit(next));
  }, []);

  const pushKillFeed = useCallback((text: string, tone: "good" | "bad" = "good") => {
    const id = ++killFeedIdRef.current;
    setKillFeed((prev) => [...prev.slice(-4), { id, text, tone }]);
    window.setTimeout(() => {
      setKillFeed((prev) => prev.filter((k) => k.id !== id));
    }, 3200);
  }, []);

  const handleRegisterShot = useCallback((fn: (muzzlePos: THREE.Vector3) => void) => {
    shootCallbackRef.current = fn;
  }, []);

  const enemyCount = mode === "tdm" ? teamSize : botCount;
  const allyCount = mode === "tdm" ? teamSize - 1 : 0;

  const startMatch = useCallback(
    (diff: Difficulty) => {
      setDifficulty(diff);
      playerHealthRef.current = 100;
      setPlayerHealth(100);
      const initialEnemies = Array(enemyCount).fill(100);
      const initialAllies = Array(allyCount).fill(100);
      const initialBotSpawnIndices = Array.from({ length: enemyCount }, (_, i) => i % ENEMY_SPAWN_POINTS.length);
      const initialAllySpawnIndices = Array.from({ length: allyCount }, (_, i) => i % ALLY_SPAWN_POINTS.length);
      botHealthsRef.current = initialEnemies;
      allyHealthsRef.current = initialAllies;
      botSpawnIndicesRef.current = initialBotSpawnIndices;
      allySpawnIndicesRef.current = initialAllySpawnIndices;
      friendlyKillsRef.current = 0;
      enemyKillsRef.current = 0;
      setBotHealths(initialEnemies);
      setAllyHealths(initialAllies);
      setBotSpawnIndices(initialBotSpawnIndices);
      setAllySpawnIndices(initialAllySpawnIndices);
      setFriendlyKills(0);
      setEnemyKills(0);
      setMatchElapsed(0);
      setAmmo(30);
      setIsReloading(false);
      setScore(0);
      setKillFeed([]);
      setMatchEndReason(null);
      suddenDeathActiveRef.current = false;
      timeUpProcessedRef.current = false;
      matchIdRef.current += 1;
      setMatchId(matchIdRef.current);
      setGameState("playing");
    },
    [enemyCount, allyCount]
  );

  const handleRematch = useCallback(() => startMatch(difficulty), [startMatch, difficulty]);
  const handleBackToMenu = useCallback(() => {
    duelConnectionRef.current?.disconnect();
    duelConnectionRef.current = null;
    setDuelStatus("idle");
    setGameState("menu");
  }, []);

  // Free the cursor whenever we leave active play (menu / round end).
  useEffect(() => {
    if (gameState !== "playing" && document.pointerLockElement) {
      document.exitPointerLock();
    }
  }, [gameState]);

  // Match clock — ticks once a second while playing. The time-limit check
  // lives inside the interval callback (not the effect body) so it isn't
  // flagged as a synchronous setState-in-effect; it only ever sets state to
  // a fixed resolved value, so it's safe even if invoked more than once.
  useEffect(() => {
    if (gameState !== "playing") return;
    const interval = window.setInterval(() => {
      setMatchElapsed((t) => {
        const next = t + 1;
        const limit = timeLimitRef.current;
        // Guarded by timeUpProcessedRef so this only fires once — without
        // it, a sudden-death match (which deliberately stays "playing"
        // past the limit) would re-run this every second forever.
        if (limit > 0 && next >= limit && !timeUpProcessedRef.current) {
          timeUpProcessedRef.current = true;
          if (modeRef.current === "ffa") {
            // FFA has no second "player" to compare kills against (it's
            // one human vs. bots) — reaching the clock with the map not
            // cleared is a completed run, not a loss, so it's scored as a
            // win with the final kill tally shown on the Match Over screen.
            setMatchEndReason("timeLimit");
            setGameState((gs) => (gs === "playing" ? "won" : gs));
          } else {
            const f = friendlyKillsRef.current;
            const e = enemyKillsRef.current;
            if (f === e && suddenDeathRef.current) {
              // Tied at the buzzer with sudden death on: keep playing.
              // The next confirmed kill (handleHitBot/handleHitAlly)
              // ends the match immediately regardless of the kill limit.
              suddenDeathActiveRef.current = true;
            } else {
              setMatchEndReason("timeLimit");
              setGameState((gs) => (gs === "playing" ? (f === e ? "draw" : f > e ? "won" : "lost") : gs));
            }
          }
        }
        return next;
      });
    }, 1000);
    return () => window.clearInterval(interval);
  }, [gameState]);

  // FFA/TDM only (duel's own health comes straight from the server via
  // onDamaged, never through this path — see startDuelMatch). Dying here
  // works just like a bot dying: the player respawns and the match keeps
  // running, ending only via the kill limit or time limit, same as real
  // deathmatch/TDM — not the instant "you lose" a single death used to cause.
  const handleDamagePlayer = useCallback(
    (dmg: number) => {
      if (playerHealthRef.current <= 0) return; // already down, respawn pending
      const next = Math.max(0, playerHealthRef.current - dmg);
      playerHealthRef.current = next;
      setPlayerHealth(next);
      setDamageFlash(true);
      window.setTimeout(() => setDamageFlash(false), 200);
      playPlayerHurtSound();

      if (next > 0) return;

      pushKillFeed("You were eliminated", "bad");
      const playerEntry = registry.get("player");
      if (playerEntry) playerEntry.alive = false;

      if (modeRef.current === "tdm") {
        enemyKillsRef.current += 1;
        setEnemyKills(enemyKillsRef.current);

        if (suddenDeathActiveRef.current) {
          setMatchEndReason("killLimit");
          setGameState((gs) => (gs === "playing" ? "lost" : gs));
          return;
        }
        const limit = scoreLimitRef.current;
        if (limit > 0 && enemyKillsRef.current >= limit) {
          setMatchEndReason("killLimit");
          setGameState((gs) => (gs === "playing" ? "lost" : gs));
          return;
        }
      }

      const forMatchId = matchIdRef.current;
      window.setTimeout(() => {
        if (matchIdRef.current !== forMatchId || gameStateRef.current !== "playing") return;
        playerHealthRef.current = 100;
        setPlayerHealth(100);
        const entry = registry.get("player");
        if (entry) entry.alive = true;
        playerRef.current?.respawn([0, 1.5, 0]);
      }, RESPAWN_DELAY_MS);
    },
    [pushKillFeed, registry]
  );

  // Brings a dead bot slot back to full health at a freshly-picked spawn
  // point after RESPAWN_DELAY_MS, as long as the match is still the one
  // that killed it and is still actually in progress. Shared by the enemy
  // and ally sides — both respawn the same way, just into different pools.
  const scheduleRespawn = useCallback(
    (
      index: number,
      healthRef: React.MutableRefObject<number[]>,
      setHealth: React.Dispatch<React.SetStateAction<number[]>>,
      spawnIndexRef: React.MutableRefObject<number[]>,
      setSpawnIndex: React.Dispatch<React.SetStateAction<number[]>>,
      spawnPointCount: number,
      forMatchId: number
    ) => {
      window.setTimeout(() => {
        if (matchIdRef.current !== forMatchId || gameStateRef.current !== "playing") return;
        const health = healthRef.current;
        if (index >= health.length || health[index] > 0) return;

        const nextHealth = health.slice();
        nextHealth[index] = 100;
        healthRef.current = nextHealth;
        setHealth(nextHealth);

        const spawnIndices = spawnIndexRef.current;
        const nextSpawnIndices = spawnIndices.slice();
        nextSpawnIndices[index] = pickRespawnSpawnIndex(spawnIndices[index] ?? 0, spawnPointCount);
        spawnIndexRef.current = nextSpawnIndices;
        setSpawnIndex(nextSpawnIndices);
      }, RESPAWN_DELAY_MS);
    },
    []
  );

  // Enemy-team bot took damage — from the player's own raycast (no
  // attackerId), an ally bot's attack, or in FFA another enemy bot (bots
  // there are hostile to everyone, including each other — see Bot.tsx's
  // freeForAll targeting). Only a kill the player or their own team
  // actually landed should count toward the player's score/win condition.
  const handleHitBot = useCallback(
    (index: number, dmg: number, attackerId?: string, headshot?: boolean) => {
      const arr = botHealthsRef.current;
      const prevHealth = arr[index] ?? 0;
      if (prevHealth <= 0) return;
      const nextHealth = Math.max(0, prevHealth - dmg);
      const nextArr = arr.slice();
      nextArr[index] = nextHealth;
      botHealthsRef.current = nextArr;
      setBotHealths(nextArr);

      if (nextHealth <= 0) {
        const creditsPlayer = attackerId === undefined || attackerId.startsWith("ally-");
        if (creditsPlayer) {
          pushKillFeed(headshot ? `Headshot — you eliminated Enemy ${index + 1}` : `You eliminated Enemy ${index + 1}`, "good");
          friendlyKillsRef.current += 1;
          setFriendlyKills(friendlyKillsRef.current);

          // A tied match gone to sudden death ends on the very next kill,
          // no matter the kill limit — this counts, so it wins outright.
          if (suddenDeathActiveRef.current) {
            setMatchEndReason("killLimit");
            setGameState((gs) => (gs === "playing" ? "won" : gs));
            return;
          }

          const limit = scoreLimitRef.current;
          if (limit > 0 && friendlyKillsRef.current >= limit) {
            setMatchEndReason("killLimit");
            setGameState((gs) => (gs === "playing" ? "won" : gs));
            return;
          }
        } else {
          pushKillFeed(`Enemy ${index + 1} was eliminated`, "good");
        }

        // Bring this bot back at a different spawn point instead of ending
        // the match just because the bots currently on the map are dead —
        // the match keeps running until the kill limit (or time limit) is
        // actually reached.
        scheduleRespawn(
          index,
          botHealthsRef,
          setBotHealths,
          botSpawnIndicesRef,
          setBotSpawnIndices,
          ENEMY_SPAWN_POINTS.length,
          matchIdRef.current
        );
      }
    },
    [pushKillFeed, scheduleRespawn]
  );

  // Ally bot (TDM only) took damage from an enemy bot's attack.
  const handleHitAlly = useCallback(
    (index: number, dmg: number) => {
      const arr = allyHealthsRef.current;
      const prevHealth = arr[index] ?? 0;
      if (prevHealth <= 0) return;
      const nextHealth = Math.max(0, prevHealth - dmg);
      const nextArr = arr.slice();
      nextArr[index] = nextHealth;
      allyHealthsRef.current = nextArr;
      setAllyHealths(nextArr);

      if (nextHealth <= 0) {
        pushKillFeed(`Ally ${index + 1} was eliminated`, "bad");
        enemyKillsRef.current += 1;
        setEnemyKills(enemyKillsRef.current);

        if (suddenDeathActiveRef.current) {
          setMatchEndReason("killLimit");
          setGameState((gs) => (gs === "playing" ? "lost" : gs));
          return;
        }

        const limit = scoreLimitRef.current;
        if (limit > 0 && enemyKillsRef.current >= limit) {
          setMatchEndReason("killLimit");
          setGameState((gs) => (gs === "playing" ? "lost" : gs));
          return;
        }

        // Same respawn treatment as enemy bots, so allies keep fighting
        // alongside the player instead of staying dead for the rest of TDM.
        scheduleRespawn(
          index,
          allyHealthsRef,
          setAllyHealths,
          allySpawnIndicesRef,
          setAllySpawnIndices,
          ALLY_SPAWN_POINTS.length,
          matchIdRef.current
        );
      }
    },
    [pushKillFeed, scheduleRespawn]
  );

  // Fullscreen: track browser state and expose a toggle for the button + click-to-play.
  useEffect(() => {
    const onFsChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      document.documentElement.requestFullscreen().catch(() => {});
    }
  }, []);

  // Ambient atmosphere bed plays while the player is actively in the game.
  useEffect(() => {
    if (isLocked) {
      startAmbientAmbience();
    } else {
      stopAmbientAmbience();
    }
  }, [isLocked]);

  const handleShoot = useCallback((muzzlePos: THREE.Vector3) => {
    if (shootCallbackRef.current) {
      shootCallbackRef.current(muzzlePos);
    }
  }, []);

  // Duel mode only — lets the opponent see this shot's tracer/muzzle flash
  // too (RaycastShooter still resolves hit detection locally either way).
  const handleShotFired = useCallback((from: THREE.Vector3, to: THREE.Vector3) => {
    duelConnectionRef.current?.sendShot([from.x, from.y, from.z], [to.x, to.y, to.z]);
  }, []);

  const handleTargetHit = useCallback((headshot: boolean) => {
    setScore((s) => s + (headshot ? 200 : 100));
    if (headshot) {
      setHeadshotMarker(true);
      window.setTimeout(() => setHeadshotMarker(false), 220);
      playHeadshotSound();
    } else {
      setHitmarker(true);
      window.setTimeout(() => setHitmarker(false), 120);
      playHitSound();
    }
  }, []);

  // isPlayerOne mirror — the DuelConnection callbacks below are created
  // once per match and live for its whole duration, so they need a ref
  // (not the state value) to see the CURRENT assignment rather than
  // whatever isPlayerOne was at the moment the callbacks were built.
  const isPlayerOneRef = useRef(true);

  const startDuelMatch = useCallback(() => {
    duelConnectionRef.current?.disconnect();

    setPlayerHealth(100);
    setOpponentHealth(100);
    setDuelStats({ kills: 0, deaths: 0, headshots: 0 });
    setDuelOpponentStats({ kills: 0, deaths: 0, headshots: 0 });
    setDuelEndReason(null);
    // Defensive: clear any stale FFA/TDM bot state left over from a
    // previous match played before switching modes.
    botHealthsRef.current = [];
    allyHealthsRef.current = [];
    setBotHealths([]);
    setAllyHealths([]);
    setAmmo(30);
    setIsReloading(false);
    setScore(0);
    setKillFeed([]);
    setDuelStatus("connecting");
    setWaitingRoomCode(undefined);

    const conn = new DuelConnection({
      onStatusChange: (status) => setDuelStatus(status),
      onQueued: (roomCode) => setWaitingRoomCode(roomCode),
      onMatched: (playerIsOne, killLimit, timeLimitSeconds, spawnIndex) => {
        isPlayerOneRef.current = playerIsOne;
        setIsPlayerOne(playerIsOne);
        setDuelKillLimit(killLimit);
        setDuelTimeLimit(timeLimitSeconds);
        setDuelTimeRemaining(timeLimitSeconds);
        setDuelSpawnIndex(spawnIndex);
        setMatchId((id) => id + 1);
        setGameState("playing");
      },
      onOpponentState: (position, quaternion, moving) => {
        remotePlayerRef.current?.updateState(position, quaternion, moving);
      },
      onOpponentShot: (from, to) => {
        bulletEffectsRef.current?.addShot(
          new THREE.Vector3(from[0], from[1], from[2]),
          new THREE.Vector3(to[0], to[1], to[2])
        );
        remotePlayerRef.current?.muzzleFlash();
      },
      onHitResult: (headshot, _damage, killed, yourStats, opponentStats, opponentHealth) => {
        setDuelStats(yourStats);
        setDuelOpponentStats(opponentStats);
        setOpponentHealth(opponentHealth);
        setHitmarker(true);
        window.setTimeout(() => setHitmarker(false), 120);
        if (headshot) {
          setHeadshotMarker(true);
          window.setTimeout(() => setHeadshotMarker(false), 220);
          playHeadshotSound();
        } else {
          playHitSound();
        }
        if (killed) pushKillFeed("You eliminated the opponent", "good");
      },
      onDamaged: (headshot, _damage, health, yourStats, opponentStats) => {
        setPlayerHealth(health);
        setDuelStats(yourStats);
        setDuelOpponentStats(opponentStats);
        setDamageFlash(true);
        window.setTimeout(() => setDamageFlash(false), 200);
        playPlayerHurtSound();
        if (health <= 0) pushKillFeed(headshot ? "Headshot — you were eliminated" : "You were eliminated", "bad");
      },
      onRespawn: (forYou, spawnIndex) => {
        if (forYou) {
          setPlayerHealth(100);
          const spawn = DUEL_SPAWN_PAIRS[spawnIndex][isPlayerOneRef.current ? 0 : 1];
          playerRef.current?.respawn(spawn);
        } else {
          setOpponentHealth(100);
        }
      },
      onTimer: (remaining) => setDuelTimeRemaining(remaining),
      onMatchEnded: (result, reason, yourStats, opponentStats) => {
        setDuelStats(yourStats);
        setDuelOpponentStats(opponentStats);
        setDuelEndReason(reason);
        setGameState((gs) => (gs === "playing" ? (result === "won" ? "won" : result === "lost" ? "lost" : "draw") : gs));
      },
    });
    duelConnectionRef.current = conn;
    conn.connect(roomCodeInput.trim() || undefined, duelKillLimitChoice, duelTimeLimitChoice);
  }, [pushKillFeed, roomCodeInput, duelKillLimitChoice, duelTimeLimitChoice]);

  const handleOpponentHit = useCallback((headshot: boolean) => {
    duelConnectionRef.current?.sendHit(headshot);
  }, []);

  const handleDuelNetworkTick = useCallback(
    (position: [number, number, number], quaternion: [number, number, number, number], moving: boolean) => {
      duelConnectionRef.current?.sendState(position, quaternion, moving);
    },
    []
  );

  // Hold-Tab scoreboard, duel mode only.
  useEffect(() => {
    if (mode !== "duel" || gameState !== "playing") return;
    const onDown = (e: KeyboardEvent) => {
      if (e.code === "Tab") {
        e.preventDefault();
        setShowScoreboard(true);
      }
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.code === "Tab") setShowScoreboard(false);
    };
    const onBlur = () => setShowScoreboard(false);
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", onBlur);
      setShowScoreboard(false);
    };
  }, [mode, gameState]);

  // Disconnect on unmount and whenever we leave duel mode.
  useEffect(() => {
    return () => {
      duelConnectionRef.current?.disconnect();
      duelConnectionRef.current = null;
    };
  }, []);

  return (
    <div
      className="relative w-screen h-screen bg-black overflow-hidden select-none font-sans"
      onClick={() => {
        if (!document.fullscreenElement) toggleFullscreen();
      }}
    >
        {/* Main Menu: mode + difficulty select */}
        {gameState === "menu" && (
          <div
            className="absolute inset-0 z-40 flex flex-col items-center justify-center bg-black/80 backdrop-blur-sm overflow-y-auto py-8"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="bg-neutral-900/95 border border-emerald-500/40 rounded-2xl px-10 py-8 text-center shadow-[0_0_60px_rgba(16,185,129,0.15)] max-w-md w-[90vw] my-auto">
              <div className="mb-4">
                <GunXorLogo size="lg" className="drop-shadow-[0_0_18px_rgba(16,185,129,0.35)]" />
              </div>
              <p className="text-emerald-400 font-bold text-2xl tracking-wider uppercase mb-1">
                {mode === "ffa"
                  ? `1 vs ${botCount} Bot${botCount > 1 ? "s" : ""}`
                  : mode === "tdm"
                    ? `${teamSize} vs ${teamSize}`
                    : "1 vs 1 Duel"}
              </p>
              <p className="text-neutral-400 text-xs mb-6">
                {mode === "ffa"
                  ? "Face off against bots roaming the map. Clear them all to win."
                  : mode === "tdm"
                    ? "Fight alongside allied bots against an enemy team. Wipe them out to win."
                    : `Online 1v1 against a real opponent. First to ${duelKillLimit} kills or ${Math.round(duelTimeLimit / 60)} min wins.`}
              </p>

              <p className="text-neutral-300 text-xs uppercase tracking-widest mb-2">Mode</p>
              <div className="grid grid-cols-3 gap-2 mb-6">
                <button
                  type="button"
                  onClick={() => selectMode("ffa")}
                  className={`rounded-xl border py-2.5 text-xs font-bold uppercase tracking-wide transition-colors ${
                    mode === "ffa"
                      ? "bg-emerald-500/20 border-emerald-500/70 text-emerald-300"
                      : "bg-neutral-800/60 border-neutral-700 text-neutral-400 hover:border-neutral-500"
                  }`}
                >
                  Free For All
                </button>
                <button
                  type="button"
                  onClick={() => selectMode("tdm")}
                  className={`rounded-xl border py-2.5 text-xs font-bold uppercase tracking-wide transition-colors ${
                    mode === "tdm"
                      ? "bg-emerald-500/20 border-emerald-500/70 text-emerald-300"
                      : "bg-neutral-800/60 border-neutral-700 text-neutral-400 hover:border-neutral-500"
                  }`}
                >
                  Team Deathmatch
                </button>
                <button
                  type="button"
                  onClick={() => selectMode("duel")}
                  className={`rounded-xl border py-2.5 text-xs font-bold uppercase tracking-wide transition-colors ${
                    mode === "duel"
                      ? "bg-emerald-500/20 border-emerald-500/70 text-emerald-300"
                      : "bg-neutral-800/60 border-neutral-700 text-neutral-400 hover:border-neutral-500"
                  }`}
                >
                  1v1 Online
                </button>
              </div>

              {mode === "duel" ? (
                <div className="mb-6">
                  <p className="text-neutral-300 text-xs uppercase tracking-widest mb-2">Room Code (optional)</p>
                  <div className="flex gap-2 mb-2">
                    <input
                      type="text"
                      value={roomCodeInput}
                      onChange={(e) => {
                        setRoomCodeInput(e.target.value.toUpperCase().slice(0, 8));
                        setRoomCodeIsGenerated(false);
                      }}
                      disabled={duelStatus === "connecting" || duelStatus === "queued"}
                      placeholder="Leave blank for quick match"
                      className="flex-1 min-w-0 rounded-lg border border-neutral-700 bg-neutral-800/60 px-3 py-2 text-sm text-center tracking-widest font-mono text-emerald-300 placeholder:text-neutral-500 placeholder:tracking-normal placeholder:font-sans disabled:opacity-60"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        setRoomCodeInput(generateRoomCode());
                        setRoomCodeIsGenerated(true);
                      }}
                      disabled={duelStatus === "connecting" || duelStatus === "queued"}
                      className="shrink-0 rounded-lg border border-emerald-500/50 bg-emerald-500/10 px-3 py-2 text-xs font-bold uppercase tracking-wide text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-60 transition-colors"
                    >
                      Generate
                    </button>
                  </div>
                  <p className="text-neutral-500 text-[10px] mb-3">
                    To play a friend directly: click Generate, share the code with them, and pick your match settings below. They just type that same code in and hit Find Match — no settings to choose on their end. Leave it blank to be paired with anyone.
                  </p>

                  {roomCodeIsGenerated && (
                    <div className="mb-3 text-left">
                      <p className="text-neutral-300 text-xs uppercase tracking-widest mb-2">Match Settings</p>
                      <p className="text-neutral-500 text-[10px] mb-2">
                        You're creating this room, so you choose the rules — your friend just enters the code above to join and play by them.
                      </p>
                      <p className="text-neutral-400 text-[10px] uppercase tracking-wide mb-1">Kill Limit</p>
                      <div className="grid grid-cols-4 gap-1.5 mb-2">
                        {DUEL_KILL_LIMIT_OPTIONS.map((n) => (
                          <button
                            key={n}
                            type="button"
                            onClick={() => setDuelKillLimitChoice(n)}
                            disabled={duelStatus === "connecting" || duelStatus === "queued"}
                            className={`rounded-lg border py-1.5 text-xs font-bold transition-colors disabled:opacity-60 ${
                              duelKillLimitChoice === n
                                ? "bg-emerald-500/20 border-emerald-500/70 text-emerald-300"
                                : "bg-neutral-800/60 border-neutral-700 text-neutral-400 hover:border-neutral-500"
                            }`}
                          >
                            {n}
                          </button>
                        ))}
                      </div>
                      <p className="text-neutral-400 text-[10px] uppercase tracking-wide mb-1">Time Limit</p>
                      <div className="grid grid-cols-3 gap-1.5">
                        {DUEL_TIME_LIMIT_OPTIONS.map((n) => (
                          <button
                            key={n}
                            type="button"
                            onClick={() => setDuelTimeLimitChoice(n)}
                            disabled={duelStatus === "connecting" || duelStatus === "queued"}
                            className={`rounded-lg border py-1.5 text-xs font-bold transition-colors disabled:opacity-60 ${
                              duelTimeLimitChoice === n
                                ? "bg-emerald-500/20 border-emerald-500/70 text-emerald-300"
                                : "bg-neutral-800/60 border-neutral-700 text-neutral-400 hover:border-neutral-500"
                            }`}
                          >
                            {Math.round(n / 60)} min
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="rounded-xl border border-neutral-700 bg-neutral-800/40 py-4 text-xs text-neutral-400 font-mono uppercase tracking-wide">
                    {(duelStatus === "connecting" || duelStatus === "queued") && (
                      <div className="mb-2 opacity-70">
                        <GunXorLogo size="sm" />
                      </div>
                    )}
                    {duelStatus === "connecting" && "Connecting to server…"}
                    {duelStatus === "queued" &&
                      (waitingRoomCode
                        ? <>Room Code <span className="text-emerald-300 font-bold tracking-widest">{waitingRoomCode}</span> — Waiting for Player…</>
                        : <span className="text-emerald-300 animate-pulse">Searching for Opponent…</span>)}
                    {duelStatus === "error" && <span className="normal-case">Couldn't reach the duel server. Is it running?</span>}
                    {duelStatus === "idle" && <span className="normal-case">Click Find Match to get paired with a real opponent.</span>}
                  </div>
                </div>
              ) : mode === "ffa" ? (
                <>
                  <p className="text-neutral-300 text-xs uppercase tracking-widest mb-2">Number of Bots</p>
                  <div className="grid grid-cols-5 gap-2 mb-6">
                    {Array.from({ length: MAX_BOTS }, (_, i) => i + 1).map((n) => (
                      <button
                        key={n}
                        type="button"
                        onClick={() => setBotCount(n)}
                        className={`rounded-xl border py-2.5 text-sm font-bold transition-colors ${
                          botCount === n
                            ? "bg-emerald-500/20 border-emerald-500/70 text-emerald-300"
                            : "bg-neutral-800/60 border-neutral-700 text-neutral-400 hover:border-neutral-500"
                        }`}
                      >
                        {n}
                      </button>
                    ))}
                  </div>
                </>
              ) : (
                <>
                  <p className="text-neutral-300 text-xs uppercase tracking-widest mb-2">Team Size</p>
                  <div className="grid grid-cols-3 gap-2 mb-6">
                    {Array.from({ length: MAX_TEAM_SIZE - 1 }, (_, i) => i + 2).map((n) => (
                      <button
                        key={n}
                        type="button"
                        onClick={() => setTeamSize(n)}
                        className={`rounded-xl border py-2.5 text-sm font-bold transition-colors ${
                          teamSize === n
                            ? "bg-emerald-500/20 border-emerald-500/70 text-emerald-300"
                            : "bg-neutral-800/60 border-neutral-700 text-neutral-400 hover:border-neutral-500"
                        }`}
                      >
                        {n}v{n}
                      </button>
                    ))}
                  </div>
                </>
              )}

              {mode !== "duel" && (
              <>
              <p className="text-neutral-300 text-xs uppercase tracking-widest mb-2">Select Difficulty</p>
              <div className="grid grid-cols-3 gap-2 mb-6">
                {(Object.keys(DIFFICULTY_PRESETS) as Difficulty[]).map((key) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setDifficulty(key)}
                    className={`rounded-xl border px-2 py-2.5 text-xs font-bold uppercase tracking-wide transition-colors ${
                      difficulty === key
                        ? "bg-emerald-500/20 border-emerald-500/70 text-emerald-300"
                        : "bg-neutral-800/60 border-neutral-700 text-neutral-400 hover:border-neutral-500"
                    }`}
                  >
                    {DIFFICULTY_PRESETS[key].label}
                  </button>
                ))}
              </div>
              <p className="text-neutral-500 text-[11px] mb-6 min-h-8">
                {DIFFICULTY_PRESETS[difficulty].description}
              </p>

              <div className="grid grid-cols-2 gap-4 mb-6">
                <div>
                  <p className="text-neutral-300 text-xs uppercase tracking-widest mb-2">Score Limit</p>
                  <div className="flex flex-col gap-1.5">
                    {SCORE_LIMIT_OPTIONS.map((n) => (
                      <button
                        key={n}
                        type="button"
                        onClick={() => setScoreLimit(n)}
                        className={`rounded-lg border py-1.5 text-[11px] font-bold transition-colors ${
                          scoreLimit === n
                            ? "bg-emerald-500/20 border-emerald-500/70 text-emerald-300"
                            : "bg-neutral-800/60 border-neutral-700 text-neutral-400 hover:border-neutral-500"
                        }`}
                      >
                        {formatScoreLimit(n)}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <p className="text-neutral-300 text-xs uppercase tracking-widest mb-2">Time Limit</p>
                  <div className="flex flex-col gap-1.5">
                    {TIME_LIMIT_OPTIONS.map((n) => (
                      <button
                        key={n}
                        type="button"
                        onClick={() => setTimeLimit(n)}
                        className={`rounded-lg border py-1.5 text-[11px] font-bold transition-colors ${
                          timeLimit === n
                            ? "bg-emerald-500/20 border-emerald-500/70 text-emerald-300"
                            : "bg-neutral-800/60 border-neutral-700 text-neutral-400 hover:border-neutral-500"
                        }`}
                      >
                        {formatTimeLimit(n)}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {mode === "tdm" && (
                <div className="flex items-center justify-between mb-6 rounded-xl border border-neutral-700 bg-neutral-800/40 px-3.5 py-2.5">
                  <div className="text-left">
                    <p className="text-neutral-200 text-xs font-bold">Sudden Death on Tie</p>
                    <p className="text-neutral-500 text-[10px]">Off: tied at time-out is a draw. On: next kill wins.</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setSuddenDeath((v) => !v)}
                    className={`shrink-0 w-12 h-6 rounded-full border transition-colors relative ${
                      suddenDeath ? "bg-emerald-500/30 border-emerald-500/70" : "bg-neutral-800 border-neutral-700"
                    }`}
                  >
                    <span
                      className={`absolute top-0.5 w-4 h-4 rounded-full transition-all ${
                        suddenDeath ? "left-6 bg-emerald-400" : "left-0.5 bg-neutral-500"
                      }`}
                    />
                  </button>
                </div>
              )}
              </>
              )}

              {mode === "duel" ? (
                <button
                  type="button"
                  disabled={duelStatus === "connecting" || duelStatus === "queued"}
                  onClick={startDuelMatch}
                  className="w-full bg-emerald-500 hover:bg-emerald-400 disabled:bg-neutral-700 disabled:text-neutral-400 text-neutral-950 font-bold uppercase tracking-wider text-sm py-3 rounded-xl shadow-lg transition-colors"
                >
                  {duelStatus === "connecting" || duelStatus === "queued" ? "Searching…" : "Find Match"}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => startMatch(difficulty)}
                  className="w-full bg-emerald-500 hover:bg-emerald-400 text-neutral-950 font-bold uppercase tracking-wider text-sm py-3 rounded-xl shadow-lg transition-colors"
                >
                  Start Match
                </button>
              )}

              <button
                type="button"
                onClick={() => setShowSettings(true)}
                className="w-full mt-2.5 bg-neutral-800/60 hover:bg-neutral-800 border border-neutral-700 text-neutral-300 hover:text-emerald-300 font-bold uppercase tracking-wider text-xs py-2 rounded-xl transition-colors"
              >
                ⚙ Graphics
              </button>
            </div>
          </div>
        )}

        {/* Round End: win / lose / draw overlay */}
        {(gameState === "won" || gameState === "lost" || gameState === "draw") && (
          <div
            className="absolute inset-0 z-40 flex flex-col items-center justify-center bg-black/80 backdrop-blur-sm"
            onClick={(e) => e.stopPropagation()}
          >
            <div
              className={`bg-neutral-900/95 border rounded-2xl px-10 py-8 text-center shadow-2xl max-w-md w-[90vw] ${
                gameState === "won"
                  ? "border-emerald-500/50"
                  : gameState === "draw"
                    ? "border-amber-500/50"
                    : "border-red-500/50"
              }`}
            >
              <p className="text-neutral-500 text-[10px] uppercase tracking-[0.2em] mb-1">Match Over</p>
              <p
                className={`font-black text-4xl tracking-wider uppercase mb-1 ${
                  gameState === "won" ? "text-emerald-400" : gameState === "draw" ? "text-amber-400" : "text-red-500"
                }`}
              >
                {gameState === "won" ? "You Win" : gameState === "draw" ? "Draw" : "You Lose"}
              </p>
              {mode !== "duel" && matchEndReason && (
                <p className="text-neutral-400 text-xs mb-4">{formatMatchEndReason(matchEndReason)}</p>
              )}
              {mode === "duel" && duelEndReason && (
                <p className="text-neutral-400 text-xs mb-4">
                  {duelEndReason === "killLimit"
                    ? "Kill Limit Reached"
                    : duelEndReason === "timeLimit"
                      ? "Time Limit Reached"
                      : "Opponent Disconnected"}
                </p>
              )}

              {/* Final scoreboard */}
              {mode === "tdm" ? (
                <div className="bg-neutral-800/50 border border-neutral-700 rounded-xl px-4 py-3 mb-6 text-left">
                  <div className="flex items-center justify-center gap-3 text-lg font-bold mb-2">
                    <span className="text-sky-400">{friendlyKills}</span>
                    <span className="text-neutral-600 text-sm">—</span>
                    <span className="text-red-400">{enemyKills}</span>
                    {scoreLimit > 0 && <span className="text-neutral-500 text-xs font-normal">/ {scoreLimit}</span>}
                  </div>
                  <div className="flex justify-between text-[11px] text-neutral-400">
                    <span>Allies alive: {allyHealths.filter((h) => h > 0).length}/{allyHealths.length}</span>
                    <span>Enemies alive: {botHealths.filter((h) => h > 0).length}/{botHealths.length}</span>
                  </div>
                  <div className="text-[11px] text-neutral-500 mt-1">{DIFFICULTY_PRESETS[difficulty].label} · Score {score}</div>
                </div>
              ) : mode === "ffa" ? (
                <div className="bg-neutral-800/50 border border-neutral-700 rounded-xl px-4 py-3 mb-6 text-left">
                  <div className="flex items-center justify-center gap-1.5 text-lg font-bold mb-2">
                    <span className="text-emerald-400">{friendlyKills}</span>
                    <span className="text-neutral-500 text-sm font-normal">
                      {scoreLimit > 0 ? `/ ${scoreLimit} kills` : "kills"}
                    </span>
                  </div>
                  <div className="text-[11px] text-neutral-500 mt-1 text-center">{DIFFICULTY_PRESETS[difficulty].label} · Score {score}</div>
                </div>
              ) : (
                <div className="bg-neutral-800/50 border border-neutral-700 rounded-xl px-4 py-3 mb-6">
                  <div className="flex items-center justify-center gap-3 text-lg font-bold mb-3">
                    <span className="text-emerald-400">{duelStats.kills}</span>
                    <span className="text-neutral-600 text-sm">—</span>
                    <span className="text-red-400">{duelOpponentStats.kills}</span>
                    <span className="text-neutral-500 text-xs font-normal">/ {duelKillLimit}</span>
                  </div>
                  <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-3 text-[10px] uppercase tracking-widest text-neutral-500 mb-1">
                    <span className="text-left">Player</span>
                    <span className="text-right">K</span>
                    <span className="text-right">D</span>
                    <span className="text-right">HS</span>
                  </div>
                  <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-3 text-xs py-0.5">
                    <span className="text-left text-emerald-300 font-bold">You</span>
                    <span className="text-right text-neutral-200">{duelStats.kills}</span>
                    <span className="text-right text-neutral-200">{duelStats.deaths}</span>
                    <span className="text-right text-neutral-200">{duelStats.headshots}</span>
                  </div>
                  <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-3 text-xs py-0.5">
                    <span className="text-left text-red-300 font-bold">Opponent</span>
                    <span className="text-right text-neutral-200">{duelOpponentStats.kills}</span>
                    <span className="text-right text-neutral-200">{duelOpponentStats.deaths}</span>
                    <span className="text-right text-neutral-200">{duelOpponentStats.headshots}</span>
                  </div>
                </div>
              )}

              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={mode === "duel" ? startDuelMatch : handleRematch}
                  className="flex-1 bg-emerald-500 hover:bg-emerald-400 text-neutral-950 font-bold uppercase tracking-wider text-sm py-3 rounded-xl shadow-lg transition-colors"
                >
                  {mode === "duel" ? "Find New Match" : "Rematch"}
                </button>
                <button
                  type="button"
                  onClick={handleBackToMenu}
                  className="flex-1 bg-neutral-800 hover:bg-neutral-700 text-neutral-200 font-bold uppercase tracking-wider text-sm py-3 rounded-xl shadow-lg transition-colors border border-neutral-700"
                >
                  Main Menu
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Small in-HUD watermark — non-intrusive brand mark, not shown
            over the menu or round-end screens where the full logo already
            appears. */}
        {gameState === "playing" && (
          <div className="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 z-10 opacity-25">
            <GunXorLogo size="sm" />
          </div>
        )}

        {/* Click-to-lock hint — a small non-blocking pill instead of a
            full-screen popup, since browsers require a real click before
            Pointer Lock can be granted (can't be skipped entirely). */}
        {gameState === "playing" && !isLocked && (
          <div className="pointer-events-none absolute bottom-24 left-1/2 -translate-x-1/2 z-30">
            <div className="bg-neutral-900/80 backdrop-blur-md border border-emerald-500/40 rounded-full px-4 py-1.5 text-emerald-300 text-xs font-mono tracking-wide animate-pulse shadow-lg">
              Click to aim
            </div>
          </div>
        )}

        {/* Damage Flash: red pulse when the bot lands a hit */}
        <div
          className={`pointer-events-none absolute inset-0 z-25 transition-opacity duration-150 ${
            damageFlash ? "opacity-100" : "opacity-0"
          }`}
          style={{
            background: "radial-gradient(ellipse at center, transparent 40%, rgba(220,38,38,0.45) 100%)",
          }}
        />

        {/* Dynamic Crosshair with Hitmarker — headshots flash gold/red
            instead of plain red, with a bigger burst, so they read as
            clearly distinct from a body-shot hitmarker at a glance. */}
        <div className={`pointer-events-none absolute inset-0 flex items-center justify-center z-20 ${gameState === "menu" ? "hidden" : ""}`}>
          <div className="relative flex items-center justify-center">
            {/* Center Reticle Dot */}
            <div className={`w-1.5 h-1.5 rounded-full transition-all duration-75 ${
              headshotMarker ? "bg-amber-400 scale-150 shadow-[0_0_14px_#fbbf24]" : hitmarker ? "bg-red-500 scale-150 shadow-[0_0_12px_#ef4444]" : "bg-emerald-400 shadow-[0_0_8px_#34d399]"
            }`} />

            {/* Crosshair lines */}
            <div className={`absolute w-5 h-[1.5px] transition-all duration-75 ${headshotMarker ? "bg-amber-400 w-8" : hitmarker ? "bg-red-500 w-7" : "bg-emerald-400/80"}`} />
            <div className={`absolute h-5 w-[1.5px] transition-all duration-75 ${headshotMarker ? "bg-amber-400 h-8" : hitmarker ? "bg-red-500 h-7" : "bg-emerald-400/80"}`} />

            {/* Outer ring */}
            <div className={`absolute rounded-full border transition-all duration-100 ${
              headshotMarker ? "w-12 h-12 border-amber-400 border-solid scale-125" : hitmarker ? "w-10 h-10 border-red-500/80 border-solid scale-110" : "w-8 h-8 border-emerald-400/30 border-dashed"
            }`} />

            {/* Hitmarker diagonals — thicker + gold on a headshot */}
            {(hitmarker || headshotMarker) && (
              <>
                <div className={`absolute rotate-45 ${headshotMarker ? "w-5 h-1 bg-amber-400" : "w-4 h-0.5 bg-red-400"}`} />
                <div className={`absolute -rotate-45 ${headshotMarker ? "w-5 h-1 bg-amber-400" : "w-4 h-0.5 bg-red-400"}`} />
              </>
            )}

            {headshotMarker && (
              <p className="absolute top-8 text-amber-400 font-black text-xs uppercase tracking-widest drop-shadow-[0_0_6px_rgba(251,191,36,0.8)]">
                Headshot
              </p>
            )}
          </div>
        </div>

        {/* Team / Enemy Status + Scoreboard + Timer (top-center) */}
        {gameState !== "menu" && botHealths.length > 0 && (
          <div className="pointer-events-none absolute top-9 left-1/2 -translate-x-1/2 z-20 font-mono w-72 space-y-1.5">
            {(timeLimit > 0 || scoreLimit > 0) && (
              <div className="flex justify-center gap-2 text-[11px]">
                {mode === "tdm" && scoreLimit > 0 && (
                  <div className="bg-neutral-900/85 backdrop-blur-md border border-neutral-700/60 px-3 py-1 rounded-lg shadow-lg">
                    <span className="text-sky-400 font-bold">{friendlyKills}</span>
                    <span className="text-neutral-500"> - </span>
                    <span className="text-red-400 font-bold">{enemyKills}</span>
                    <span className="text-neutral-500"> / {scoreLimit}</span>
                  </div>
                )}
                {mode === "ffa" && scoreLimit > 0 && (
                  <div className="bg-neutral-900/85 backdrop-blur-md border border-neutral-700/60 px-3 py-1 rounded-lg shadow-lg">
                    <span className="text-neutral-400">Kills </span>
                    <span className="text-emerald-400 font-bold">{friendlyKills}</span>
                    <span className="text-neutral-500"> / {scoreLimit}</span>
                  </div>
                )}
                {timeLimit > 0 && (() => {
                  const remaining = Math.max(0, timeLimit - matchElapsed);
                  const urgent = remaining <= 30;
                  return (
                    <div
                      className={`backdrop-blur-md border px-3 py-1 rounded-lg shadow-lg ${
                        urgent
                          ? "bg-red-950/80 border-red-500/70 text-red-300 animate-pulse"
                          : "bg-neutral-900/85 border-neutral-700/60 text-neutral-300"
                      }`}
                    >
                      {Math.floor(remaining / 60).toString().padStart(2, "0")}:
                      {(remaining % 60).toString().padStart(2, "0")}
                    </div>
                  );
                })()}
              </div>
            )}

            {mode === "tdm" && allyHealths.length > 0 && (
              <div className="bg-neutral-900/85 backdrop-blur-md border border-sky-900/60 px-3 py-2 rounded-xl shadow-lg">
                <div className="flex items-center justify-between text-[10px] text-neutral-400 uppercase tracking-widest mb-1.5">
                  <span>Allies</span>
                  <span className="text-sky-400 font-bold">
                    {allyHealths.filter((h) => h > 0).length}/{allyHealths.length}
                  </span>
                </div>
                <div className="space-y-1">
                  {allyHealths.map((h, i) => (
                    <div key={i} className="w-full h-1.5 bg-neutral-800 rounded-full overflow-hidden">
                      <div
                        className={`h-full transition-all duration-150 ${h > 0 ? "bg-sky-500" : "bg-neutral-700"}`}
                        style={{ width: `${h > 0 ? h : 100}%` }}
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="bg-neutral-900/85 backdrop-blur-md border border-red-900/60 px-3 py-2 rounded-xl shadow-lg">
              <div className="flex items-center justify-between text-[10px] text-neutral-400 uppercase tracking-widest mb-1.5">
                <span>{mode === "tdm" ? "Enemies" : `${DIFFICULTY_PRESETS[difficulty].label} Bots`}</span>
                <span className="text-red-400 font-bold">
                  {botHealths.filter((h) => h > 0).length}/{botHealths.length} left
                </span>
              </div>
              <div className="space-y-1">
                {botHealths.map((h, i) => (
                  <div key={i} className="w-full h-1.5 bg-neutral-800 rounded-full overflow-hidden">
                    <div
                      className={`h-full transition-all duration-150 ${h > 0 ? "bg-red-500" : "bg-neutral-700"}`}
                      style={{ width: `${h > 0 ? h : 100}%` }}
                    />
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Opponent Status + Timer + Kill Tally (1v1 duel only) */}
        {mode === "duel" && gameState !== "menu" && (
          <div className="pointer-events-none absolute top-9 left-1/2 -translate-x-1/2 z-20 font-mono w-72 space-y-1.5">
            <div className="flex justify-center gap-2 text-[11px]">
              <div className="bg-neutral-900/85 backdrop-blur-md border border-neutral-700/60 px-3 py-1 rounded-lg shadow-lg">
                <span className="text-emerald-400 font-bold">{duelStats.kills}</span>
                <span className="text-neutral-500"> - </span>
                <span className="text-red-400 font-bold">{duelOpponentStats.kills}</span>
                <span className="text-neutral-500"> / {duelKillLimit}</span>
              </div>
              {(() => {
                const urgent = duelTimeRemaining <= 30;
                return (
                  <div
                    className={`backdrop-blur-md border px-3 py-1 rounded-lg shadow-lg ${
                      urgent
                        ? "bg-red-950/80 border-red-500/70 text-red-300 animate-pulse"
                        : "bg-neutral-900/85 border-neutral-700/60 text-neutral-300"
                    }`}
                  >
                    {Math.floor(Math.max(0, duelTimeRemaining) / 60).toString().padStart(2, "0")}:
                    {(Math.max(0, duelTimeRemaining) % 60).toString().padStart(2, "0")}
                  </div>
                );
              })()}
            </div>

            <div className="bg-neutral-900/85 backdrop-blur-md border border-red-900/60 px-3 py-2 rounded-xl shadow-lg">
              <div className="flex items-center justify-between text-[10px] text-neutral-400 uppercase tracking-widest mb-1.5">
                <span>Opponent</span>
                <span className="text-red-400 font-bold">{Math.ceil(opponentHealth)}</span>
              </div>
              <div className="w-full h-1.5 bg-neutral-800 rounded-full overflow-hidden">
                <div
                  className={`h-full transition-all duration-150 ${opponentHealth > 0 ? "bg-red-500" : "bg-neutral-700"}`}
                  style={{ width: `${Math.max(0, opponentHealth)}%` }}
                />
              </div>
            </div>
          </div>
        )}

        {/* Hold-Tab live scoreboard (1v1 duel only) */}
        {mode === "duel" && gameState === "playing" && showScoreboard && (
          <div className="pointer-events-none absolute inset-0 z-30 flex items-start justify-center pt-24">
            <div className="bg-neutral-900/95 backdrop-blur-md border border-neutral-700 rounded-2xl shadow-2xl w-80 font-mono overflow-hidden">
              <div className="px-4 py-2 border-b border-neutral-800 text-center text-[10px] uppercase tracking-[0.2em] text-neutral-500">
                Scoreboard
              </div>
              <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-3 px-4 py-1.5 text-[10px] uppercase tracking-widest text-neutral-500">
                <span>Player</span>
                <span className="text-right">K</span>
                <span className="text-right">D</span>
                <span className="text-right">HS</span>
              </div>
              <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-3 px-4 py-1.5 text-sm">
                <span className="text-emerald-300 font-bold">You</span>
                <span className="text-right text-neutral-200">{duelStats.kills}</span>
                <span className="text-right text-neutral-200">{duelStats.deaths}</span>
                <span className="text-right text-neutral-200">{duelStats.headshots}</span>
              </div>
              <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-3 px-4 py-1.5 text-sm border-t border-neutral-800/60">
                <span className="text-red-300 font-bold">Opponent</span>
                <span className="text-right text-neutral-200">{duelOpponentStats.kills}</span>
                <span className="text-right text-neutral-200">{duelOpponentStats.deaths}</span>
                <span className="text-right text-neutral-200">{duelOpponentStats.headshots}</span>
              </div>
              <div className="px-4 py-1.5 border-t border-neutral-800 text-center text-[9px] text-neutral-600">
                Hold TAB
              </div>
            </div>
          </div>
        )}

        {/* Kill Feed (top-right, below the fullscreen button) */}
        {killFeed.length > 0 && (
          <div className="pointer-events-none absolute top-16 right-4 z-20 font-mono space-y-1.5 flex flex-col items-end">
            {killFeed.map((entry) => (
              <div
                key={entry.id}
                className={`bg-neutral-900/85 backdrop-blur-md border px-3 py-1.5 rounded-lg shadow-lg text-xs ${
                  entry.tone === "good" ? "border-emerald-500/40 text-emerald-300" : "border-red-500/40 text-red-300"
                }`}
              >
                {entry.text}
              </div>
            ))}
          </div>
        )}

        {/* HUD Top Bar: Score, Player Health & Status */}
        <div className="pointer-events-none absolute top-4 left-4 right-4 z-20 flex justify-between items-start text-xs font-mono">
          <div className="flex flex-col gap-2">
            <div className="bg-neutral-900/80 backdrop-blur-md border border-neutral-700/60 px-3.5 py-2 rounded-xl text-neutral-200 shadow-lg flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              <span>SCORE:</span>
              <span className="text-emerald-400 font-bold text-sm">{score}</span>
            </div>

            {gameState !== "menu" && (
              <div className="bg-neutral-900/80 backdrop-blur-md border border-neutral-700/60 px-3.5 py-2 rounded-xl shadow-lg w-48">
                <div className="flex items-center justify-between text-[10px] text-neutral-400 uppercase tracking-widest mb-1">
                  <span>Health</span>
                  <span className={playerHealth <= 30 ? "text-red-400 font-bold" : "text-emerald-400 font-bold"}>
                    {Math.ceil(playerHealth)}
                  </span>
                </div>
                <div className="w-full h-1.5 bg-neutral-800 rounded-full overflow-hidden">
                  <div
                    className={`h-full transition-all duration-150 ${playerHealth <= 30 ? "bg-red-500" : "bg-emerald-400"}`}
                    style={{ width: `${playerHealth}%` }}
                  />
                </div>
              </div>
            )}
          </div>

          {/* Reloading Alert Banner */}
          {isReloading && (
            <div className="bg-amber-500/20 border border-amber-500/60 backdrop-blur-md px-4 py-1.5 rounded-xl text-amber-300 font-bold text-xs tracking-wider animate-bounce shadow-lg">
              RELOADING...
            </div>
          )}

          {/* Fullscreen + Graphics Settings */}
          <div className="flex items-start gap-2">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                toggleFullscreen();
              }}
              className="pointer-events-auto bg-neutral-900/80 backdrop-blur-md border border-neutral-700/60 px-3 py-2 rounded-xl text-neutral-300 hover:text-emerald-400 hover:border-emerald-500/50 shadow-lg transition-colors"
              title={isFullscreen ? "Exit Fullscreen" : "Enter Fullscreen"}
            >
              {isFullscreen ? "⤡" : "⤢"}
            </button>

            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setShowSettings(true);
              }}
              className="pointer-events-auto bg-neutral-900/80 backdrop-blur-md border border-neutral-700/60 px-3 py-2 rounded-xl text-neutral-300 hover:text-emerald-400 hover:border-emerald-500/50 shadow-lg transition-colors"
              title="Graphics Settings"
            >
              ⚙
            </button>
          </div>
        </div>

        {/* Compass */}
        {gameState !== "menu" && <Compass ref={compassRef} />}

        {showSettings && (
          <GraphicsSettingsPanel
            settings={settings}
            onChange={updateSettings}
            onClose={() => setShowSettings(false)}
          />
        )}

        {/* HUD Bottom Bar: Ammo & Weapon Specs */}
        {gameState !== "menu" && (
          <div className="pointer-events-none absolute bottom-4 right-4 z-20 font-mono">
            <div className="bg-neutral-900/85 backdrop-blur-md border border-neutral-700/70 p-3.5 rounded-2xl text-neutral-200 shadow-2xl text-right space-y-1">
              <div className="text-[10px] text-neutral-400 tracking-widest uppercase">Assault Rifle 5.56mm</div>
              <div className="flex items-baseline justify-end gap-1.5">
                <span className={`text-2xl font-bold tracking-tight ${ammo <= 5 ? "text-red-500 animate-pulse" : "text-emerald-400"}`}>
                  {String(ammo).padStart(2, "0")}
                </span>
                <span className="text-neutral-500 text-sm">/ 30</span>
              </div>
              {/* Ammo Progress Bar */}
              <div className="w-28 h-1.5 bg-neutral-800 rounded-full overflow-hidden ml-auto">
                <div
                  className={`h-full transition-all duration-100 ${ammo <= 5 ? "bg-red-500" : "bg-emerald-400"}`}
                  style={{ width: `${(ammo / 30) * 100}%` }}
                />
              </div>
            </div>
          </div>
        )}

        {/* HUD Controls Helper */}
        {gameState !== "menu" && (
          <div className="pointer-events-none absolute bottom-4 left-4 z-20 text-xs font-mono bg-neutral-900/80 backdrop-blur-md border border-neutral-700/60 p-3 rounded-xl text-neutral-300 space-y-0.5 shadow-lg">
            <p><span className="text-emerald-400 font-bold">LMB</span> Fire Gun &nbsp;|&nbsp; <span className="text-emerald-400 font-bold">R</span> Reload</p>
            <p><span className="text-emerald-400 font-bold">W / A / S / D</span> Move &nbsp;|&nbsp; <span className="text-emerald-400 font-bold">SPACE</span> Jump</p>
            <p><span className="text-emerald-400 font-bold">C</span> Crouch &nbsp;|&nbsp; <span className="text-emerald-400 font-bold">CTRL</span> Prone</p>
            <p><span className="text-emerald-400 font-bold">F</span> Inspect Weapon</p>
          </div>
        )}

        {/* 3D Scene Viewport */}
        <Canvas
          shadows={settings.shadows ? "percentage" : false}
          dpr={[Math.min(1, settings.resolutionScale), 1.5 * settings.resolutionScale]}
          gl={{ antialias: true, powerPreference: "high-performance" }}
          camera={{ fov: 75, near: 0.01, far: 1000, position: [0, 2, 0], rotation: [0, 0, 0] }}
          className="w-full h-full cursor-crosshair"
          onCreated={({ gl }) => {
            gl.toneMapping = THREE.ACESFilmicToneMapping;
            gl.toneMappingExposure = 1.15;
          }}
        >
          {gameState === "playing" && (
            <PointerLockControls
              onLock={() => setIsLocked(true)}
              onUnlock={() => setIsLocked(false)}
            />
          )}

          {gameState !== "menu" && <CompassDriver compassRef={compassRef} />}

          <Environment shadowsEnabled={settings.shadows} />

          {gameState !== "menu" && (
            <>
              {/* First-Person Weapon Model & Rig */}
              <Weapon
                key={`weapon-${matchId}`}
                isMoving={isMoving}
                onShoot={handleShoot}
                ammo={ammo}
                setAmmo={setAmmo}
                isReloading={isReloading}
                setIsReloading={setIsReloading}
              />

              {/* Bullet Tracers & Spark Impacts */}
              <BulletEffects ref={bulletEffectsRef} />

              {/* Raycast Target Detection */}
              <RaycastShooter
                onRegisterShot={handleRegisterShot}
                bulletEffectsRef={bulletEffectsRef}
                onTargetHit={handleTargetHit}
                onShotFired={mode === "duel" ? handleShotFired : undefined}
              />
            </>
          )}

          <Suspense fallback={null}>
            <Physics gravity={[0, -9.81, 0]}>
              {gameState === "playing" && (
                <Player
                  key={`player-${matchId}`}
                  ref={playerRef}
                  onMoveStateChange={setIsMoving}
                  registry={registry}
                  onDamageTaken={handleDamagePlayer}
                  spawnPosition={mode === "duel" ? DUEL_SPAWN_PAIRS[duelSpawnIndex][isPlayerOne ? 0 : 1] : undefined}
                  spawnYaw={mode === "duel" ? (isPlayerOne ? 0 : Math.PI) : undefined}
                  onNetworkTick={mode === "duel" ? handleDuelNetworkTick : undefined}
                />
              )}

              {mode === "duel" && gameState === "playing" && (
                <RemotePlayer
                  key={`opponent-${matchId}`}
                  ref={remotePlayerRef}
                  health={opponentHealth}
                  onHit={handleOpponentHit}
                />
              )}

              {mode !== "duel" &&
                gameState !== "menu" &&
                botHealths.map((h, i) => (
                  <Bot
                    key={`enemy-${matchId}-${i}`}
                    id={`enemy-${i}`}
                    team="enemy"
                    displayName={`Enemy ${i + 1}`}
                    freeForAll={mode === "ffa"}
                    difficulty={difficulty}
                    active={gameState === "playing" && h > 0}
                    health={h}
                    maxHealth={100}
                    spawnPosition={ENEMY_SPAWN_POINTS[botSpawnIndices[i] ?? i % ENEMY_SPAWN_POINTS.length]}
                    onDamageTaken={(dmg, attackerId, headshot) => handleHitBot(i, dmg, attackerId, headshot)}
                    bulletEffectsRef={bulletEffectsRef}
                    registry={registry}
                  />
                ))}

              {mode !== "duel" &&
                gameState !== "menu" &&
                allyHealths.map((h, i) => (
                  <Bot
                    key={`ally-${matchId}-${i}`}
                    id={`ally-${i}`}
                    team="friendly"
                    displayName={`Ally ${i + 1}`}
                    freeForAll={false}
                    difficulty={difficulty}
                    active={gameState === "playing" && h > 0}
                    health={h}
                    maxHealth={100}
                    spawnPosition={ALLY_SPAWN_POINTS[allySpawnIndices[i] ?? i % ALLY_SPAWN_POINTS.length]}
                    onDamageTaken={(dmg) => handleHitAlly(i, dmg)}
                    bulletEffectsRef={bulletEffectsRef}
                    registry={registry}
                  />
                ))}

              {/* 3D Map */}
              <GameMap scale={0.16} />

              {/* Practice dummies — not part of a real 1v1 duel arena */}
              {mode !== "duel" && (
                <>
                  <HumanTarget position={[0, -0.16, -5]} />
                  <ShootableTarget position={[1.5, 0.4, -4]} color="#0ea5e9" />
                  <ShootableTarget position={[-1.8, 0.4, -5]} color="#a855f7" />
                  <ShootableTarget position={[0, 0.8, -7]} color="#eab308" />
                  <ShootableTarget position={[3.2, 0.4, -3]} color="#ec4899" />
                </>
              )}
            </Physics>
          </Suspense>

          {/* Post-processing: bloom for muzzle flash/impacts/emissives, subtle
              vignette + chromatic aberration for a cinematic FPS look.
              Skippable via Graphics settings — it's a real per-frame GPU
              cost (an extra full-screen render pass) for a purely
              cosmetic effect. */}
          {settings.postProcessing && (
            <EffectComposer multisampling={2}>
              <Bloom
                luminanceThreshold={0.35}
                luminanceSmoothing={0.2}
                mipmapBlur
                intensity={0.8}
                radius={0.6}
              />
              <ChromaticAberration
                blendFunction={BlendFunction.NORMAL}
                offset={[0.0006, 0.0006]}
              />
              <Vignette eskil={false} offset={0.25} darkness={0.9} />
            </EffectComposer>
          )}
        </Canvas>
    </div>
  );
}
