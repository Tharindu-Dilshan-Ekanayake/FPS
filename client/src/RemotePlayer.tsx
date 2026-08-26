import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { useGLTF, useAnimations, Billboard, Text } from "@react-three/drei";
import { RigidBody, RapierRigidBody, CapsuleCollider } from "@react-three/rapier";
import * as THREE from "three";
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";
import { EYE_HEIGHT } from "./playerConstants";
import type { Quat, Vec3 } from "./network";

const ENEMY_URL = "/enime.glb"; // already preloaded by Bot.tsx

// Same rig/proportions as Bot.tsx's humanoid model, so the opponent's
// avatar reads at the same size and the eye-height math below lines up
// with how Player (App.tsx) reports its own camera position.
const TARGET_HEIGHT = 0.5;

// Headshots are decided against the rig's actual head bone (confirmed via
// the GLB's node list — this is a Mixamo-style skeleton) rather than a
// height-fraction guess: a shot counts if the mesh raycast's hit point
// lands within this radius of the head bone's current (animated) world
// position. Falls back to a height-fraction heuristic if the bone is ever
// missing (e.g. a different model gets swapped in later).
const HEAD_BONE_NAME = "mixamorig:Head_1";
const HEAD_HIT_RADIUS = TARGET_HEIGHT * 0.15;
const HEADSHOT_HEIGHT_FRACTION = 0.8;

// This rig's clip list (Crouch/Idle/Rifle_crouch/Rifle_run/Rifle_stand/
// Run/Walk — confirmed via inspecting enime.glb directly) has no dedicated
// aim/fire pose at all; Rifle_stand is just a relaxed standing-with-rifle
// carry, not a raised/ready stance. A bot rarely holds still in it (it's
// almost always strafing/repositioning while fighting), but a real duel
// opponent frequently stops to aim — which is exactly when a player is
// watching them shoot, so the missing pose is far more noticeable there.
// There's no clip to switch to, so this fakes a recoil kick procedurally:
// a temporary rotation nudge on the firing arm, decaying back to whatever
// the current animation clip is driving that frame (this runs after
// useAnimations' own mixer update, so it layers on top rather than
// fighting it). Confirmed via the GLB's Rifle_stand channels that this
// bone is actually animated by every relevant clip, so nudging it doesn't
// require a separate unanimated bone.
const GUN_ARM_BONE_NAME = "mixamorig:RightForeArm_16";
const RECOIL_KICK_DURATION = 0.14;
const RECOIL_KICK_ANGLE = 0.16;

// Render the opponent this far in the past, interpolating BETWEEN two real
// network samples rather than damp()-chasing the latest one. Chasing a
// single target looks fine on a steady connection, but under real-world
// jitter (updates arriving unevenly instead of a clean ~50ms cadence) it
// visibly stutters: the avatar coasts to a stop waiting on the next packet,
// then snaps when a late one finally lands. Interpolating between two
// already-received samples is immune to that — as long as two samples
// straddle the render time, motion between them is smooth no matter how
// irregular their arrival was. This is the standard remote-entity
// smoothing technique (same idea id/Source-engine-style shooters use).
const INTERP_DELAY_MS = 100;
// Bound on how long a sample is kept around — comfortably more than
// INTERP_DELAY_MS needs, just cheap insurance against the buffer growing
// if updates ever stopped arriving.
const MAX_SAMPLE_AGE_MS = 1000;

interface NetSample {
  t: number;
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
  moving: boolean;
}

export interface RemotePlayerHandle {
  updateState: (position: Vec3, quaternion: Quat, moving: boolean) => void;
  // Called when the server reports the opponent fired, so their avatar
  // shows a muzzle flash — otherwise the only visible cue is a bullet
  // tracer streaking past, and it's easy to miss that they shot at all.
  muzzleFlash: () => void;
}

interface RemotePlayerProps {
  health: number;
  onHit: (headshot: boolean) => void;
}

