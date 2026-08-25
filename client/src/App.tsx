import { Suspense, useEffect, useRef, useState, useCallback } from "react";
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
  SCORE_LIMIT_OPTIONS,
  TIME_LIMIT_OPTIONS,
  type CombatantRegistry,
  type GameMode,
} from "./match";
import {
  playHitSound,
  playFootstepSound,
  playJumpSound,
  playLandSound,
  playPlayerHurtSound,
  startAmbientAmbience,
  stopAmbientAmbience,
} from "./audio";

type GameState = "menu" | "playing" | "won" | "lost" | "draw";

// ──────────────────────────────────────────────────────
//  TUNING CONSTANTS (Adjusted for scale={0.16} GameMap)
// ──────────────────────────────────────────────────────
const MOVE_SPEED = 4.5;
const JUMP_FORCE = 5.5;
const GRAVITY = -18;
const EYE_HEIGHT = 0.34;
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

const movementKeys = new Set([
  "KeyW", "KeyA", "KeyS", "KeyD",
  "ArrowUp", "ArrowLeft", "ArrowDown", "ArrowRight",
  "Space",
]);

interface PlayerProps {
  onMoveStateChange: (moving: boolean) => void;
  registry: CombatantRegistry;
  onDamageTaken: (damage: number) => void;
}

// ──────────────────────────────────────────────────────
//  PLAYER – Rapier KinematicCharacterController
// ──────────────────────────────────────────────────────
function Player({ onMoveStateChange, registry, onDamageTaken }: PlayerProps) {
  const rigidBodyRef = useRef<RapierRigidBody>(null);
  const pressedKeys = useRef(new Set<string>());
  const { world } = useRapier();
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
    const camDir = new THREE.Vector3();
    state.camera.getWorldDirection(camDir);
    camDir.y = 0;
    camDir.normalize();

    const camRight = new THREE.Vector3(1, 0, 0).applyQuaternion(state.camera.quaternion);
    camRight.y = 0;
    camRight.normalize();

    const horizontal = new THREE.Vector3();
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

  return (
    <RigidBody
      ref={rigidBodyRef}
      type="kinematicPosition"
      colliders={false}
      position={[0, 1.5, 0]}
      enabledRotations={[false, false, false]}
      canSleep={false}
    >
      <CapsuleCollider args={[0.06, 0.06]} friction={0} restitution={0} />
    </RigidBody>
  );
}

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
  onTargetHit: () => void;
}

function RaycastShooter({ onRegisterShot, bulletEffectsRef, onTargetHit }: RaycastShooterProps) {
  const { scene } = useThree();
  const store = useStore();
  const raycaster = useRef(new THREE.Raycaster());
  const baseFov = useRef((store.getState().camera as THREE.PerspectiveCamera).fov);

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
  });

  const shootRay = useCallback(
    (muzzlePos: THREE.Vector3) => {
      // Imperative store access — safe to mutate outside the render/frame loop.
      const cam = store.getState().camera as THREE.PerspectiveCamera;
      cam.fov = Math.min(cam.fov + 1.4, baseFov.current + 2.5);
      cam.updateProjectionMatrix();

      raycaster.current.setFromCamera(new THREE.Vector2(0, 0), cam);

      // Collect all meshes in the scene to test against
      const shootableObjects: THREE.Object3D[] = [];
      scene.traverse((child) => {
        if ((child as THREE.Mesh).isMesh && child.parent?.name !== "weaponGroupRef") {
          shootableObjects.push(child);
        }
      });

      const intersects = raycaster.current.intersectObjects(shootableObjects, false);

      if (intersects.length > 0) {
        const hit = intersects[0];
        const hitPoint = hit.point;
        const hitNormal = hit.face ? hit.face.normal.clone().applyQuaternion(hit.object.quaternion) : new THREE.Vector3(0, 1, 0);

        bulletEffectsRef.current?.addShot(muzzlePos, hitPoint, hitNormal);

        // Check if target was hit
        let currentObj: THREE.Object3D | null = hit.object;
        while (currentObj) {
          if (currentObj.userData?.isTarget) {
            currentObj.userData.onHit?.();
            playHitSound();
            onTargetHit();
            break;
          }
          currentObj = currentObj.parent;
        }
      } else {
        // Did not hit any object; shoot ray far forward
        const farPoint = new THREE.Vector3();
        raycaster.current.ray.at(100, farPoint);
        bulletEffectsRef.current?.addShot(muzzlePos, farPoint);
      }
    },
    [scene, store, bulletEffectsRef, onTargetHit]
  );

  useEffect(() => {
    onRegisterShot(shootRay);
  }, [shootRay, onRegisterShot]);

  return null;
}

