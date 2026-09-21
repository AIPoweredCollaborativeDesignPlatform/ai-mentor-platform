<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import * as THREE from 'three';
import {
  Box,
  RotateCw,
  Eye,
  Tag,
  ZoomIn,
  ZoomOut,
  Focus,
  Play,
  Pause,
  FastForward,
  Activity,
  RotateCcw
} from 'lucide-vue-next';
import type { ComponentAnimation } from '../types';

const props = defineProps<{
  assetData: any;
}>();

const containerRef = ref<HTMLDivElement | null>(null);
const isWireframe = ref(false);
const autoRotate = ref(false); // default to false if model has its own animation
const isPlaying = ref(true);
const playbackSpeed = ref(1.0);

interface AnimatedMeshEntry {
  mesh: THREE.Mesh;
  basePosition: THREE.Vector3;
  baseRotation: THREE.Euler;
  baseScale: THREE.Vector3;
  animation: ComponentAnimation;
}

const animatedMeshes = ref<AnimatedMeshEntry[]>([]);
const hasAnimations = computed(() => animatedMeshes.value.length > 0);

let scene: THREE.Scene;
let camera: THREE.PerspectiveCamera;
let renderer: THREE.WebGLRenderer;
let objectGroup: THREE.Group;
let animationFrameId: number;
let clock: THREE.Clock;
let elapsedAnimationTime = 0;

let isDragging = false;
let previousMousePosition = { x: 0, y: 0 };
let initialPinchDistance = 0;

const cycleSpeed = () => {
  if (playbackSpeed.value === 1.0) playbackSpeed.value = 1.5;
  else if (playbackSpeed.value === 1.5) playbackSpeed.value = 2.0;
  else if (playbackSpeed.value === 2.0) playbackSpeed.value = 0.5;
  else playbackSpeed.value = 1.0;
};

const resetAnimation = () => {
  elapsedAnimationTime = 0;
  animatedMeshes.value.forEach(entry => {
    entry.mesh.position.copy(entry.basePosition);
    entry.mesh.rotation.copy(entry.baseRotation);
    entry.mesh.scale.copy(entry.baseScale);
  });
};

