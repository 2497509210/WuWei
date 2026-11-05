import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { ContactShadows, Edges, OrbitControls, PerspectiveCamera } from "@react-three/drei";
import * as THREE from "three";
import type { Container, RoomSummary } from "../api/client";
import { useIsMobile } from "../hooks/useIsMobile";
import { snapContainerToWalls } from "./layout";

const M = 0.01;

export type RoomSceneHandle = {
  zoom: (factor: number) => void;
  reset: () => void;
  focus: (containerId: string, front?: boolean) => void;
};

function useWoodTexture() {
  return useMemo(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 512;
    const ctx = canvas.getContext("2d")!;
    const tones = ["#b08a63", "#b98f68", "#a8825c", "#bf9670", "#ad855d"];
    const plank = 88;
    for (let row = 0; row * plank < 512; row++) {
      ctx.fillStyle = tones[row % tones.length];
      ctx.fillRect(0, row * plank, 512, plank);
      ctx.strokeStyle = "rgba(92,62,34,0.16)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, row * plank + 1);
      ctx.lineTo(512, row * plank + 1);
      ctx.stroke();
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(3, 2.5);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 8;
    return texture;
  }, []);
}

function Wall({
  width,
  height,
  position,
  rotationY,
  normal,
  color = "#f1e7d7",
}: {
  width: number;
  height: number;
  position: [number, number, number];
  rotationY: number;
  normal: THREE.Vector3;
  color?: string;
}) {
  const material = useRef<THREE.MeshStandardMaterial>(null);
  const mesh = useRef<THREE.Mesh>(null);
  const center = useMemo(() => new THREE.Vector3(...position), [position]);

  useFrame(({ camera, invalidate }, delta) => {
    if (!material.current) return;
    const dot = camera.position.clone().sub(center).dot(normal);
    const target = dot > 0.2 ? 0 : 1;
    const difference = Math.abs(material.current.opacity - target);
    const next = difference < 0.002 ? target : THREE.MathUtils.damp(material.current.opacity, target, 7, Math.min(delta, 0.05));
    material.current.opacity = next;
    material.current.depthWrite = next > 0.5;
    if (mesh.current) mesh.current.visible = next > 0.22;
    // Demand rendering still needs every transition frame until the wall has settled.
    if (Math.abs(next - target) >= 0.002) invalidate();
  });

  return (
    <mesh ref={mesh} position={position} rotation-y={rotationY} receiveShadow castShadow={false}>
      <boxGeometry args={[width, height, 0.08]} />
      <meshStandardMaterial ref={material} color={color} roughness={0.96} transparent opacity={1} />
    </mesh>
  );
}

function Window({ room }: { room: RoomSummary }) {
  const w = room.width_cm * M;
  const h = room.height_cm * M;
  const d = room.depth_cm * M;
  const winW = Math.min(1.6, w * 0.32);
  const winH = Math.min(1.3, h * 0.42);
  return (
    <group position={[w * 0.12, h * 0.62, -d / 2 + 0.045]}>
      <mesh>
        <planeGeometry args={[winW, winH]} />
        <meshBasicMaterial color="#cfe4ee" />
      </mesh>
      <mesh position={[0, winH / 2 + 0.04, 0]}>
        <boxGeometry args={[winW + 0.1, 0.06, 0.06]} />
        <meshStandardMaterial color="#fbf7ef" />
      </mesh>
      <mesh position={[0, -winH / 2 - 0.04, 0]}>
        <boxGeometry args={[winW + 0.1, 0.06, 0.06]} />
        <meshStandardMaterial color="#fbf7ef" />
      </mesh>
      <mesh position={[-winW / 2 - 0.04, 0, 0]}>
        <boxGeometry args={[0.06, winH, 0.06]} />
        <meshStandardMaterial color="#fbf7ef" />
      </mesh>
      <mesh position={[winW / 2 + 0.04, 0, 0]}>
        <boxGeometry args={[0.06, winH, 0.06]} />
        <meshStandardMaterial color="#fbf7ef" />
      </mesh>
      <mesh>
        <boxGeometry args={[0.035, winH, 0.05]} />
        <meshStandardMaterial color="#fbf7ef" />
      </mesh>
    </group>
  );
}

