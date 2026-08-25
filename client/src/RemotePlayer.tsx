import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { useGLTF, useAnimations } from "@react-three/drei";
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

export interface RemotePlayerHandle {
  updateState: (position: Vec3, quaternion: Quat, moving: boolean) => void;
}

interface RemotePlayerProps {
  health: number;
  onHit: () => void;
}

export const RemotePlayer = forwardRef<RemotePlayerHandle, RemotePlayerProps>(({ health, onHit }, ref) => {
  const rigidBodyRef = useRef<RapierRigidBody>(null);
  const visualRef = useRef<THREE.Group>(null);

  const { scene, animations } = useGLTF(ENEMY_URL);
  const clonedScene = useMemo(() => cloneSkeleton(scene) as THREE.Group, [scene]);
  const { actions } = useAnimations(animations, visualRef);

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

  // Network updates arrive at a much lower rate than 60fps, so the target
  // is interpolated toward every frame (see useFrame) rather than snapped
  // to directly — that's what turns ~15-20Hz network updates into smooth
  // on-screen motion.
  const targetPos = useRef(new THREE.Vector3());
  const targetQuat = useRef(new THREE.Quaternion());
  const isMoving = useRef(false);
  const hasTarget = useRef(false);
  const currentAnim = useRef<string | null>(null);

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
      targetPos.current.set(position[0], position[1] - EYE_HEIGHT, position[2]);
      targetQuat.current.set(quaternion[0], quaternion[1], quaternion[2], quaternion[3]);
      isMoving.current = moving;
      hasTarget.current = true;
    },
  }));

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
  const nextPosVec = useRef(new THREE.Vector3());

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

    // Smoothly chase the latest network sample rather than teleporting to
    // it — damp() gives a springy-but-stable follow that hides the gap
    // between network update ticks and the render's 60fps.
    const bodyPos = body.translation();
    const next = nextPosVec.current.set(
      THREE.MathUtils.damp(bodyPos.x, targetPos.current.x, 12, delta),
      THREE.MathUtils.damp(bodyPos.y, targetPos.current.y, 12, delta),
      THREE.MathUtils.damp(bodyPos.z, targetPos.current.z, 12, delta)
    );
    body.setNextKinematicTranslation(next);

    // Only the horizontal facing (yaw) drives the body mesh — same as
    // Bot.tsx, which never pitches/rolls the visible model. Note: this
    // rig's rest pose faces +Z at rotation.y=0 (confirmed by Bot.tsx's
    // own proven-correct atan2(dx, dz), no negation) — NOT the standard
    // three.js camera convention of facing -Z at yaw=0. Using the camera
    // formula here (atan2(x, -z)) put the avatar 180° off, so it always
    // showed its back where it should show its front.
    forwardVec.current.set(0, 0, -1).applyQuaternion(targetQuat.current);
    const yaw = Math.atan2(forwardVec.current.x, forwardVec.current.z);
    if (visualRef.current) {
      const curYaw = visualRef.current.rotation.y;
      const diff = Math.atan2(Math.sin(yaw - curYaw), Math.cos(yaw - curYaw));
      visualRef.current.rotation.y = curYaw + diff * Math.min(1, delta * 10);
    }

    playAnim(isMoving.current ? "Rifle_run" : "Rifle_stand");
  });

  return (
    <RigidBody
      ref={rigidBodyRef}
      type="kinematicPosition"
      colliders={false}
      position={[0, 2, 0]}
      enabledRotations={[false, false, false]}
      canSleep={false}
      userData={{ isTarget: true, isBot: true, onHit }}
    >
      <CapsuleCollider args={[capsuleHalfHeight, capsuleRadius]} friction={0} restitution={0} />
      <group ref={visualRef} position={[0, modelOffsetY, 0]}>
        <primitive object={clonedScene} scale={modelScale} />
      </group>
      <mesh position={[0, TARGET_HEIGHT + 0.16, 0]} renderOrder={998}>
        <ringGeometry args={[0.05, 0.09, 20]} />
        <meshBasicMaterial color="#ef4444" side={THREE.DoubleSide} depthTest={false} transparent opacity={0.9} />
      </mesh>
    </RigidBody>
  );
});
RemotePlayer.displayName = "RemotePlayer";