const initThree = () => {
  if (!containerRef.value) return;

  const width = containerRef.value.clientWidth;
  const height = containerRef.value.clientHeight || (window.innerWidth < 640 ? 256 : 320);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0f172a); // slate-900

  camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 1000);
  camera.position.set(3, 3, 4);
  camera.lookAt(0, 0.8, 0);

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setSize(width, height);
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.shadowMap.enabled = true;

  containerRef.value.replaceChildren(renderer.domElement);

  // Lights
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.8);
  scene.add(ambientLight);

  const dirLight = new THREE.DirectionalLight(0x38bdf8, 1.5);
  dirLight.position.set(5, 10, 7);
  scene.add(dirLight);

  const gridHelper = new THREE.GridHelper(6, 12, 0x38bdf8, 0x334155);
  gridHelper.position.y = 0;
  scene.add(gridHelper);

  objectGroup = new THREE.Group();
  scene.add(objectGroup);

  buildParametricMesh();

  // Mouse drag handlers
  const canvas = renderer.domElement;
  canvas.addEventListener('mousedown', (e) => {
    e.preventDefault(); // Prevents text selection cursor when dragging
    isDragging = true;
    previousMousePosition = { x: e.clientX, y: e.clientY };
  });

  const applyRotationLocal = (deltaX: number, deltaY: number) => {
    if (!objectGroup || !camera) return;
    // Rotate around world Y-axis (screen horizontal drag)
    const rotY = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), deltaX * 0.008);
    // Rotate around camera view horizontal axis (screen vertical drag)
    const cameraRight = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion).normalize();
    const rotX = new THREE.Quaternion().setFromAxisAngle(cameraRight, deltaY * 0.008);

    objectGroup.quaternion.premultiply(rotY);
    objectGroup.quaternion.premultiply(rotX);
  };
  
  // Expose applyRotation globally for the handler
  (window as any).applyRotation = applyRotationLocal;

  let initialPinchDistance = 0;

  // Touch drag & pinch zoom handlers for mobile devices (Canvas specific)
  canvas.addEventListener('touchstart', (e) => {
    if (e.touches.length === 1) {
      isDragging = true;
      previousMousePosition = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    } else if (e.touches.length === 2) {
      isDragging = false;
      initialPinchDistance = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
    }
  }, { passive: true });

  canvas.addEventListener('touchend', (e) => {
    if (e.touches.length === 0) {
      isDragging = false;
      initialPinchDistance = 0;
    } else if (e.touches.length === 1) {
      isDragging = true;
      previousMousePosition = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      initialPinchDistance = 0;
    }
  });

  canvas.addEventListener('touchmove', (e) => {
    if (e.touches.length === 1 && isDragging) {
      const deltaX = e.touches[0].clientX - previousMousePosition.x;
      const deltaY = e.touches[0].clientY - previousMousePosition.y;

      applyRotationLocal(deltaX, deltaY);

      previousMousePosition = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    } else if (e.touches.length === 2 && initialPinchDistance > 0 && camera) {
      const currentDist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      if (currentDist > 10) {
        const factor = initialPinchDistance / currentDist;
        const clampedFactor = THREE.MathUtils.clamp(factor, 0.90, 1.10);
        camera.position.multiplyScalar(clampedFactor);
        initialPinchDistance = currentDist;
      }
    }
  }, { passive: true });

  // Mouse wheel zoom (Only with Shift key to avoid hijacking page scroll)
  canvas.addEventListener('wheel', (e) => {
    if (e.shiftKey) {
      e.preventDefault();
      const factor = e.deltaY > 0 ? 1.12 : 0.88;
      camera.position.multiplyScalar(factor);
    }
  }, { passive: false });

  clock = new THREE.Clock();

  const animate = () => {
    animationFrameId = requestAnimationFrame(animate);

    if (clock) {
      const delta = clock.getDelta();
      if (isPlaying.value) {
        elapsedAnimationTime += delta * playbackSpeed.value;
      }
    }

    if (autoRotate.value && !isDragging && objectGroup) {
      const rotY = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.005);
      objectGroup.quaternion.premultiply(rotY);
    }

    // Evaluate physics & animations for each animated mesh
    if (animatedMeshes.value.length > 0) {
      const t = elapsedAnimationTime;
      for (let i = 0; i < animatedMeshes.value.length; i++) {
        const entry = animatedMeshes.value[i];
        const { mesh, basePosition, baseRotation, baseScale, animation } = entry;
        const f = animation.frequency ?? 1.0;
        const A = animation.amplitude ?? 0.5;
        const phi = animation.phase ?? 0;
        const axis = animation.axis || 'y';

        // 1. Simple Harmonic Motion (SHM - 簡諧運動)
        if (animation.type === 'harmonic') {
          const offset = A * Math.sin(2 * Math.PI * f * t + phi);
          if (axis === 'x') mesh.position.x = basePosition.x + offset;
          else if (axis === 'y') mesh.position.y = basePosition.y + offset;
          else if (axis === 'z') mesh.position.z = basePosition.z + offset;
          else {
            mesh.position.x = basePosition.x + offset;
            mesh.position.y = basePosition.y + offset;
            mesh.position.z = basePosition.z + offset;
          }
        }
        // 2. Gravitational Acceleration & Bounce (等加速度拋物線彈跳)
        else if (animation.type === 'bounce') {
          const cycle = ((t * f + phi / (2 * Math.PI)) % 1 + 1) % 1;
          const bounceHeight = 4 * A * cycle * (1 - cycle);
          if (axis === 'x') mesh.position.x = basePosition.x + bounceHeight;
          else if (axis === 'z') mesh.position.z = basePosition.z + bounceHeight;
          else mesh.position.y = basePosition.y + bounceHeight;
        }
        // 3. Angular Simple Harmonic Pendulum (單擺角位移)
        else if (animation.type === 'pendulum') {
          const angle = A * Math.cos(2 * Math.PI * f * t + phi);
          if (axis === 'x') mesh.rotation.x = baseRotation.x + angle;
          else if (axis === 'y') mesh.rotation.y = baseRotation.y + angle;
          else mesh.rotation.z = baseRotation.z + angle;
        }
        // 4. Continuous Spin (自轉 / 角加速度自轉)
        else if (animation.type === 'spin') {
          const rot = (2 * Math.PI * f) * t + phi;
          if (axis === 'x') mesh.rotation.x = baseRotation.x + rot;
          else if (axis === 'z') mesh.rotation.z = baseRotation.z + rot;
          else mesh.rotation.y = baseRotation.y + rot;
        }
        // 5. Breathing Pulse (呼吸縮放)
        else if (animation.type === 'pulse') {
          const s = Math.max(0.1, 1 + A * Math.sin(2 * Math.PI * f * t + phi));
          mesh.scale.set(baseScale.x * s, baseScale.y * s, baseScale.z * s);
        }
        // 6. Wave Ripple (波浪傳遞)
        else if (animation.type === 'wave') {
          const waveOffset = A * Math.sin(2 * Math.PI * f * t + phi + (basePosition.x * 2 + basePosition.z * 2));
          mesh.position.y = basePosition.y + waveOffset;
        }
      }
    }

    renderer.render(scene, camera);
  };
  animate();
};

