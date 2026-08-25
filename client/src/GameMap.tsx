import React, { Suspense, useRef } from "react";
import { useGLTF } from "@react-three/drei";
import { CuboidCollider, RigidBody } from "@react-three/rapier";
import * as THREE from "three";

useGLTF.preload("/map.glb");

interface GameMapModelProps {
  scale?: number;
}

// Core Game Map Component
function GameMapModel({ scale = 1 }: GameMapModelProps) {
  const { scene } = useGLTF("/map.glb");
  const mapRef = useRef<THREE.Group>(null);

  // Clone the scene
  const clonedScene = React.useMemo(() => scene.clone(), [scene]);

  // මෙතනින් කරන්නේ Map එකේ පාට වෙනස් නොකර, Shadows (සෙවනැලි) පමණක් ON කරන එකයි
  React.useEffect(() => {
    clonedScene.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        const mesh = child as THREE.Mesh;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
      }
    });
  }, [clonedScene]);

  return (
    // colliders="trimesh" මගින් ගෙවල්, පඩිපෙළවල් සියල්ලෙහි හැඩය නිවැරදිව හඳුනාගනී
    <RigidBody type="fixed" colliders="trimesh" position={[0, 0, 0]}>
      <group ref={mapRef}>
        <primitive object={clonedScene} scale={scale} />
      </group>
      <CuboidCollider
        args={[9.5, 0.05, 20.5]}
        position={[0, -0.36, 0]}
        friction={0.9}
        restitution={0}
      />
    </RigidBody>
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