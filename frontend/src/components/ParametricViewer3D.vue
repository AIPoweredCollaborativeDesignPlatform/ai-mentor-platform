<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue';
import * as THREE from 'three';
import { Box, RotateCw, Eye, Tag } from 'lucide-vue-next';

const props = defineProps<{
  assetData: any;
}>();

const containerRef = ref<HTMLDivElement | null>(null);
const isWireframe = ref(false);
const autoRotate = ref(true);

let scene: THREE.Scene;
let camera: THREE.PerspectiveCamera;
let renderer: THREE.WebGLRenderer;
let objectGroup: THREE.Group;
let animationFrameId: number;

let isDragging = false;
let previousMousePosition = { x: 0, y: 0 };

const initThree = () => {
  if (!containerRef.value) return;

  const width = containerRef.value.clientWidth;
  const height = 320;

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
    isDragging = true;
    previousMousePosition = { x: e.clientX, y: e.clientY };
  });

  window.addEventListener('mouseup', () => {
    isDragging = false;
  });

  window.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const deltaX = e.clientX - previousMousePosition.x;
    const deltaY = e.clientY - previousMousePosition.y;

    objectGroup.rotation.y += deltaX * 0.01;
    objectGroup.rotation.x += deltaY * 0.01;

    previousMousePosition = { x: e.clientX, y: e.clientY };
  });

  const animate = () => {
    animationFrameId = requestAnimationFrame(animate);
    if (autoRotate.value && !isDragging) {
      objectGroup.rotation.y += 0.005;
    }
    renderer.render(scene, camera);
  };
  animate();
};

const buildParametricMesh = () => {
  if (!objectGroup) return;
  // Clear previous
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

  const components = props.assetData?.components || [];
  components.forEach((comp: any) => {
    let geom: THREE.BufferGeometry;
    const shape = comp.shape;
    const dim = comp.dimensions || {};

    if (shape === 'box') {
      geom = new THREE.BoxGeometry(dim.width || 1, dim.height || 1, dim.depth || 1);
    } else if (shape === 'cylinder') {
      geom = new THREE.CylinderGeometry(
        dim.radiusTop || 0.5,
        dim.radiusBottom || 0.5,
        dim.height || 1,
        32
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
  });
};

const toggleWireframe = () => {
  isWireframe.value = !isWireframe.value;
  buildParametricMesh();
};

const resetView = () => {
  if (objectGroup) {
    objectGroup.rotation.set(0, 0, 0);
  }
};

watch(() => props.assetData, () => {
  buildParametricMesh();
}, { deep: true });

onMounted(() => {
  initThree();
});

onUnmounted(() => {
  if (animationFrameId) cancelAnimationFrame(animationFrameId);
  renderer?.dispose();
});
</script>

<template>
  <div class="mt-3 bg-slate-950/80 border border-slate-700/80 rounded-2xl p-4 shadow-xl">
    <div class="flex items-center justify-between mb-2">
      <div class="flex items-center gap-2">
        <Box class="w-5 h-5 text-sky-400" />
        <h4 class="font-semibold text-slate-100 text-sm tracking-wide">
          {{ assetData?.title || 'Code-to-3D 參數化原型' }}
        </h4>
        <span class="text-[10px] bg-sky-500/20 text-sky-300 font-mono px-2 py-0.5 rounded-full border border-sky-500/30">
          即時 Three.js
        </span>
      </div>

      <div class="flex items-center gap-2 text-xs">
        <button
          @click="toggleWireframe"
          class="flex items-center gap-1 px-2.5 py-1 rounded-lg border border-slate-700 hover:bg-slate-800 text-slate-300 transition"
          :class="{ 'bg-sky-950 border-sky-500 text-sky-300': isWireframe }"
        >
          <Eye class="w-3.5 h-3.5" />
          {{ isWireframe ? '實體' : '線框' }}
        </button>
        <button
          @click="autoRotate = !autoRotate"
          class="flex items-center gap-1 px-2.5 py-1 rounded-lg border border-slate-700 hover:bg-slate-800 text-slate-300 transition"
          :class="{ 'bg-sky-950 border-sky-500 text-sky-300': autoRotate }"
        >
          <RotateCw class="w-3.5 h-3.5" />
          自轉
        </button>
        <button
          @click="resetView"
          class="px-2.5 py-1 rounded-lg border border-slate-700 hover:bg-slate-800 text-slate-300 transition"
        >
          重設
        </button>
      </div>
    </div>

    <!-- Interactive Canvas -->
    <div
      ref="containerRef"
      class="w-full h-80 rounded-xl overflow-hidden cursor-grab active:cursor-grabbing relative bg-slate-900"
    ></div>

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