export const RemotePlayer = forwardRef<RemotePlayerHandle, RemotePlayerProps>(({ health, onHit }, ref) => {
  const rigidBodyRef = useRef<RapierRigidBody>(null);
  const visualRef = useRef<THREE.Group>(null);
  const flashLightRef = useRef<THREE.PointLight>(null);
  const flashSpriteRef = useRef<THREE.Mesh>(null);
  const flashTimer = useRef(0);
  const recoilTimer = useRef(0);

  const { scene, animations } = useGLTF(ENEMY_URL);
  const clonedScene = useMemo(() => cloneSkeleton(scene) as THREE.Group, [scene]);
  const { actions } = useAnimations(animations, visualRef);
  const headBone = useMemo(() => clonedScene.getObjectByName(HEAD_BONE_NAME) ?? null, [clonedScene]);
  const headWorldPos = useRef(new THREE.Vector3());
  const gunArmBone = useMemo(() => clonedScene.getObjectByName(GUN_ARM_BONE_NAME) ?? null, [clonedScene]);

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
        mesh.frustumCulled = false;
      }
    });
  }, [clonedScene]);

  // Network updates arrive at a much lower rate than 60fps — this buffers
  // recent samples so useFrame can interpolate BETWEEN two real ones each
  // render (see INTERP_DELAY_MS) instead of chasing the latest toward a
  // moving target, which is what actually turns updates into smooth
  // on-screen motion resiliently, jitter or not.
  const samples = useRef<NetSample[]>([]);
  const isMoving = useRef(false);
  const hasTarget = useRef(false);
  const currentAnim = useRef<string | null>(null);
  // Scratch objects the interpolation writes into each frame — avoids
  // allocating a fresh Vector3/Quaternion 60 times a second.
  const interpPos = useRef(new THREE.Vector3());
  const interpQuat = useRef(new THREE.Quaternion());

  // Fake ragdoll on death — mirrors Bot.tsx's collapse effect. The rig has
  // no death animation clip at all (see Bot.tsx), so this fakes one by
  // freezing whatever was playing and tipping the model over.
  const deathTriggered = useRef(false);
  const deathProgress = useRef(0);
  const DEATH_FALL_SECONDS = 0.5;

  useImperativeHandle(ref, () => ({
    updateState: (position, quaternion, moving) => {
      // The network payload is the sender's CAMERA position (see Player in
      // App.tsx); subtract EYE_HEIGHT to recover the capsule-center height
      // this rig's own proportions expect (see Bot.tsx's identical note).
      const now = performance.now();
      const buf = samples.current;
      buf.push({
        t: now,
        pos: new THREE.Vector3(position[0], position[1] - EYE_HEIGHT, position[2]),
        quat: new THREE.Quaternion(quaternion[0], quaternion[1], quaternion[2], quaternion[3]),
        moving,
      });
      const cutoff = now - MAX_SAMPLE_AGE_MS;
      while (buf.length > 2 && buf[0].t < cutoff) buf.shift();
      isMoving.current = moving;
      hasTarget.current = true;
    },
    muzzleFlash: () => {
      // Longer/brighter than a bot's (0.06s) — the duel opponent is the
      // one thing in the scene the player is actively watching for this
      // cue, so it needs to read clearly even against bright/outdoor
      // lighting where a lone point light alone can wash out.
      flashTimer.current = 0.1;
      if (flashLightRef.current) flashLightRef.current.visible = true;
      if (flashSpriteRef.current) flashSpriteRef.current.visible = true;
      // The rig has no fire/aim animation to switch to (see
      // RECOIL_KICK_DURATION's comment) — this fakes the shot's visible
      // "action" the other way, with a procedural kick on the gun arm.
      recoilTimer.current = RECOIL_KICK_DURATION;
    },
  }));

  // Decide headshot vs. body shot from where the shot actually landed:
  // within HEAD_HIT_RADIUS of the head bone's live (animated) world
  // position, falling back to the old height-fraction heuristic only if
  // the bone lookup ever comes up empty. Returns the verdict too (not just
  // reporting it via onHit) so the shooter's own RaycastShooter can show
  // the right hitmarker immediately, without waiting on the server
  // round-trip that onHit's message kicks off.
  const handleHitPoint = useCallback(
    (hitPoint: THREE.Vector3) => {
      const body = rigidBodyRef.current;
      if (!body) {
        onHit(false);
        return false;
      }
      let headshot: boolean;
      if (headBone) {
        const headPos = headBone.getWorldPosition(headWorldPos.current);
        headshot = hitPoint.distanceTo(headPos) <= HEAD_HIT_RADIUS;
      } else {
        const feetY = body.translation().y - TARGET_HEIGHT / 2;
        headshot = hitPoint.y - feetY >= TARGET_HEIGHT * HEADSHOT_HEIGHT_FRACTION;
      }
      onHit(headshot);
      return headshot;
    },
    [onHit, headBone]
  );

  const playAnim = (name: string, fade = 0.25) => {
    if (!actions || currentAnim.current === name) return;
    const next = actions[name];
    if (!next) return;
    const prevName = currentAnim.current;
    if (prevName && actions[prevName]) actions[prevName]?.fadeOut(fade);
    next.reset().fadeIn(fade).play();
    currentAnim.current = name;
  };

  useEffect(() => {
    if (!actions) return;
    actions["Rifle_stand"]?.reset().play();
    currentAnim.current = "Rifle_stand";
  }, [actions]);

  const forwardVec = useRef(new THREE.Vector3());

  useFrame((_state, delta) => {
    const body = rigidBodyRef.current;
    if (!body || !hasTarget.current) return;

    if (health <= 0) {
      if (!deathTriggered.current) {
        deathTriggered.current = true;
        if (actions && currentAnim.current) actions[currentAnim.current]?.fadeOut(0.2);
      }
      deathProgress.current = Math.min(deathProgress.current + delta / DEATH_FALL_SECONDS, 1);
      const eased = 1 - Math.pow(1 - deathProgress.current, 3);
      if (visualRef.current) {
        visualRef.current.rotation.x = -(Math.PI / 2) * eased;
        visualRef.current.position.y = modelOffsetY - capsuleHalfHeight * 0.6 * eased;
      }
      return;
    }
    deathTriggered.current = false;
    deathProgress.current = 0;
    // Undo the collapse pose on respawn — nothing else in this component
    // ever touches rotation.x, and the position.y set here is cheap enough
    // to just re-assert every frame rather than track a one-shot reset.
    if (visualRef.current) {
      visualRef.current.rotation.x = 0;
      visualRef.current.position.y = modelOffsetY;
    }

    if (flashTimer.current > 0) {
      flashTimer.current -= delta;
      const stillFlashing = flashTimer.current > 0;
      if (flashLightRef.current) flashLightRef.current.visible = stillFlashing;
      if (flashSpriteRef.current) {
        flashSpriteRef.current.visible = stillFlashing;
        // The sprite is inside a Billboard (always faces camera) — jitter
        // its in-plane rotation per flash so repeated shots don't look
        // like the same static image blinking on and off.
        flashSpriteRef.current.rotation.z = Math.random() * Math.PI * 2;
      }
    }

    // Procedural recoil kick (see RECOIL_KICK_DURATION's comment) — applied
    // after useAnimations' own mixer update for this frame (that hook is
    // called earlier in this component, so its frame subscription runs
    // first), so this nudge layers on top of whatever pose is currently
    // playing instead of being overwritten by it.
    if (recoilTimer.current > 0 && gunArmBone) {
      recoilTimer.current -= delta;
      const k = Math.max(recoilTimer.current, 0) / RECOIL_KICK_DURATION;
      gunArmBone.rotation.x -= RECOIL_KICK_ANGLE * k;
    }

    // Render INTERP_DELAY_MS in the past, interpolated between the two real
    // samples straddling that moment — see INTERP_DELAY_MS's comment for
    // why this replaced damp()-chasing the latest sample.
    const buf = samples.current;
    const renderTime = performance.now() - INTERP_DELAY_MS;
    let moving: boolean;
    if (buf.length === 1 || renderTime <= buf[0].t) {
      interpPos.current.copy(buf[0].pos);
      interpQuat.current.copy(buf[0].quat);
      moving = buf[0].moving;
    } else if (renderTime >= buf[buf.length - 1].t) {
      // No fresher sample yet — hold at the latest known one rather than
      // extrapolating past real data.
      const last = buf[buf.length - 1];
      interpPos.current.copy(last.pos);
      interpQuat.current.copy(last.quat);
      moving = last.moving;
    } else {
      let i = buf.length - 2;
      while (i > 0 && buf[i].t > renderTime) i--;
      const a = buf[i];
      const b = buf[i + 1];
      const span = b.t - a.t;
      const frac = span > 0 ? (renderTime - a.t) / span : 0;
      interpPos.current.lerpVectors(a.pos, b.pos, frac);
      interpQuat.current.slerpQuaternions(a.quat, b.quat, frac);
      moving = frac < 0.5 ? a.moving : b.moving;
    }
    isMoving.current = moving;
    body.setNextKinematicTranslation(interpPos.current);

    // Only the horizontal facing (yaw) drives the body mesh — same as
    // Bot.tsx, which never pitches/rolls the visible model. Note: this
    // rig's rest pose faces +Z at rotation.y=0 (confirmed by Bot.tsx's
    // own proven-correct atan2(dx, dz), no negation) — NOT the standard
    // three.js camera convention of facing -Z at yaw=0. Using the camera
    // formula here (atan2(x, -z)) put the avatar 180° off, so it always
    // showed its back where it should show its front.
    forwardVec.current.set(0, 0, -1).applyQuaternion(interpQuat.current);
    const yaw = Math.atan2(forwardVec.current.x, forwardVec.current.z);
    if (visualRef.current) {
      const curYaw = visualRef.current.rotation.y;
      const diff = Math.atan2(Math.sin(yaw - curYaw), Math.cos(yaw - curYaw));
      visualRef.current.rotation.y = curYaw + diff * Math.min(1, delta * 10);
    }

    playAnim(moving ? "Rifle_run" : "Rifle_stand");
  });

  return (
    <RigidBody
      ref={rigidBodyRef}
      type="kinematicPosition"
      colliders={false}
      position={[0, 2, 0]}
      enabledRotations={[false, false, false]}
      canSleep={false}
      userData={{ isTarget: true, isBot: true, onHit: handleHitPoint }}
    >
      <CapsuleCollider args={[capsuleHalfHeight, capsuleRadius]} friction={0} restitution={0} />
      <group ref={visualRef} position={[0, modelOffsetY, 0]}>
        <primitive object={clonedScene} scale={modelScale} />
      </group>
      <Billboard position={[0, TARGET_HEIGHT + 0.18, 0]}>
        <Text
          fontSize={0.075}
          color="#ef4444"
          anchorX="center"
          anchorY="bottom"
          outlineWidth={0.006}
          outlineColor="#000000"
          renderOrder={998}
          material-depthTest={false}
        >
          Opponent
        </Text>
      </Billboard>
      <pointLight
        ref={flashLightRef}
        position={[0, TARGET_HEIGHT * 0.75, 0]}
        color="#fde047"
        intensity={9}
        distance={3}
        visible={false}
      />
      {/* Unlit flash quad — the point light alone can wash out against
          bright/outdoor lighting; this reads regardless of scene lighting
          since meshBasicMaterial ignores it entirely. */}
      <Billboard position={[0, TARGET_HEIGHT * 0.75, 0]}>
        <mesh ref={flashSpriteRef} visible={false} renderOrder={999}>
          <planeGeometry args={[0.16, 0.16]} />
          <meshBasicMaterial color="#fff7c2" transparent opacity={0.95} depthTest={false} />
        </mesh>
      </Billboard>
    </RigidBody>
  );
});
RemotePlayer.displayName = "RemotePlayer";
