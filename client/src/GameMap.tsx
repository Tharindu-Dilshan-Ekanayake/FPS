import React, { Suspense, useRef } from "react";
import { useGLTF } from "@react-three/drei";
import { CuboidCollider, RigidBody } from "@react-three/rapier";
import * as THREE from "three";

useGLTF.preload("/map.glb");
useGLTF.preload("/map_collision.glb");

interface GameMapModelProps {
  scale?: number;
}

// Two separate map assets, on purpose:
//  - /map.glb          — visual only. Optimized (merged draw calls, GPU
//    instancing for repeated props) purely for render performance.
//  - /map_collision.glb — physics only, never rendered (see visible={false}
//    below). @react-three/rapier's automatic `colliders="trimesh"` reads
//    each Mesh's own base geometry + world matrix; it does not expand
//    per-instance transforms on an InstancedMesh, and merging hundreds of
//    unrelated props into a few giant meshes (to cut draw calls) makes
//    Rapier's trimesh builder pathologically slow. So collision uses the
//    original, unmerged, non-instanced geometry — proven correct and fast
//    to build — while the pretty mesh handles rendering only.
function GameMapModel({ scale = 1 }: GameMapModelProps) {
  const { scene: visualScene } = useGLTF("/map.glb");
  const { scene: collisionScene } = useGLTF("/map_collision.glb");
  const mapRef = useRef<THREE.Group>(null);

  const clonedVisualScene = React.useMemo(() => visualScene.clone(), [visualScene]);
  const clonedCollisionScene = React.useMemo(() => collisionScene.clone(), [collisionScene]);

  // මෙතනින් කරන්නේ Map එකේ පාට වෙනස් නොකර, Shadows (සෙවනැලි) පමණක් ON කරන එකයි
  React.useEffect(() => {
    clonedVisualScene.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        const mesh = child as THREE.Mesh;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
      }
    });
  }, [clonedVisualScene]);

  return (
    <>
      {/* Visual map — plain group, not inside a RigidBody, so it never
          contributes to the auto-generated collider. */}
      <group ref={mapRef}>
        <primitive object={clonedVisualScene} scale={scale} />
      </group>

      {/* Collision-only map — invisible, exists purely for its trimesh.
          includeInvisible is required: @react-three/rapier's automatic
          collider generation walks the scene with Object3D.traverseVisible
          by default, silently skipping anything with visible={false} — so
          without this flag no trimesh collider gets built here at all. */}
      {/* colliders="trimesh" මගින් ගෙවල්, පඩිපෙළවල් සියල්ලෙහි හැඩය නිවැරදිව හඳුනාගනී */}
      <RigidBody type="fixed" colliders="trimesh" includeInvisible position={[0, 0, 0]}>
        <primitive object={clonedCollisionScene} scale={scale} visible={false} />
        <CuboidCollider
          args={[9.5, 0.05, 20.5]}
          position={[0, -0.36, 0]}
          friction={0.9}
          restitution={0}
        />
      </RigidBody>
    </>
  );
}

// Suspense Wrapper Component
export function GameMap({ scale = 1 }: GameMapModelProps) {
  return (
    <Suspense fallback={null}>
      <GameMapModel scale={scale} />
    </Suspense>
  );
}