const fitCameraToObject = () => {
  if (!objectGroup || objectGroup.children.length === 0 || !camera) return;
  const box = new THREE.Box3().setFromObject(objectGroup);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());

  const maxDim = Math.max(size.x, size.y, size.z, 0.5);
  const fov = camera.fov * (Math.PI / 180);
  let cameraDist = Math.abs(maxDim / 2 / Math.tan(fov / 2)) * 1.6;

  camera.position.set(cameraDist * 0.7, cameraDist * 0.6, cameraDist * 0.9);
  camera.near = cameraDist / 100;
  camera.far = cameraDist * 100;
  camera.updateProjectionMatrix();
  camera.lookAt(0, 0, 0);
};

const zoomIn = () => {
  if (!camera) return;
  camera.position.multiplyScalar(0.85);
};

const zoomOut = () => {
  if (!camera) return;
  camera.position.multiplyScalar(1.18);
};

const buildParametricMesh = () => {
  if (!objectGroup) return;
  // Clear previous
  animatedMeshes.value = [];
  elapsedAnimationTime = 0;

  while (objectGroup.children.length > 0) {
    const obj = objectGroup.children[0] as THREE.Mesh;
    obj.geometry?.dispose();
    if (Array.isArray(obj.material)) {
      obj.material.forEach(m => m.dispose());
    } else {
      obj.material?.dispose();
    }
    objectGroup.remove(obj);
  }

  objectGroup.position.set(0, 0, 0);
  objectGroup.rotation.set(0, 0, 0);

  const components = props.assetData?.components || [];
  const pendingAnimatedList: { mesh: THREE.Mesh; animation: ComponentAnimation }[] = [];

  components.forEach((comp: any) => {
    let geom: THREE.BufferGeometry;
    const shape = comp.shape;
    const dim = comp.dimensions || {};

    if (shape === 'box') {
      geom = new THREE.BoxGeometry(dim.width || 1, dim.height || 1, dim.depth || 1);
    } else if (shape === 'cylinder') {
      geom = new THREE.CylinderGeometry(
        dim.radiusTop || dim.radius || 0.5,
        dim.radiusBottom || dim.radius || 0.5,
        dim.height || 1,
        dim.radialSegments || 32
      );
    } else if (shape === 'torus') {
      geom = new THREE.TorusGeometry(
        dim.radius || 1,
        dim.tube || 0.3,
        dim.radialSegments || 16,
        dim.tubularSegments || 32
      );
    } else {
      geom = new THREE.SphereGeometry(dim.radius || 0.8, 32, 16);
    }

    const mat = new THREE.MeshStandardMaterial({
      color: comp.material?.color || '#38bdf8',
      roughness: comp.material?.roughness ?? 0.5,
      metalness: comp.material?.metalness ?? 0.2,
      wireframe: isWireframe.value
    });

    const mesh = new THREE.Mesh(geom, mat);
    if (comp.position) {
      mesh.position.set(comp.position.x || 0, comp.position.y || 0, comp.position.z || 0);
    }
    objectGroup.add(mesh);

    if (comp.animation && comp.animation.type) {
      pendingAnimatedList.push({ mesh, animation: comp.animation });
    }
  });

  // Calculate intrinsic bounds and center children precisely around (0, 0, 0)
  objectGroup.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(objectGroup);
  if (!box.isEmpty()) {
    const center = box.getCenter(new THREE.Vector3());
    objectGroup.children.forEach((child) => {
      child.position.sub(center);
    });
  }

  // After centering, capture stable base transforms
  animatedMeshes.value = pendingAnimatedList.map(({ mesh, animation }) => ({
    mesh,
    basePosition: mesh.position.clone(),
    baseRotation: mesh.rotation.clone(),
    baseScale: mesh.scale.clone(),
    animation
  }));

  if (animatedMeshes.value.length > 0) {
    autoRotate.value = false;
  }

  fitCameraToObject();
};