// ──────────────────────────────────────────────────────
//  ENVIRONMENT LIGHTING
// ──────────────────────────────────────────────────────
const SUN_POSITION: [number, number, number] = [60, 55, 35];

function Environment() {
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
        castShadow
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

  const [gameState, setGameState] = useState<GameState>("menu");
  const [mode, setMode] = useState<GameMode>("ffa");
  const [difficulty, setDifficulty] = useState<Difficulty>("medium");
  const [botCount, setBotCount] = useState(3); // FFA enemy count
  const [teamSize, setTeamSize] = useState(2); // TDM: combatants per side, including the player
  const [scoreLimit, setScoreLimit] = useState<number>(0);
  const [timeLimit, setTimeLimit] = useState<number>(0);

  const [playerHealth, setPlayerHealth] = useState(100);
  const [botHealths, setBotHealths] = useState<number[]>([]); // enemy team
  const [allyHealths, setAllyHealths] = useState<number[]>([]); // TDM only
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
  const botHealthsRef = useRef<number[]>([]);
  const allyHealthsRef = useRef<number[]>([]);
  const friendlyKillsRef = useRef(0);
  const enemyKillsRef = useRef(0);
  useEffect(() => {
    scoreLimitRef.current = scoreLimit;
  }, [scoreLimit]);
  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);
  useEffect(() => {
    timeLimitRef.current = timeLimit;
  }, [timeLimit]);

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
      setPlayerHealth(100);
      const initialEnemies = Array(enemyCount).fill(100);
      const initialAllies = Array(allyCount).fill(100);
      botHealthsRef.current = initialEnemies;
      allyHealthsRef.current = initialAllies;
      friendlyKillsRef.current = 0;
      enemyKillsRef.current = 0;
      setBotHealths(initialEnemies);
      setAllyHealths(initialAllies);
      setFriendlyKills(0);
      setEnemyKills(0);
      setMatchElapsed(0);
      setAmmo(30);
      setIsReloading(false);
      setScore(0);
      setKillFeed([]);
      setMatchId((id) => id + 1);
      setGameState("playing");
    },
    [enemyCount, allyCount]
  );

  const handleRematch = useCallback(() => startMatch(difficulty), [startMatch, difficulty]);
  const handleBackToMenu = useCallback(() => setGameState("menu"), []);

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
        if (limit > 0 && next >= limit) {
          if (modeRef.current === "ffa") {
            setGameState((gs) => (gs === "playing" ? "won" : gs));
          } else {
            const f = friendlyKillsRef.current;
            const e = enemyKillsRef.current;
            setGameState((gs) => (gs === "playing" ? (f === e ? "draw" : f > e ? "won" : "lost") : gs));
          }
        }
        return next;
      });
    }, 1000);
    return () => window.clearInterval(interval);
  }, [gameState]);

  const handleDamagePlayer = useCallback((dmg: number) => {
    setPlayerHealth((h) => {
      const next = Math.max(0, h - dmg);
      if (next <= 0) setGameState((gs) => (gs === "playing" ? "lost" : gs));
      return next;
    });
    setDamageFlash(true);
    window.setTimeout(() => setDamageFlash(false), 200);
    playPlayerHurtSound();
  }, []);

  // Enemy-team bot took damage (from the player's own raycast, or from an
  // ally bot's attack via the combat registry).
  const handleHitBot = useCallback(
    (index: number, dmg: number) => {
      const arr = botHealthsRef.current;
      const prevHealth = arr[index] ?? 0;
      if (prevHealth <= 0) return;
      const nextHealth = Math.max(0, prevHealth - dmg);
      const nextArr = arr.slice();
      nextArr[index] = nextHealth;
      botHealthsRef.current = nextArr;
      setBotHealths(nextArr);

      if (nextHealth <= 0) {
        pushKillFeed(`You eliminated Enemy ${index + 1}`, "good");
        friendlyKillsRef.current += 1;
        setFriendlyKills(friendlyKillsRef.current);
        const limit = scoreLimitRef.current;
        if (limit > 0 && friendlyKillsRef.current >= limit) {
          setGameState((gs) => (gs === "playing" ? "won" : gs));
          return;
        }
        if (nextArr.every((h) => h <= 0)) {
          setGameState((gs) => (gs === "playing" ? "won" : gs));
        }
      }
    },
    [pushKillFeed]
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
        const limit = scoreLimitRef.current;
        if (limit > 0 && enemyKillsRef.current >= limit) {
          setGameState((gs) => (gs === "playing" ? "lost" : gs));
        }
      }
    },
    [pushKillFeed]
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

  const handleTargetHit = useCallback(() => {
    setScore((s) => s + 100);
    setHitmarker(true);
    setTimeout(() => setHitmarker(false), 120);
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
              <div className="w-14 h-14 rounded-full bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center mx-auto mb-4 text-emerald-400 text-2xl font-bold">
                FPS
              </div>
              <p className="text-emerald-400 font-bold text-2xl tracking-wider uppercase mb-1">
                {mode === "ffa" ? `1 vs ${botCount} Bot${botCount > 1 ? "s" : ""}` : `${teamSize} vs ${teamSize}`}
              </p>
              <p className="text-neutral-400 text-xs mb-6">
                {mode === "ffa"
                  ? "Face off against bots roaming the map. Clear them all to win."
                  : "Fight alongside allied bots against an enemy team. Wipe them out to win."}
              </p>

              <p className="text-neutral-300 text-xs uppercase tracking-widest mb-2">Mode</p>
              <div className="grid grid-cols-2 gap-2 mb-6">
                <button
                  type="button"
                  onClick={() => setMode("ffa")}
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
                  onClick={() => setMode("tdm")}
                  className={`rounded-xl border py-2.5 text-xs font-bold uppercase tracking-wide transition-colors ${
                    mode === "tdm"
                      ? "bg-emerald-500/20 border-emerald-500/70 text-emerald-300"
                      : "bg-neutral-800/60 border-neutral-700 text-neutral-400 hover:border-neutral-500"
                  }`}
                >
                  Team Deathmatch
                </button>
              </div>

              {mode === "ffa" ? (
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

              <button
                type="button"
                onClick={() => startMatch(difficulty)}
                className="w-full bg-emerald-500 hover:bg-emerald-400 text-neutral-950 font-bold uppercase tracking-wider text-sm py-3 rounded-xl shadow-lg transition-colors"
              >
                Start Match
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
              <p
                className={`font-black text-4xl tracking-wider uppercase mb-2 ${
                  gameState === "won" ? "text-emerald-400" : gameState === "draw" ? "text-amber-400" : "text-red-500"
                }`}
              >
                {gameState === "won" ? "You Win" : gameState === "draw" ? "Draw" : "You Lose"}
              </p>
              <p className="text-neutral-400 text-xs mb-6">
                {mode === "tdm"
                  ? `${friendlyKills} - ${enemyKills} · ${DIFFICULTY_PRESETS[difficulty].label}`
                  : `${botHealths.length} ${DIFFICULTY_PRESETS[difficulty].label} bot${botHealths.length > 1 ? "s" : ""}`}
                &nbsp;·&nbsp; Score {score}
              </p>
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={handleRematch}
                  className="flex-1 bg-emerald-500 hover:bg-emerald-400 text-neutral-950 font-bold uppercase tracking-wider text-sm py-3 rounded-xl shadow-lg transition-colors"
                >
                  Rematch
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

        {/* Dynamic Crosshair with Hitmarker */}
        <div className={`pointer-events-none absolute inset-0 flex items-center justify-center z-20 ${gameState === "menu" ? "hidden" : ""}`}>
          <div className="relative flex items-center justify-center">
            {/* Center Reticle Dot */}
            <div className={`w-1.5 h-1.5 rounded-full transition-all duration-75 ${hitmarker ? "bg-red-500 scale-150 shadow-[0_0_12px_#ef4444]" : "bg-emerald-400 shadow-[0_0_8px_#34d399]"}`} />

            {/* Crosshair lines */}
            <div className={`absolute w-5 h-[1.5px] transition-all duration-75 ${hitmarker ? "bg-red-500 w-7" : "bg-emerald-400/80"}`} />
            <div className={`absolute h-5 w-[1.5px] transition-all duration-75 ${hitmarker ? "bg-red-500 h-7" : "bg-emerald-400/80"}`} />

            {/* Outer ring */}
            <div className={`absolute rounded-full border transition-all duration-100 ${hitmarker ? "w-10 h-10 border-red-500/80 border-solid scale-110" : "w-8 h-8 border-emerald-400/30 border-dashed"}`} />

            {/* Hitmarker diagonals */}
            {hitmarker && (
              <>
                <div className="absolute w-4 h-0.5 bg-red-400 rotate-45" />
                <div className="absolute w-4 h-0.5 bg-red-400 -rotate-45" />
              </>
            )}
          </div>
        </div>

        {/* Team / Enemy Status + Scoreboard + Timer (top-center) */}
        {gameState !== "menu" && botHealths.length > 0 && (
          <div className="pointer-events-none absolute top-4 left-1/2 -translate-x-1/2 z-20 font-mono w-72 space-y-1.5">
            {(timeLimit > 0 || (mode === "tdm" && scoreLimit > 0)) && (
              <div className="flex justify-center gap-2 text-[11px]">
                {mode === "tdm" && (
                  <div className="bg-neutral-900/85 backdrop-blur-md border border-neutral-700/60 px-3 py-1 rounded-lg shadow-lg">
                    <span className="text-sky-400 font-bold">{friendlyKills}</span>
                    <span className="text-neutral-500"> - </span>
                    <span className="text-red-400 font-bold">{enemyKills}</span>
                    {scoreLimit > 0 && <span className="text-neutral-500"> / {scoreLimit}</span>}
                  </div>
                )}
                {timeLimit > 0 && (
                  <div className="bg-neutral-900/85 backdrop-blur-md border border-neutral-700/60 px-3 py-1 rounded-lg shadow-lg text-neutral-300">
                    {Math.floor(Math.max(0, timeLimit - matchElapsed) / 60)
                      .toString()
                      .padStart(2, "0")}
                    :
                    {(Math.max(0, timeLimit - matchElapsed) % 60).toString().padStart(2, "0")}
                  </div>
                )}
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

          {/* Fullscreen Toggle */}
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
        </div>

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
          shadows="percentage"
          dpr={[1, 1.5]}
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

          <Environment />

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
              />
            </>
          )}

          <Suspense fallback={null}>
            <Physics gravity={[0, -9.81, 0]}>
              {gameState === "playing" && (
                <Player
                  key={`player-${matchId}`}
                  onMoveStateChange={setIsMoving}
                  registry={registry}
                  onDamageTaken={handleDamagePlayer}
                />
              )}

              {gameState !== "menu" &&
                botHealths.map((h, i) => (
                  <Bot
                    key={`enemy-${matchId}-${i}`}
                    id={`enemy-${i}`}
                    team="enemy"
                    difficulty={difficulty}
                    active={gameState === "playing" && h > 0}
                    health={h}
                    maxHealth={100}
                    spawnPosition={ENEMY_SPAWN_POINTS[i % ENEMY_SPAWN_POINTS.length]}
                    onDamageTaken={(dmg) => handleHitBot(i, dmg)}
                    bulletEffectsRef={bulletEffectsRef}
                    registry={registry}
                  />
                ))}

              {gameState !== "menu" &&
                allyHealths.map((h, i) => (
                  <Bot
                    key={`ally-${matchId}-${i}`}
                    id={`ally-${i}`}
                    team="friendly"
                    difficulty={difficulty}
                    active={gameState === "playing" && h > 0}
                    health={h}
                    maxHealth={100}
                    spawnPosition={ALLY_SPAWN_POINTS[i % ALLY_SPAWN_POINTS.length]}
                    onDamageTaken={(dmg) => handleHitAlly(i, dmg)}
                    bulletEffectsRef={bulletEffectsRef}
                    registry={registry}
                  />
                ))}

              {/* 3D Map */}
              <GameMap scale={0.16} />
              <HumanTarget position={[0, -0.16, -5]} />

              {/* Shootable Reactive Practice Targets */}
              <ShootableTarget position={[1.5, 0.4, -4]} color="#0ea5e9" />
              <ShootableTarget position={[-1.8, 0.4, -5]} color="#a855f7" />
              <ShootableTarget position={[0, 0.8, -7]} color="#eab308" />
              <ShootableTarget position={[3.2, 0.4, -3]} color="#ec4899" />
            </Physics>
          </Suspense>

          {/* Post-processing: bloom for muzzle flash/impacts/emissives, subtle
              vignette + chromatic aberration for a cinematic FPS look. */}
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
        </Canvas>
    </div>
  );
}