function RoomShell({ room }: { room: RoomSummary }) {
  const w = room.width_cm * M;
  const d = room.depth_cm * M;
  const h = room.height_cm * M;
  const wood = useWoodTexture();
  useEffect(() => () => wood.dispose(), [wood]);

  return (
    <group>
      <mesh position={[0, -0.06, 0]} receiveShadow>
        <boxGeometry args={[w, 0.12, d]} />
        <meshStandardMaterial map={wood} roughness={0.68} />
      </mesh>
      <mesh position={[0, 0.011, d * 0.06]} receiveShadow>
        <boxGeometry args={[w * 0.44, 0.02, d * 0.38]} />
        <meshStandardMaterial color="#c2a98c" roughness={1} />
      </mesh>
      <Wall width={w} height={h} position={[0, h / 2, -d / 2]} rotationY={0} normal={new THREE.Vector3(0, 0, -1)} />
      <Wall width={d} height={h} position={[-w / 2, h / 2, 0]} rotationY={Math.PI / 2} normal={new THREE.Vector3(-1, 0, 0)} />
      <mesh position={[0, 0.06, -d / 2 + 0.05]}>
        <boxGeometry args={[w, 0.12, 0.025]} />
        <meshStandardMaterial color="#f8f3ea" roughness={0.9} />
      </mesh>
      <mesh position={[-w / 2 + 0.05, 0.06, 0]} rotation-y={Math.PI / 2}>
        <boxGeometry args={[d, 0.12, 0.025]} />
        <meshStandardMaterial color="#f8f3ea" roughness={0.9} />
      </mesh>
      <mesh position={[w / 2 - 0.05, 0.06, 0]} rotation-y={Math.PI / 2}>
        <boxGeometry args={[d, 0.12, 0.025]} />
        <meshStandardMaterial color="#f8f3ea" roughness={0.9} />
      </mesh>
      {[
        [-w / 2 + 0.03, -d / 2 + 0.03],
        [w / 2 - 0.03, -d / 2 + 0.03],
      ].map(([x, z], index) => (
        <mesh key={index} position={[x, h / 2, z]}>
          <boxGeometry args={[0.06, h, 0.06]} />
          <meshStandardMaterial color="#f8f3ea" roughness={0.9} />
        </mesh>
      ))}
      <Window room={room} />
    </group>
  );
}

function containerColor(container: Container): string {
  if (container.color) return container.color;
  switch (container.preset) {
    case "wardrobe":
      return "#c3a37f";
    case "drawer_unit":
      return "#aebbaa";
    case "storage_box":
      return "#e6d3b3";
    case "shelf":
      return "#c9a87e";
    case "bed":
      return "#cbb8a2";
    case "coffee_table":
      return "#b98b5e";
    case "desk":
      return "#c9a87e";
    default:
      return "#d8c3a5";
  }
}

