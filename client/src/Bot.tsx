import { useRef, useMemo, useEffect, useCallback } from "react";
import { useFrame } from "@react-three/fiber";
import { useGLTF, useAnimations } from "@react-three/drei";
import { RigidBody, RapierRigidBody, CapsuleCollider, useRapier } from "@react-three/rapier";
import * as THREE from "three";
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";
import { playEnemyGunshotSound } from "./audio";
import type { BulletEffectsHandle } from "./BulletEffects";
import { DIFFICULTY_PRESETS, type Difficulty } from "./difficulty";
import { findNearestOpponent, type CombatantRegistry, type Team } from "./match";

const ENEMY_URL = "/enime.glb";
useGLTF.preload(ENEMY_URL);

// Rigged Mixamo-style soldier (idle/walk/run/crouch + rifle variants). Its
// native bind-pose is ~4.9 units tall before any scale — we normalize to a
// fixed in-world height instead of trusting the source scale, so it matches
// the player's own apparent height. Player's camera sits EYE_HEIGHT=0.34
// above the capsule's center, and the capsule's center is ~0.12 above the
// feet (radius+halfHeight), so eye-above-ground ≈ 0.46; at a typical
// eye-to-height ratio of ~0.93 that's a ~0.5-tall character (see App.tsx's
// Player / EYE_HEIGHT).
const TARGET_HEIGHT = 0.5;

// The map's real footprint (measured from map.glb / the floor collider),
// inset slightly from the edges so wander waypoints don't land inside
// boundary walls.
const WANDER_MIN = new THREE.Vector2(-8.4, -18.8);
const WANDER_MAX = new THREE.Vector2(8.4, 18.8);

const PREFERRED_MIN = 2.4;
const PREFERRED_MAX = 6.5;
const SIGHT_RANGE = 12;
const WAYPOINT_RADIUS = 0.5;
const LOW_HEALTH_FRACTION = 0.3;
const GRAVITY = -18;

const TEAM_COLOR: Record<Team, string> = {
  friendly: "#38bdf8",
  enemy: "#ef4444",
};

function shortestAngleDiff(a: number, b: number) {
  return Math.atan2(Math.sin(a - b), Math.cos(a - b));
}

// Shared, reused-in-place by rotateAround below (never mutated) — avoids a
// fresh Vector2 allocation every frame just to express "rotate about origin".
const ORIGIN_2D = /* @__PURE__ */ new THREE.Vector2(0, 0);

function randomInBounds(min: THREE.Vector2, max: THREE.Vector2, out: THREE.Vector2) {
  out.set(
    THREE.MathUtils.lerp(min.x, max.x, Math.random()),
    THREE.MathUtils.lerp(min.y, max.y, Math.random())
  );
  return out;
}

interface BotProps {
  id: string;
  team: Team;
  difficulty: Difficulty;
  active: boolean;
  health: number;
  maxHealth: number;
  spawnPosition: [number, number, number];
  onDamageTaken: (damage: number) => void;
  bulletEffectsRef: React.RefObject<BulletEffectsHandle | null>;
  registry: CombatantRegistry;
}