const toggleWireframe = () => {
  isWireframe.value = !isWireframe.value;
  if (objectGroup) {
    objectGroup.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        const mesh = child as THREE.Mesh;
        if (Array.isArray(mesh.material)) {
          mesh.material.forEach((m: any) => {
            if (m && 'wireframe' in m) m.wireframe = isWireframe.value;
          });
        } else if (mesh.material && 'wireframe' in mesh.material) {
          (mesh.material as any).wireframe = isWireframe.value;
        }
      }
    });
  }
};

const resetView = () => {
  if (objectGroup) {
    objectGroup.quaternion.identity();
  }
  fitCameraToObject();
};

watch(() => props.assetData, () => {
  buildParametricMesh();
}, { deep: true });

const handleMouseUp = () => { isDragging = false; };
const handleMouseMove = (e: MouseEvent) => {
  if (!isDragging) return;
  const deltaX = e.clientX - previousMousePosition.x;
  const deltaY = e.clientY - previousMousePosition.y;
  if ((window as any).applyRotation) (window as any).applyRotation(deltaX, deltaY);
  previousMousePosition = { x: e.clientX, y: e.clientY };
};
const handleTouchEnd = (e: TouchEvent) => {
  if (e.touches.length === 0) {
    isDragging = false;
    initialPinchDistance = 0;
  } else if (e.touches.length === 1) {
    isDragging = true;
    previousMousePosition = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    initialPinchDistance = 0;
  }
};
const handleTouchMove = (e: TouchEvent) => {
  if (e.touches.length === 1 && isDragging) {
    const deltaX = e.touches[0].clientX - previousMousePosition.x;
    const deltaY = e.touches[0].clientY - previousMousePosition.y;
    if ((window as any).applyRotation) (window as any).applyRotation(deltaX, deltaY);
    previousMousePosition = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  }
};

onMounted(() => {
  initThree();
  window.addEventListener('mouseup', handleMouseUp);
  window.addEventListener('mousemove', handleMouseMove);
  window.addEventListener('touchend', handleTouchEnd);
  window.addEventListener('touchmove', handleTouchMove, { passive: true });
});

onUnmounted(() => {
  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId);
  }
  window.removeEventListener('mouseup', handleMouseUp);
  window.removeEventListener('mousemove', handleMouseMove);
  window.removeEventListener('touchend', handleTouchEnd);
  window.removeEventListener('touchmove', handleTouchMove);
  
  if (renderer) {
    renderer.dispose();
  }
  if (scene) {
    scene.clear();
  }
});
</script>