function ContainerShape({ container }: { container: Container }) {
  const w = container.width_cm * M;
  const h = container.height_cm * M;
  const d = container.depth_cm * M;
  const color = containerColor(container);
  const lighter = new THREE.Color(color).offsetHSL(0, -0.03, 0.06).getStyle();
  const layers = container.config.layers ?? 3;

  if (container.preset === "wardrobe") {
    return (
      <group>
        <mesh position={[0, h / 2, 0]} castShadow receiveShadow>
          <boxGeometry args={[w, h, d]} />
          <meshStandardMaterial color={color} roughness={0.82} />
        </mesh>
        {[-1, 1].map((side) => (
          <group key={side}>
            <mesh position={[(side * w) / 4, h / 2, d / 2 + 0.015]} castShadow>
              <boxGeometry args={[w / 2 - 0.012, h - 0.05, 0.028]} />
              <meshStandardMaterial color={lighter} roughness={0.78} />
            </mesh>
            <mesh position={[(side * (w / 2 - 0.08)), h / 2, d / 2 + 0.04]}>
              <boxGeometry args={[0.018, 0.16, 0.018]} />
              <meshStandardMaterial color="#6f5f4b" metalness={0.4} roughness={0.4} />
            </mesh>
          </group>
        ))}
        <mesh position={[0, 0.04, 0]}>
          <boxGeometry args={[w - 0.05, 0.08, d - 0.04]} />
          <meshStandardMaterial color="#9c7c58" />
        </mesh>
      </group>
    );
  }

  if (container.preset === "drawer_unit") {
    return (
      <group>
        <mesh position={[0, h / 2, 0]} castShadow receiveShadow>
          <boxGeometry args={[w, h, d]} />
          <meshStandardMaterial color={color} roughness={0.82} />
        </mesh>
        {Array.from({ length: Math.max(1, Math.min(6, layers)) }).map((_, index) => {
          const drawerH = h / Math.max(1, layers);
          return (
            <mesh key={index} position={[0, drawerH * (index + 0.5), d / 2 + 0.012]} castShadow>
              <boxGeometry args={[w - 0.05, drawerH - 0.02, 0.025]} />
              <meshStandardMaterial color={lighter} roughness={0.8} />
            </mesh>
          );
        })}
      </group>
    );
  }

  if (container.preset === "storage_box" || container.preset === "custom_box") {
    return (
      <group>
        <mesh position={[0, h * 0.42, 0]} castShadow receiveShadow>
          <boxGeometry args={[w, h * 0.84, d]} />
          <meshStandardMaterial color={color} roughness={0.86} />
        </mesh>
        <mesh position={[0, h * 0.9, 0]} castShadow>
          <boxGeometry args={[w + 0.012, h * 0.16, d + 0.012]} />
          <meshStandardMaterial color={lighter} roughness={0.8} />
        </mesh>
      </group>
    );
  }

  if (container.preset === "shelf") {
    const shelves = Math.max(2, Math.min(6, layers));
    return (
      <group>
        {[-1, 1].map((side) => (
          <mesh key={side} position={[(side * (w / 2 - 0.025)), h / 2, 0]} castShadow>
            <boxGeometry args={[0.05, h, d]} />
            <meshStandardMaterial color={color} roughness={0.82} />
          </mesh>
        ))}
        {Array.from({ length: shelves }).map((_, index) => (
          <mesh key={index} position={[0, (h / (shelves - 1)) * index, 0]} castShadow receiveShadow>
            <boxGeometry args={[w, 0.035, d]} />
            <meshStandardMaterial color={lighter} roughness={0.82} />
          </mesh>
        ))}
      </group>
    );
  }

  if (container.preset === "bed") {
    return (
      <group>
        <mesh position={[0, 0.18, 0]} castShadow receiveShadow>
          <boxGeometry args={[w, 0.36, d]} />
          <meshStandardMaterial color={color} roughness={0.9} />
        </mesh>
        <mesh position={[0, 0.45, 0]} castShadow>
          <boxGeometry args={[w - 0.08, 0.18, d - 0.08]} />
          <meshStandardMaterial color="#f4eee4" roughness={0.95} />
        </mesh>
        <mesh position={[0, 0.55, -d / 2 + 0.06]} castShadow>
          <boxGeometry args={[w, 0.9, 0.12]} />
          <meshStandardMaterial color={lighter} roughness={0.9} />
        </mesh>
      </group>
    );
  }

  if (container.preset === "coffee_table") {
    return (
      <group>
        <mesh position={[0, h * 0.82, 0]} castShadow receiveShadow>
          <boxGeometry args={[w, 0.06, d]} />
          <meshStandardMaterial color={color} roughness={0.7} />
        </mesh>
        <mesh position={[0, h * 0.3, 0]} castShadow>
          <boxGeometry args={[w - 0.08, 0.035, d - 0.06]} />
          <meshStandardMaterial color={lighter} roughness={0.8} />
        </mesh>
        {[
          [-w / 2 + 0.06, -d / 2 + 0.06],
          [w / 2 - 0.06, -d / 2 + 0.06],
          [-w / 2 + 0.06, d / 2 - 0.06],
          [w / 2 - 0.06, d / 2 - 0.06],
        ].map(([x, z], index) => (
          <mesh key={index} position={[x, h * 0.41, z]} castShadow>
            <boxGeometry args={[0.045, h * 0.82, 0.045]} />
            <meshStandardMaterial color={color} roughness={0.75} />
          </mesh>
        ))}
      </group>
    );
  }

  if (container.preset === "desk") {
    return (
      <group>
        <mesh position={[0, h * 0.9, 0]} castShadow receiveShadow>
          <boxGeometry args={[w, 0.055, d]} />
          <meshStandardMaterial color={color} roughness={0.8} />
        </mesh>
        {[-1, 1].map((side) => (
          <mesh key={side} position={[(side * (w / 2 - 0.06)), h * 0.45, 0]} castShadow>
            <boxGeometry args={[0.055, h * 0.9, d - 0.05]} />
            <meshStandardMaterial color={color} roughness={0.82} />
          </mesh>
        ))}
        <mesh position={[w * 0.2, h * 0.55, d / 2 - 0.04]} castShadow>
          <boxGeometry args={[w * 0.35, h * 0.22, 0.03]} />
          <meshStandardMaterial color={lighter} roughness={0.8} />
        </mesh>
      </group>
    );
  }

  return (
    <mesh position={[0, h / 2, 0]} castShadow receiveShadow>
      <boxGeometry args={[w, h, d]} />
      <meshStandardMaterial color={color} roughness={0.86} />
    </mesh>
  );
}