export function Bot({
  id,
  team,
  difficulty,
  active,
  health,
  maxHealth,
  spawnPosition,
  onDamageTaken,
  bulletEffectsRef,
  registry,
}: BotProps) {
  const { world, rapier } = useRapier();
  const rigidBodyRef = useRef<RapierRigidBody>(null);
  const visualRef = useRef<THREE.Group>(null);
  const flashLightRef = useRef<THREE.PointLight>(null);
  const cc = useRef<ReturnType<typeof world.createCharacterController> | null>(null);

  const preset = DIFFICULTY_PRESETS[difficulty];

  const { scene, animations } = useGLTF(ENEMY_URL);
  const clonedScene = useMemo(() => cloneSkeleton(scene) as THREE.Group, [scene]);
  const { actions } = useAnimations(animations, visualRef);

  // Normalize the model's native scale to TARGET_HEIGHT and work out the
  // vertical offset that puts its feet exactly on the capsule's bottom.
  const capsuleRadius = TARGET_HEIGHT * 0.12;
  const capsuleHalfHeight = Math.max(TARGET_HEIGHT * 0.5 - capsuleRadius, 0.02);
  const { modelScale, modelOffsetY } = useMemo(() => {
    const box = new THREE.Box3().setFromObject(clonedScene);
    const rawHeight = Math.max(box.max.y - box.min.y, 0.001);
    const scale = TARGET_HEIGHT / rawHeight;
    const offsetY = -(capsuleHalfHeight + capsuleRadius) - box.min.y * scale;
    return { modelScale: scale, modelOffsetY: offsetY };
  }, [clonedScene, capsuleHalfHeight, capsuleRadius]);

  useEffect(() => {
    clonedScene.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        // The cloned skinned mesh's bounding sphere reflects the bind pose
        // and doesn't track the character's actual animated/transformed
        // position, so frustum culling can incorrectly hide it. Same fix
        // Weapon.tsx uses for its own SkeletonUtils clone.
        mesh.frustumCulled = false;
      }
    });
  }, [clonedScene]);

  useEffect(() => {
    const controller = world.createCharacterController(0.01);
    controller.setMaxSlopeClimbAngle(50 * (Math.PI / 180));
    controller.setMinSlopeSlideAngle(60 * (Math.PI / 180));
    controller.enableAutostep(0.16, 0.05, true);
    controller.enableSnapToGround(0.08);
    cc.current = controller;
    return () => world.removeCharacterController(controller);
  }, [world]);

  // ── Animation crossfade helper — only touches actions when the target
  // clip actually changes, so calling it every frame is cheap. ──────────
  const currentAnimRef = useRef<string | null>(null);
  const playAnim = useCallback(
    (name: string, fade = 0.25) => {
      if (!actions || currentAnimRef.current === name) return;
      const next = actions[name];
      if (!next) return;
      const prevName = currentAnimRef.current;
      if (prevName && actions[prevName]) actions[prevName]?.fadeOut(fade);
      next.reset().fadeIn(fade).play();
      currentAnimRef.current = name;
    },
    [actions]
  );

  // ── AI state ──────────────────────────────────────────────────────────
  const yVelocity = useRef(0);
  const waypoint = useRef(new THREE.Vector2(spawnPosition[0], spawnPosition[2]));
  const facing = useRef(0);
  const strafeDir = useRef(1);
  const strafeTimer = useRef(0);
  const elapsed = useRef(0);
  const nextShotTime = useRef(preset.reactionDelay);
  const nextLosCheck = useRef(0);
  const losClear = useRef(false);
  const flashTimer = useRef(0);
  const stuckTimer = useRef(0);
  const nextAvoidCheck = useRef(0);
  const avoidTurn = useRef(0);
  const lastPos = useRef(new THREE.Vector2(spawnPosition[0], spawnPosition[2]));

  // The enemy model has no death/ragdoll animation clip at all, so without
  // this a killed bot just keeps looping whatever it was last playing
  // (walk/run/idle) forever, standing there like it's still alive. Fake a
  // death instead: freeze the animation and tip the model over.
  const deathTriggered = useRef(false);
  const deathProgress = useRef(0);
  const DEATH_FALL_SECONDS = 0.5;

  // Scratch vectors reused every frame instead of `new THREE.Vector2/3(...)`
  // — with several bots active at once, allocating half a dozen temp vectors
  // per bot per frame adds up to real garbage-collector pressure, which
  // shows up as intermittent stutter rather than a steady frame cost.
  const myPosVec = useRef(new THREE.Vector3());
  const toTargetVec = useRef(new THREE.Vector2());
  const dirToTargetVec = useRef(new THREE.Vector2());
  const moveDirVec = useRef(new THREE.Vector2());
  const toWpVec = useRef(new THREE.Vector2());
  const probeDirVec = useRef(new THREE.Vector2());
  const muzzleVec = useRef(new THREE.Vector3());
  const muzzleOffsetVec = useRef(new THREE.Vector3());
  const targetVec = useRef(new THREE.Vector3());
  const spreadVec = useRef(new THREE.Vector3());

  // Register this bot as a combatant so other bots (and the player's own
  // registry entry) can find and attack it. onDamageTaken is expected to be
  // a stable (useCallback'd) reference from the parent.
  useEffect(() => {
    registry.set(id, {
      id,
      team,
      position: new THREE.Vector3(spawnPosition[0], spawnPosition[1], spawnPosition[2]),
      alive: health > 0,
      damage: onDamageTaken,
    });
    return () => {
      registry.delete(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, team, registry]);

  useEffect(() => {
    if (!active) return;
    rigidBodyRef.current?.setNextKinematicTranslation({
      x: spawnPosition[0],
      y: spawnPosition[1],
      z: spawnPosition[2],
    });
    randomInBounds(WANDER_MIN, WANDER_MAX, waypoint.current);
    elapsed.current = 0;
    nextShotTime.current = preset.reactionDelay;
    yVelocity.current = 0;
    stuckTimer.current = 0;
    lastPos.current.set(spawnPosition[0], spawnPosition[2]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  useFrame((_state, delta) => {
    const body = rigidBodyRef.current;
    if (!body || !cc.current) return;

    const myPos = body.translation();
    const myEntry = registry.get(id);
    if (myEntry) {
      myEntry.position.set(myPos.x, myPos.y, myPos.z);
      myEntry.alive = active && health > 0;
    }

    if (health <= 0) {
      if (!deathTriggered.current) {
        deathTriggered.current = true;
        // Stop whatever loop (walk/run/idle) was playing instead of
        // leaving it running underneath the fall.
        if (actions && currentAnimRef.current) actions[currentAnimRef.current]?.fadeOut(0.2);
      }
      deathProgress.current = Math.min(deathProgress.current + delta / DEATH_FALL_SECONDS, 1);
      const eased = 1 - Math.pow(1 - deathProgress.current, 3); // ease-out
      if (visualRef.current) {
        visualRef.current.rotation.x = -(Math.PI / 2) * eased;
        visualRef.current.position.y = modelOffsetY - capsuleHalfHeight * 0.6 * eased;
      }
      return;
    }
    deathTriggered.current = false;
    deathProgress.current = 0;

    if (!active) return;
    elapsed.current += delta;
    if (flashTimer.current > 0) {
      flashTimer.current -= delta;
      if (flashLightRef.current) flashLightRef.current.visible = flashTimer.current > 0;
    }

    const target = findNearestOpponent(registry, team, myPosVec.current.set(myPos.x, myPos.y, myPos.z));
    const toTarget = toTargetVec.current;
    if (target) toTarget.set(target.position.x - myPos.x, target.position.z - myPos.z);
    else toTarget.set(0, 0);
    const distToTarget = toTarget.length();
    const dirToTarget = dirToTargetVec.current;
    if (distToTarget > 0) dirToTarget.copy(toTarget).divideScalar(distToTarget);
    else dirToTarget.set(0, 1);

    // Line-of-sight is checked a few times a second (not every frame) via a
    // fast Rapier physics raycast — much cheaper than scanning the three.js
    // scene graph, which matters once several bots are active at once.
    nextLosCheck.current -= delta;
    if (nextLosCheck.current <= 0) {
      nextLosCheck.current = 0.15;
      if (target && distToTarget <= SIGHT_RANGE) {
        const origin = { x: myPos.x, y: myPos.y + TARGET_HEIGHT * 0.7, z: myPos.z };
        const dir = {
          x: dirToTarget.x,
          y: (target.position.y - origin.y) / Math.max(distToTarget, 0.01),
          z: dirToTarget.y,
        };
        const ray = new rapier.Ray(origin, dir);
        const hit = world.castRay(ray, distToTarget, true, undefined, undefined, undefined, body);
        losClear.current = !hit || hit.timeOfImpact >= distToTarget - 0.35;
      } else {
        losClear.current = false;
      }
    }

    const lowHealth = health / maxHealth <= LOW_HEALTH_FRACTION;
    const engaging = !!target && losClear.current && distToTarget <= SIGHT_RANGE;

    const moveDir = moveDirVec.current.set(0, 0);
    let desiredYaw = facing.current;
    let crouching = false;

    if (engaging && target) {
      desiredYaw = Math.atan2(dirToTarget.x, dirToTarget.y);
      const minRange = lowHealth ? PREFERRED_MIN + 2 : PREFERRED_MIN;
      const maxRange = lowHealth ? PREFERRED_MAX + 2 : PREFERRED_MAX;

      if (lowHealth) {
        // Intelligent retreat: fall back and take cover-ish posture instead
        // of trading shots at a disadvantage.
        crouching = true;
        moveDir.copy(dirToTarget).multiplyScalar(-1);
      } else if (distToTarget > maxRange) {
        moveDir.copy(dirToTarget);
      } else if (distToTarget < minRange) {
        moveDir.copy(dirToTarget).multiplyScalar(-1);
      } else {
        strafeTimer.current -= delta;
        if (strafeTimer.current <= 0) {
          strafeDir.current *= -1;
          strafeTimer.current = 1.5 + Math.random() * 1.5;
        }
        moveDir.set(-dirToTarget.y, dirToTarget.x).multiplyScalar(strafeDir.current);
      }

      // Shooting
      if (!lowHealth && elapsed.current >= nextShotTime.current) {
        nextShotTime.current = elapsed.current + preset.fireInterval + Math.random() * preset.fireJitter;
        playEnemyGunshotSound();
        flashTimer.current = 0.06;
        if (flashLightRef.current) flashLightRef.current.visible = true;

        const muzzle = muzzleVec.current.set(myPos.x, myPos.y + TARGET_HEIGHT * 0.75, myPos.z);
        muzzle.add(
          muzzleOffsetVec.current.set(dirToTarget.x, 0, dirToTarget.y).multiplyScalar(TARGET_HEIGHT * 0.35)
        );
        const tVec = targetVec.current.copy(target.position);
        if (Math.random() < preset.accuracy) {
          target.damage(preset.damage);
          bulletEffectsRef.current?.addShot(muzzle, tVec);
        } else {
          const spread = spreadVec.current.set(
            (Math.random() - 0.5) * 1.2,
            (Math.random() - 0.5) * 0.7,
            (Math.random() - 0.5) * 1.2
          );
          bulletEffectsRef.current?.addShot(muzzle, tVec.add(spread));
        }
      }
    } else {
      // Wander toward a roaming waypoint spread across the whole map.
      const toWp = toWpVec.current.set(waypoint.current.x - myPos.x, waypoint.current.y - myPos.z);
      if (toWp.length() < WAYPOINT_RADIUS) {
        randomInBounds(WANDER_MIN, WANDER_MAX, waypoint.current);
      } else {
        moveDir.copy(toWp).normalize();
        desiredYaw = Math.atan2(moveDir.x, moveDir.y);
      }
    }

    // Reactive wall/obstacle avoidance: a short forward probe steers the
    // bot away from anything it's about to walk into (containers, cars,
    // walls) without needing a full navmesh. Only re-cast a few times a
    // second (not every frame) — with several bots active at once this is
    // one of the hotter per-frame costs, and a cached steering nudge still
    // reads fine since it's just a steering assist, not exact navigation.
    nextAvoidCheck.current -= delta;
    if (moveDir.lengthSq() > 0 && nextAvoidCheck.current <= 0) {
      nextAvoidCheck.current = 0.12;
      const probeDir = probeDirVec.current.copy(moveDir).normalize();
      const ray = new rapier.Ray(
        { x: myPos.x, y: myPos.y + capsuleHalfHeight, z: myPos.z },
        { x: probeDir.x, y: 0, z: probeDir.y }
      );
      const hit = world.castRay(ray, 0.55, true, undefined, undefined, undefined, body);
      avoidTurn.current = hit && hit.timeOfImpact < 0.45 ? Math.PI / 2 * (Math.random() < 0.5 ? 1 : -1) : 0;
    }
    if (avoidTurn.current !== 0) {
      moveDir.rotateAround(ORIGIN_2D, avoidTurn.current);
    }

    // If genuinely stuck (not making progress while trying to move), force
    // a fresh wander target rather than pushing into geometry forever.
    const moved = Math.hypot(myPos.x - lastPos.current.x, myPos.z - lastPos.current.y);
    if (!engaging && moveDir.lengthSq() > 0) {
      stuckTimer.current += delta;
      if (stuckTimer.current > 1.2 && moved < 0.05) {
        randomInBounds(WANDER_MIN, WANDER_MAX, waypoint.current);
        stuckTimer.current = 0;
      }
    } else {
      stuckTimer.current = 0;
    }
    lastPos.current.set(myPos.x, myPos.z);

    const speed = crouching ? preset.moveSpeed * 0.6 : preset.moveSpeed;
    if (moveDir.lengthSq() > 0) moveDir.normalize().multiplyScalar(speed * delta);

    // Gravity + character-controller movement (mirrors the player rig so
    // bots respect the same collision the player does).
    const grounded = cc.current.computedGrounded();
    yVelocity.current = grounded ? -0.1 : Math.max(yVelocity.current + GRAVITY * delta, -20);

    const collider = body.collider(0);
    if (collider) {
      cc.current.computeColliderMovement(collider, {
        x: moveDir.x,
        y: yVelocity.current * delta,
        z: moveDir.y,
      });
      const corrected = cc.current.computedMovement();
      body.setNextKinematicTranslation({
        x: myPos.x + corrected.x,
        y: myPos.y + corrected.y,
        z: myPos.z + corrected.z,
      });
    }

    // Facing + animation.
    facing.current += shortestAngleDiff(desiredYaw, facing.current) * Math.min(1, delta * 6);
    if (visualRef.current) visualRef.current.rotation.y = facing.current;

    const isMoving = moveDir.lengthSq() > 0.0001;
    if (crouching) playAnim(isMoving ? "Rifle_crouch" : "Crouch");
    else if (isMoving) playAnim("Rifle_run");
    else playAnim("Rifle_stand");
  });

  return (
    <RigidBody
      ref={rigidBodyRef}
      type="kinematicPosition"
      colliders={false}
      position={spawnPosition}
      enabledRotations={[false, false, false]}
      canSleep={false}
      userData={{ isTarget: true, isBot: true, onHit: () => onDamageTaken(20) }}
    >
      <CapsuleCollider args={[capsuleHalfHeight, capsuleRadius]} friction={0} restitution={0} />
      <group ref={visualRef} position={[0, modelOffsetY, 0]}>
        <primitive object={clonedScene} scale={modelScale} />
      </group>
      {/* Team marker — stays level (not a child of visualRef) so it doesn't
          spin with the bot's facing direction. Lets the player tell ally
          from enemy at a glance in TDM. */}
      <mesh position={[0, TARGET_HEIGHT + 0.16, 0]} renderOrder={998}>
        <ringGeometry args={[0.05, 0.09, 20]} />
        <meshBasicMaterial color={TEAM_COLOR[team]} side={THREE.DoubleSide} depthTest={false} transparent opacity={0.9} />
      </mesh>
      <pointLight
        ref={flashLightRef}
        position={[0, TARGET_HEIGHT * 0.75, 0]}
        color="#fde047"
        intensity={6}
        distance={2.5}
        visible={false}
      />
    </RigidBody>
  );
}
