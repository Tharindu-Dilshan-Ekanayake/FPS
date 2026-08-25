import { useRef, forwardRef, useImperativeHandle, useState } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

export interface BulletImpact {
  id: number;
  position: [number, number, number];
  normal: [number, number, number];
  createdAt: number;
}

export interface BulletTracer {
  id: number;
  from: [number, number, number];
  to: [number, number, number];
  createdAt: number;
}

export interface BulletEffectsHandle {
  addShot: (from: THREE.Vector3, to: THREE.Vector3, normal?: THREE.Vector3) => void;
}

export const BulletEffects = forwardRef<BulletEffectsHandle>((_, ref) => {
  const [tracers, setTracers] = useState<BulletTracer[]>([]);
  const [impacts, setImpacts] = useState<BulletImpact[]>([]);
  const idCounter = useRef(0);

  useImperativeHandle(ref, () => ({
    addShot: (from: THREE.Vector3, to: THREE.Vector3, normal?: THREE.Vector3) => {
      const now = performance.now();
      const id = ++idCounter.current;

      setTracers((prev) => [
        ...prev.slice(-15),
        { id, from: [from.x, from.y, from.z], to: [to.x, to.y, to.z], createdAt: now },
      ]);

      if (normal) {
        setImpacts((prev) => [
          ...prev.slice(-20),
          { id, position: [to.x, to.y, to.z], normal: [normal.x, normal.y, normal.z], createdAt: now },
        ]);
      }
    },
  }));

  // Clean up expired tracers and impact sparks
  useFrame(() => {
    const now = performance.now();
    setTracers((prev) => {
      const filtered = prev.filter((t) => now - t.createdAt < 100);
      return filtered.length !== prev.length ? filtered : prev;
    });
    setImpacts((prev) => {
      const filtered = prev.filter((i) => now - i.createdAt < 400);
      return filtered.length !== prev.length ? filtered : prev;
    });
  });

  return (
    <group>
      {/* Bullet Tracers (high-speed laser / glowing bullet lines) */}
      {tracers.map((t) => {
        const p1 = new THREE.Vector3(...t.from);
        const p2 = new THREE.Vector3(...t.to);
        const dir = new THREE.Vector3().subVectors(p2, p1);
        const len = dir.length();
        const mid = new THREE.Vector3().addVectors(p1, p2).multiplyScalar(0.5);
        const orientation = new THREE.Matrix4().lookAt(p1, p2, new THREE.Vector3(0, 1, 0));
        const rot = new THREE.Euler().setFromRotationMatrix(orientation);

        return (
          <group key={t.id} position={mid} rotation={rot}>
            <mesh rotation={[Math.PI / 2, 0, 0]}>
              <cylinderGeometry args={[0.008, 0.008, len, 6]} />
              <meshBasicMaterial color="#fef08a" transparent opacity={0.85} />
            </mesh>
          </group>
        );
      })}

      {/* Bullet Impact Sparks & Glowing Impact Dots */}
      {impacts.map((imp) => {
        const age = (performance.now() - imp.createdAt) / 400; // 0 to 1
        const scale = (1 - age) * 0.08;
        const opacity = 1 - age;

        return (
          <group key={imp.id} position={imp.position}>
            {/* Impact Flash Core */}
            <mesh>
              <sphereGeometry args={[scale, 8, 8]} />
              <meshBasicMaterial color="#f59e0b" transparent opacity={opacity} />
            </mesh>
            {/* Point Light Pulse on Wall */}
            {age < 0.3 && <pointLight color="#fde047" intensity={1.5} distance={1.2} />}
          </group>
        );
      })}
    </group>
  );
});