function ContainerMesh({
  container,
  room,
  selected,
  editMode,
  onSelect,
  onDragStart,
}: {
  container: Container;
  room: RoomSummary;
  selected: boolean;
  editMode: boolean;
  onSelect: (id: string) => void;
  onDragStart: (id: string, event: ThreeEvent<PointerEvent>) => void;
}) {
  const w = container.width_cm * M;
  const h = container.height_cm * M;
  const d = container.depth_cm * M;
  const x = (container.x_cm - room.width_cm / 2) * M;
  const z = (container.z_cm - room.depth_cm / 2) * M;

  return (
    <group
      position={[x, container.y_cm * M, z]}
      rotation-y={(container.rot_deg * Math.PI) / 180}
      onClick={(event) => {
        event.stopPropagation();
        onSelect(container.id);
      }}
      onPointerDown={(event) => {
        if (!editMode) return;
        event.stopPropagation();
        onDragStart(container.id, event);
      }}
      onPointerOver={() => {
        if (editMode) document.body.style.cursor = "grab";
      }}
      onPointerOut={() => {
        document.body.style.cursor = "";
      }}
    >
      <mesh position={[0, h / 2, 0]}>
        <boxGeometry args={[w + 0.24, h + 0.2, d + 0.24]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
      <ContainerShape container={container} />
      {selected && (
        <>
          <mesh position={[0, h / 2, 0]}>
            <boxGeometry args={[w + 0.05, h + 0.05, d + 0.05]} />
            <meshBasicMaterial transparent opacity={0} />
            <Edges color="#e2603f" />
          </mesh>
          <mesh rotation-x={-Math.PI / 2} position={[0, 0.012, 0]}>
            <planeGeometry args={[w + 0.05, d + 0.05]} />
            <meshBasicMaterial color="#e2603f" transparent opacity={0.16} side={THREE.DoubleSide} depthWrite={false} />
          </mesh>
        </>
      )}
    </group>
  );
}

function CameraRig({
  room,
  containers,
  focusContainerId,
  enabled,
  controllerRef,
}: {
  room: RoomSummary;
  containers: Container[];
  focusContainerId?: string | null;
  enabled: boolean;
  controllerRef?: MutableRefObject<RoomSceneHandle | null>;
}) {
  const { camera, invalidate, size } = useThree();
  const controls = useRef<any>(null);
  const containersRef = useRef(containers);
  containersRef.current = containers;
  const w = room.width_cm * M;
  const d = room.depth_cm * M;
  const h = room.height_cm * M;

  const fitCamera = useCallback(() => {
    const mobile = size.width < 780;
    const factor = mobile ? 1.95 : 1;
    camera.position.set(w * 0.95 * factor, h * 1.55 * factor, d * 1.45 * factor);
    camera.lookAt(0, h * 0.42, 0);
    if (controls.current) {
      controls.current.target.set(0, h * 0.42, 0);
      controls.current.update();
    }
    invalidate();
  }, [camera, w, d, h, size.width, invalidate]);

  const focusContainer = useCallback((containerId: string, front = false) => {
    const container = containersRef.current.find((entry) => entry.id === containerId);
    if (!container || !controls.current) return;
    const target = new THREE.Vector3(
      container.x_cm * M - w / 2,
      (container.y_cm + container.height_cm * 0.5) * M,
      container.z_cm * M - d / 2
    );
    const verticalFov = ((camera as THREE.PerspectiveCamera).fov * Math.PI) / 180;
    const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * Math.max(0.25, size.width / Math.max(1, size.height)));
    const distance = Math.max(
      1,
      container.height_cm * M / (2 * Math.tan(verticalFov / 2)),
      container.width_cm * M / (2 * Math.tan(horizontalFov / 2))
    ) * 1.25 + container.depth_cm * M * 0.5;
    const angle = (container.rot_deg * Math.PI) / 180 + (front ? 0 : 0.35);
    const direction = new THREE.Vector3(Math.sin(angle), front ? 0.04 : 0.42, Math.cos(angle)).normalize();
    camera.position.copy(target).addScaledVector(direction, distance);
    camera.lookAt(target);
    controls.current.target.copy(target);
    controls.current.update();
    invalidate();
  }, [camera, w, d, size.width, size.height, invalidate]);

  useEffect(() => {
    fitCamera();
  }, [fitCamera, room.id]);

  useEffect(() => {
    if (focusContainerId) focusContainer(focusContainerId);
  }, [focusContainerId, focusContainer, room.id]);

  useEffect(() => {
    if (!controllerRef) return;
    controllerRef.current = {
      zoom(factor: number) {
        if (!controls.current) return;
        const target = controls.current.target as THREE.Vector3;
        const offset = camera.position.clone().sub(target);
        const distance = THREE.MathUtils.clamp(
          offset.length() * factor,
          0.65,
          Math.max(12, w * 2.4, d * 2.4)
        );
        camera.position.copy(target).add(offset.normalize().multiplyScalar(distance));
        controls.current.update();
        invalidate();
      },
      reset() {
        fitCamera();
      },
      focus: focusContainer,
    };
    return () => {
      controllerRef.current = null;
    };
  }, [controllerRef, camera, fitCamera, focusContainer, w, d, invalidate]);

  return (
    <OrbitControls
      ref={controls}
      makeDefault
      enabled={enabled}
      enableDamping
      dampingFactor={0.08}
      minDistance={0.65}
      maxDistance={Math.max(12, w * 2.4, d * 2.4)}
      maxPolarAngle={Math.PI / 2 - 0.04}
      onChange={() => invalidate()}
    />
  );
}