<template>
  <div class="mt-3 bg-slate-950/80 border border-slate-700/80 rounded-2xl p-4 shadow-xl">
    <div class="flex items-center justify-between mb-2 flex-wrap gap-2">
      <div class="flex items-center gap-2">
        <Box class="w-5 h-5 text-sky-400" />
        <h4 class="font-semibold text-slate-100 text-sm tracking-wide">
          {{ assetData?.title || 'Parametric 3D Prototype' }}
        </h4>
        <span class="text-[10px] bg-sky-500/20 text-sky-300 font-mono px-2 py-0.5 rounded-full border border-sky-500/30">
          Three.js
        </span>
        <span
          v-if="hasAnimations"
          class="inline-flex items-center gap-1 text-[10px] bg-emerald-500/20 text-emerald-300 font-medium px-2 py-0.5 rounded-full border border-emerald-500/30 animate-pulse"
        >
          <Activity class="w-3 h-3 text-emerald-400" />
          動態物理模擬
        </span>
      </div>

      <div class="flex items-center gap-1.5 text-xs flex-wrap">
        <!-- Animation Play / Pause / Speed -->
        <template v-if="hasAnimations">
          <button
            @click="isPlaying = !isPlaying"
            class="flex items-center gap-1 px-2.5 py-1 rounded-lg border border-slate-700 bg-slate-900 hover:bg-slate-800 text-slate-200 transition cursor-pointer"
            :title="isPlaying ? 'Pause Motion' : 'Play Motion'"
          >
            <Pause v-if="isPlaying" class="w-3.5 h-3.5 text-amber-400" />
            <Play v-else class="w-3.5 h-3.5 text-emerald-400 fill-emerald-400" />
            <span>{{ isPlaying ? '暫停' : '播放' }}</span>
          </button>
          
          <button
            @click="cycleSpeed"
            class="flex items-center gap-1 px-2 py-1 rounded-lg border border-slate-700 bg-slate-900 hover:bg-slate-800 text-slate-300 font-mono text-[11px] transition cursor-pointer"
            title="調整動畫播放速度"
          >
            <FastForward class="w-3 h-3 text-sky-400" />
            <span>{{ playbackSpeed }}x</span>
          </button>

          <button
            @click="resetAnimation"
            class="p-1 rounded-lg border border-slate-700 bg-slate-900 hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition cursor-pointer"
            title="重設運動至起始位置"
          >
            <RotateCcw class="w-3.5 h-3.5" />
          </button>
          <div class="w-px h-3.5 bg-slate-700 mx-0.5"></div>
        </template>

        <button
          @click="toggleWireframe"
          class="flex items-center justify-center gap-1 w-[82px] py-1 rounded-lg border border-slate-700 hover:bg-slate-800 text-slate-300 transition cursor-pointer"
          :class="{ 'bg-sky-950 border-sky-500 text-sky-300': isWireframe }"
        >
          <Eye class="w-3.5 h-3.5 shrink-0" />
          <span>{{ isWireframe ? 'Solid' : 'Wireframe' }}</span>
        </button>
        <button
          @click="autoRotate = !autoRotate"
          class="flex items-center gap-1 px-2.5 py-1 rounded-lg border border-slate-700 hover:bg-slate-800 text-slate-300 transition cursor-pointer"
          :class="{ 'bg-sky-950 border-sky-500 text-sky-300': autoRotate }"
        >
          <RotateCw class="w-3.5 h-3.5" />
          自轉
        </button>
        <button
          @click="resetView"
          class="px-2.5 py-1 rounded-lg border border-slate-700 hover:bg-slate-800 text-slate-300 transition cursor-pointer"
        >
          重設視角
        </button>
      </div>
    </div>

    <!-- Interactive Canvas -->
    <div class="relative w-full h-64 sm:h-80 rounded-xl overflow-hidden bg-slate-900 touch-none">
      <div
        ref="containerRef"
        class="w-full h-full cursor-grab active:cursor-grabbing"
      ></div>

      <!-- Subtle Hint Badge -->
      <div class="absolute bottom-3 left-3 px-2 py-1 rounded-lg bg-slate-950/80 border border-slate-800 text-[10px] text-slate-400 select-none pointer-events-none">
        <span class="hidden sm:inline">Shift + 滾輪縮放 · </span>單指旋轉 · 雙指縮放
      </div>

      <!-- Floating Zoom Controls -->
      <div class="absolute bottom-3 right-3 flex flex-col gap-1.5 z-10">
        <button
          @click="zoomIn"
          class="p-1.5 rounded-lg bg-slate-900/80 hover:bg-slate-800 border border-slate-700 text-slate-200 shadow transition cursor-pointer"
          title="Zoom In (+)"
        >
          <ZoomIn class="w-4 h-4" />
        </button>
        <button
          @click="zoomOut"
          class="p-1.5 rounded-lg bg-slate-900/80 hover:bg-slate-800 border border-slate-700 text-slate-200 shadow transition cursor-pointer"
          title="Zoom Out (-)"
        >
          <ZoomOut class="w-4 h-4" />
        </button>
        <button
          @click="fitCameraToObject"
          class="p-1.5 rounded-lg bg-slate-900/80 hover:bg-slate-800 border border-slate-700 text-slate-200 shadow transition cursor-pointer"
          title="置中與適配視角 (Center & Fit)"
        >
          <Focus class="w-4 h-4" />
        </button>
      </div>
    </div>

    <!-- Annotations / Dimensions -->
    <div v-if="assetData?.annotations?.length" class="mt-3 flex flex-wrap gap-2">
      <div
        v-for="(ann, i) in assetData.annotations"
        :key="i"
        class="flex items-center gap-1 text-xs bg-slate-800/80 border border-slate-700 text-slate-300 px-2.5 py-1 rounded-md"
      >
        <Tag class="w-3 h-3 text-sky-400" />
        <span>{{ ann.label }}</span>
      </div>
    </div>
  </div>
</template>