function SceneContents({
  room,
  containers,
  selectedId,
  focusContainerId,
  editMode,
  onSelect,
  onMove,
  onCommit,
  controllerRef,
  mobile,
}: {
  room: RoomSummary;
  containers: Container[];
  selectedId: string | null;
  focusContainerId?: string | null;
  editMode: boolean;
  onSelect: (id: string) => void;
  onMove: (id: string, x_cm: number, z_cm: number) => void;
  onCommit: (id: string, x_cm: number, z_cm: number) => void;
  controllerRef?: MutableRefObject<RoomSceneHandle | null>;
  mobile: boolean;
}) {
  const { camera, raycaster, gl } = useThree();
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ id: string; startX: number; startZ: number; px: number; pz: number } | null>(null);
  const floorPlane = useMemo(() => new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), []);

  const floorPointAt = (clientX: number, clientY: number) => {
    const rect = gl.domElement.getBoundingClientRect();
    const pointer = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );
    raycaster.setFromCamera(pointer, camera);
    const point = new THREE.Vector3();
    raycaster.ray.intersectPlane(floorPlane, point);
    return point;
  };

  useEffect(() => {
    const move = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const point = floorPointAt(event.clientX, event.clientY);
      const dx = (point.x - drag.px) / M;
      const dz = (point.z - drag.pz) / M;
      const container = containers.find((c) => c.id === drag.id);
      if (!container) return;
      const next = snapContainerToWalls({
        x: drag.startX + dx,
        z: drag.startZ + dz,
        width: container.width_cm,
        depth: container.depth_cm,
        rot: container.rot_deg,
        roomWidth: room.width_cm,
        roomDepth: room.depth_cm,
        margin: 1,
      });
      onMove(drag.id, Math.round(next.x), Math.round(next.z));
    };
    const up = () => {
      const drag = dragRef.current;
      if (drag) {
        const container = containers.find((c) => c.id === drag.id);
        if (container) onCommit(drag.id, container.x_cm, container.z_cm);
      }
      dragRef.current = null;
      setDragging(false);
      document.body.style.cursor = "";
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, [containers, room, onMove, onCommit, camera, raycaster, gl, floorPlane]);

  useEffect(() => {
    (window as any).__WUWEI__ = {
      roomId: room.id,
      containers: containers.map((c) => ({ id: c.id, name: c.name, preset: c.preset, rot: c.rot_deg, x: c.x_cm, z: c.z_cm, width_cm: c.width_cm, depth_cm: c.depth_cm, height_cm: c.height_cm })),
      cameraDistance: () => camera.position.length(),
      project: (id: string) => {
        const container = containers.find((c) => c.id === id);
        if (!container) return null;
        const vector = new THREE.Vector3(
          (container.x_cm - room.width_cm / 2) * M,
          container.y_cm * M + container.height_cm * M * 0.5,
          (container.z_cm - room.depth_cm / 2) * M
        ).project(camera);
        return {
          x: (vector.x * 0.5 + 0.5) * window.innerWidth,
          y: (-vector.y * 0.5 + 0.5) * window.innerHeight,
        };
      },
    };
  }, [room, containers, camera]);

  const handleDragStart = (id: string, event: ThreeEvent<PointerEvent>) => {
    const container = containers.find((c) => c.id === id);
    if (!container) return;
    const point = floorPointAt(event.nativeEvent.clientX, event.nativeEvent.clientY);
    dragRef.current = { id, startX: container.x_cm, startZ: container.z_cm, px: point.x, pz: point.z };
    onSelect(id);
    setDragging(true);
  };

  return (
    <>
      <PerspectiveCamera makeDefault fov={mobile ? 56 : 38} position={[4, 3, 5]} near={0.1} far={60} />
      <CameraRig room={room} containers={containers} focusContainerId={focusContainerId} enabled={!dragging} controllerRef={controllerRef} />
      <hemisphereLight args={["#fff7ea", "#7d6a55", 0.95]} />
      <ambientLight intensity={0.45} />
      <directionalLight
        position={[4.5, 7.2, 5.4]}
        intensity={1.9}
        castShadow={!mobile}
        shadow-mapSize-width={1024}
        shadow-mapSize-height={1024}
        shadow-camera-left={-8}
        shadow-camera-right={8}
        shadow-camera-top={8}
        shadow-camera-bottom={-8}
        shadow-bias={-0.0004}
      />
      <directionalLight position={[-5, 3, -3]} intensity={0.35} color="#cfe0ef" />
      <RoomShell room={room} />
      {containers.map((container) => (
        <ContainerMesh
          key={container.id}
          container={container}
          room={room}
          selected={container.id === selectedId}
          editMode={editMode}
          onSelect={onSelect}
          onDragStart={handleDragStart}
        />
      ))}
      {!mobile && <ContactShadows position={[0, 0.01, 0]} opacity={0.22} scale={Math.max(8, room.width_cm * M * 2)} blur={2.6} far={4} resolution={256} />}
    </>
  );
}

export function RoomScene(props: {
  room: RoomSummary;
  containers: Container[];
  selectedId: string | null;
  focusContainerId?: string | null;
  editMode: boolean;
  onSelect: (id: string) => void;
  onMove: (id: string, x_cm: number, z_cm: number) => void;
  onCommit: (id: string, x_cm: number, z_cm: number) => void;
  controllerRef?: MutableRefObject<RoomSceneHandle | null>;
}) {
  const mobile = useIsMobile();
  return (
    <Canvas frameloop="demand" shadows={!mobile} dpr={[1, mobile ? 1.25 : 1.75]} gl={{ antialias: !mobile, alpha: true }}>
      <SceneContents {...props} mobile={mobile} />
    </Canvas>
  );
}






