<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  Layers,
  Sparkles,
  Download,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  Palette,
  Loader2,
  RefreshCw,
  Eye
} from 'lucide-vue-next';
import type { MessageItem } from '../types';
import { useRoomStore } from '../stores/room';

const props = defineProps<{
  assetData: any;
  message?: MessageItem;
}>();

const emit = defineEmits<{
  (e: 'refine', message: MessageItem, customPrompt?: string): void;
}>();

const roomStore = useRoomStore();
const canvasContainerRef = ref<HTMLDivElement | null>(null);
const isLoading = ref(true);
const isModelInteractive = ref(false);
const isRehosting = ref(false);
const rehostError = ref('');
const loadError = ref('');
const showShiftPrompt = ref(false);
let shiftPromptTimeout: any = null;

// Three.js instances
let scene: THREE.Scene | null = null;
let camera: THREE.PerspectiveCamera | null = null;
let renderer: THREE.WebGLRenderer | null = null;
let controls: OrbitControls | null = null;
let modelGroup: THREE.Group | null = null;
let animationFrameId: number | null = null;
let resizeObserver: ResizeObserver | null = null;

const recommendedFilename = computed(() => {
  let baseName = (props.assetData?.title || 'AI_3D_Model')
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^\w\u4e00-\u9fa5-_]/g, '');
  if (!baseName) baseName = 'AI_3D_Model';
  return `${baseName}.glb`;
});

// Setup Three.js Scene
const initThreeScene = () => {
  if (!canvasContainerRef.value) return;

  const container = canvasContainerRef.value;
  const width = container.clientWidth || 400;
  const height = container.clientHeight || 320;

  // Scene
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b1120); // Dark sleek background

  // Camera
  camera = new THREE.PerspectiveCamera(45, width / height, 0.05, 500);
  camera.position.set(0, 0, 3.6);

  // Renderer
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setSize(width, height);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.2;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  container.replaceChildren(renderer.domElement);

  // OrbitControls with full 360° global rotation
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enableZoom = false; // We handle zoom manually with Shift key
  controls.enablePan = true;
  controls.screenSpacePanning = true;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 1.5;
  controls.minDistance = 0.4;
  controls.maxDistance = 15;
  controls.minPolarAngle = 0; // Full 360° global vertical rotation
  controls.maxPolarAngle = Math.PI;
  controls.target.set(0, 0, 0);

  // Rich Lighting Setup
  const ambientLight = new THREE.AmbientLight(0xffffff, 1.2);
  scene.add(ambientLight);

  const keyLight = new THREE.DirectionalLight(0xffffff, 2.0);
  keyLight.position.set(5, 8, 5);
  scene.add(keyLight);

  const fillLight = new THREE.DirectionalLight(0x818cf8, 1.0);
  fillLight.position.set(-5, -2, -5);
  scene.add(fillLight);

  const topLight = new THREE.DirectionalLight(0x38bdf8, 1.2);
  topLight.position.set(0, 10, 0);
  scene.add(topLight);

  // Model Group Holder
  modelGroup = new THREE.Group();
  scene.add(modelGroup);

  // Render Loop
  const animate = () => {
    animationFrameId = requestAnimationFrame(animate);
    if (controls) controls.update();
    if (renderer && scene && camera) {
      renderer.render(scene, camera);
    }
  };
  animate();

  // Resize Observer
  resizeObserver = new ResizeObserver(() => {
    if (!container || !camera || !renderer) return;
    const newWidth = container.clientWidth;
    const newHeight = container.clientHeight;
    if (newWidth > 0 && newHeight > 0) {
      camera.aspect = newWidth / newHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(newWidth, newHeight);
    }
  });
  resizeObserver.observe(container);
};

// Load GLB Model into Three.js Scene
const loadGlbModel = (rawUrl: string) => {
  if (!rawUrl) return;
  isLoading.value = true;
  loadError.value = '';

  const proxyUrl = `/api/proxy?url=${encodeURIComponent(rawUrl)}`;
  const loader = new GLTFLoader();

  loader.load(
    proxyUrl,
    (gltf) => {
      if (!modelGroup || !scene) return;

      // Clear previous models
      while (modelGroup.children.length > 0) {
        modelGroup.remove(modelGroup.children[0]);
      }

      const root = gltf.scene;

      // Enable shadows and proper materials
      root.traverse((child: any) => {
        if (child.isMesh) {
          child.castShadow = true;
          child.receiveShadow = true;
          if (child.material) {
            child.material.side = THREE.DoubleSide; // Render both sides cleanly
          }
        }
      });

      // Calculate EXACT Bounding Box and Center
      const box = new THREE.Box3().setFromObject(root);
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());

      // Center geometry so (0,0,0) is true geometric centroid
      root.position.x = -center.x;
      root.position.y = -center.y;
      root.position.z = -center.z;

      modelGroup.add(root);

      // Auto-scale model so it fits the viewport perfectly
      const maxDim = Math.max(size.x, size.y, size.z);
      if (maxDim > 0) {
        const targetScale = 2.0 / maxDim;
        modelGroup.scale.set(targetScale, targetScale, targetScale);
      } else {
        modelGroup.scale.set(1, 1, 1);
      }

      // Reset camera view
      if (camera && controls) {
        camera.position.set(0, 0.4, 3.4);
        controls.target.set(0, 0, 0);
        controls.update();
      }

      isLoading.value = false;
      isModelInteractive.value = true;
    },
    undefined,
    (err) => {
      console.warn('[ModelViewer] Three.js GLTFLoader failed:', err);
      isLoading.value = false;
      isModelInteractive.value = false;
      loadError.value = 'Direct 3D load failed. Displaying 2D render preview.';
    }
  );
};

// Handle Mouse Wheel for Shift + Zoom
const handleWheel = (e: WheelEvent) => {
  if (!isModelInteractive.value || !camera || !controls) return;

  if (!e.shiftKey) {
    e.preventDefault();
    e.stopPropagation();

    showShiftPrompt.value = true;
    if (shiftPromptTimeout) clearTimeout(shiftPromptTimeout);
    shiftPromptTimeout = setTimeout(() => {
      showShiftPrompt.value = false;
    }, 1500);
    return;
  }

  // Shift is pressed -> Zoom in / out smoothly
  e.preventDefault();
  const zoomFactor = e.deltaY < 0 ? 0.9 : 1.1;
  camera.position.multiplyScalar(zoomFactor);
  // Restrict zoom limits
  const dist = camera.position.length();
  if (dist < 0.5) camera.position.setLength(0.5);
  if (dist > 12) camera.position.setLength(12);
  controls.update();
};

// Zoom Controls (+ / -)
const zoomIn = () => {
  if (!camera || !controls) return;
  camera.position.multiplyScalar(0.75); // 25% zoom in
  if (camera.position.length() < 0.5) camera.position.setLength(0.5);
  controls.update();
};

const zoomOut = () => {
  if (!camera || !controls) return;
  camera.position.multiplyScalar(1.35); // 35% zoom out
  if (camera.position.length() > 12) camera.position.setLength(12);
  controls.update();
};

// Reset Camera Angle
const resetView = () => {
  if (!camera || !controls || !modelGroup) return;
  camera.position.set(0, 0.4, 3.4);
  controls.target.set(0, 0, 0);
  controls.update();
};

// Download GLB model file with proper filename via Proxy Content-Disposition
const downloadModel = async () => {
  const url = props.assetData?.modelUrl;
  if (!url) return;

  const filename = recommendedFilename.value;
  const downloadUrl = `/api/proxy?url=${encodeURIComponent(url)}&filename=${encodeURIComponent(filename)}`;

  const a = document.createElement('a');
  a.href = downloadUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  roomStore.pushToast(
    'Download Started',
    `Downloading model as ${filename}`,
    'success'
  );
};

const isRefineModalOpen = ref(false);
const customRefinePrompt = ref('');

// On-demand re-host for old messages that still have Meshy/Tripo URLs
const reHostModel = async () => {
  const url = props.assetData?.originalModelUrl || props.assetData?.modelUrl;
  const taskId = props.assetData?.taskId;
  if (!url || !taskId) return;

  isRehosting.value = true;
  rehostError.value = '';

  try {
    const { reHostGlbToFirebaseStorage } = await import('../services/glbProxy');
    const proxyRes = await reHostGlbToFirebaseStorage(url, taskId, (status) => {
      rehostError.value = status;
    });
    if (proxyRes.success && proxyRes.firebaseUrl) {
      roomStore.pushToast('Interactive 3D Enabled', 'Model ready for 360° global rotation and zoom.', 'success');
      loadGlbModel(proxyRes.firebaseUrl);
    } else {
      rehostError.value = proxyRes.error || 'Failed to load, check if model link is still valid.';
    }
  } catch (e: any) {
    rehostError.value = e?.message || 'Error occurred during 3D activation.';
  } finally {
    isRehosting.value = false;
  }
};

const openRefineModal = () => {
  customRefinePrompt.value = '';
  isRefineModalOpen.value = true;
};

const submitRefine = () => {
  if (props.message) {
    emit('refine', props.message, customRefinePrompt.value.trim());
  }
  isRefineModalOpen.value = false;
};

// Lifecycle Hooks
onMounted(() => {
  nextTick(() => {
    initThreeScene();
    if (props.assetData?.modelUrl) {
      loadGlbModel(props.assetData.modelUrl);
    }
  });
});

watch(
  () => props.assetData?.modelUrl,
  (newUrl) => {
    if (newUrl) {
      loadGlbModel(newUrl);
    }
  }
);

onUnmounted(() => {
  if (animationFrameId !== null) {
    cancelAnimationFrame(animationFrameId);
  }
  if (resizeObserver) {
    resizeObserver.disconnect();
  }
  if (renderer) {
    renderer.dispose();
  }
  if (controls) {
    controls.dispose();
  }
});
</script>

<template>
  <div class="mt-3 bg-slate-950/90 border border-indigo-500/30 rounded-2xl p-3 sm:p-4 shadow-2xl relative w-full">
    <!-- Header info -->
    <div class="flex items-center justify-between mb-2 gap-2">
      <div class="flex items-center gap-2 min-w-0">
        <Layers class="w-5 h-5 text-indigo-400 shrink-0" />
        <h4 class="font-semibold text-slate-100 text-sm tracking-wide truncate">
          {{ assetData?.title || '3D Neural Mesh' }}
        </h4>
        <span class="text-[9px] text-slate-500 font-mono border border-slate-700/50 rounded px-1.5 py-0.5 ml-1 shrink-0">v1.7.1</span>
        <span
          v-if="assetData?.isRefined"
          class="text-[10px] bg-emerald-500/20 text-emerald-300 font-mono px-2 py-0.5 rounded-full border border-emerald-500/30 flex items-center gap-1 shrink-0"
        >
          <Palette class="w-2.5 h-2.5" /> PBR Colored
        </span>
        <span
          v-else
          class="text-[10px] bg-indigo-500/20 text-indigo-300 font-mono px-2 py-0.5 rounded-full border border-indigo-500/30 flex items-center gap-1 shrink-0"
        >
          <Sparkles class="w-2.5 h-2.5" /> Meshy 3D Mesh
        </span>
      </div>
      <span class="text-xs text-slate-400 font-medium hidden sm:block shrink-0">
        {{ assetData?.provider || 'Meshy.ai Engine' }}
      </span>
    </div>

    <!-- 3D Canvas Container -->
    <div
      class="w-full rounded-xl overflow-hidden bg-slate-950 border border-slate-800 relative group select-none h-72 sm:h-96"
      style="width: 100%; display: block;"
      @wheel.capture="handleWheel"
    >
      <!-- Shift to Zoom Prompt Overlay -->
      <transition
        enter-active-class="transition duration-200 ease-out"
        enter-from-class="opacity-0 scale-95"
        enter-to-class="opacity-100 scale-100"
        leave-active-class="transition duration-300 ease-in"
        leave-from-class="opacity-100 scale-100"
        leave-to-class="opacity-0 scale-95"
      >
        <div
          v-if="showShiftPrompt"
          class="absolute inset-0 z-30 flex items-center justify-center pointer-events-none"
        >
          <div class="bg-slate-900/85 backdrop-blur-sm text-white px-4 py-2 rounded-full border border-slate-600/50 shadow-2xl flex items-center gap-2">
            <span class="text-xs font-semibold">Press <kbd class="bg-slate-700 px-1.5 py-0.5 rounded text-indigo-300">Shift</kbd> + Scroll to zoom</span>
          </div>
        </div>
      </transition>

      <!-- Loading indicator -->
      <div
        v-if="isLoading"
        class="absolute inset-0 z-10 flex flex-col items-center justify-center bg-slate-950/80 backdrop-blur-xs text-slate-300 pointer-events-none"
      >
        <Loader2 class="w-8 h-8 text-indigo-400 animate-spin mb-2" />
        <p class="text-xs font-medium">Loading 3D Model...</p>
      </div>

      <!-- Pure Three.js WebGL Canvas Mount Node -->
      <div
        ref="canvasContainerRef"
        class="w-full h-full block cursor-grab active:cursor-grabbing"
      ></div>

      <!-- Fallback Poster (If WebGL fails or disabled) -->
      <div
        v-if="!isModelInteractive && assetData?.posterUrl && !isLoading"
        class="absolute inset-0 flex flex-col items-center justify-center bg-slate-950 w-full h-full z-10 pointer-events-auto"
      >
        <img
          :src="assetData?.posterUrl"
          alt="3D Preview Render"
          style="width: 100%; height: 100%; object-fit: contain; padding: 1rem;"
        />
        <!-- Info badge -->
        <div class="absolute bottom-3 left-3 bg-slate-900/90 border border-slate-700/80 backdrop-blur-md px-3 py-1.5 rounded-xl text-xs text-slate-300 flex items-center gap-2 shadow-lg">
          <span>High-Res 3D Render</span>
          <span class="text-slate-500">•</span>
          <span class="text-indigo-400 font-mono text-[11px]">watertight mesh</span>
        </div>
        <!-- Poster Action Buttons (Interactive & Download) -->
        <div class="absolute bottom-3 right-3 flex items-center gap-2">
          <button
            @click="downloadModel"
            class="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-xs font-semibold shadow-lg transition cursor-pointer"
            title="Download GLB"
          >
            <Download class="w-3.5 h-3.5 text-indigo-400" />
            <span>Download GLB</span>
          </button>
          <button
            v-if="!isRehosting && assetData?.taskId"
            @click.stop="reHostModel"
            class="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold shadow-lg transition cursor-pointer"
            title="Enable Interactive 3D"
          >
            <RefreshCw class="w-3.5 h-3.5" />
            <span>Interactive 3D</span>
          </button>
          <div
            v-if="isRehosting"
            class="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-800/90 text-slate-300 text-xs"
          >
            <Loader2 class="w-3.5 h-3.5 animate-spin" />
            <span class="max-w-[160px] truncate">{{ rehostError || 'Processing...' }}</span>
          </div>
        </div>
      </div>

      <!-- Unified Parallel Controls in Bottom-Right (Eliminates extra bottom row!) -->
      <div v-if="isModelInteractive" class="absolute bottom-3 right-3 flex items-center gap-1 bg-slate-950/90 backdrop-blur-md p-1.5 rounded-xl border border-slate-700/80 shadow-2xl z-20">
        <!-- Zoom & Reset Controls -->
        <button
          @click="zoomIn"
          class="p-1.5 rounded-lg text-slate-300 hover:text-white hover:bg-slate-800 transition cursor-pointer"
          title="Zoom In (+)"
        >
          <ZoomIn class="w-4 h-4" />
        </button>
        <button
          @click="zoomOut"
          class="p-1.5 rounded-lg text-slate-300 hover:text-white hover:bg-slate-800 transition cursor-pointer"
          title="Zoom Out (-)"
        >
          <ZoomOut class="w-4 h-4" />
        </button>
        <button
          @click="resetView"
          class="p-1.5 rounded-lg text-slate-300 hover:text-white hover:bg-slate-800 transition cursor-pointer"
          title="Reset Camera Angle & Center"
        >
          <RotateCcw class="w-4 h-4" />
        </button>

        <div class="h-4 w-px bg-slate-700 mx-1"></div>

        <!-- AI Refine Color Button -->
        <button
          v-if="assetData?.taskId && !assetData?.isRefined && message"
          @click="openRefineModal"
          class="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-500 hover:to-pink-500 text-white font-medium text-xs shadow transition cursor-pointer"
        >
          <Sparkles class="w-3.5 h-3.5" />
          <span>Refine Color</span>
        </button>

        <!-- Download GLB Button (Parallel with tools) -->
        <button
          @click="downloadModel"
          class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs shadow-md shadow-indigo-950/40 transition cursor-pointer"
          title="Download GLB with suggested name"
        >
          <Download class="w-3.5 h-3.5" />
          <span>Download GLB</span>
        </button>
      </div>

      <!-- Gesture Helper Badge -->
      <div
        v-if="isModelInteractive"
        class="absolute top-2.5 left-2.5 pointer-events-none text-[10px] text-slate-300 bg-slate-950/80 backdrop-blur-xs px-2.5 py-1 rounded-md border border-slate-800 z-10"
      >
        Drag to rotate 360° · Shift + Scroll to zoom
      </div>
    </div>

    <!-- Custom Refine Prompt Modal -->
    <div
      v-if="isRefineModalOpen"
      class="absolute inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-xs rounded-2xl"
    >
      <div class="w-full max-w-sm bg-slate-900 border border-slate-700 rounded-xl p-5 shadow-2xl flex flex-col">
        <h3 class="text-sm font-bold text-slate-100 mb-2 flex items-center gap-2">
          <Palette class="w-4 h-4 text-indigo-400" /> Refine Textures & Style
        </h3>
        <p class="text-[11px] text-slate-400 mb-4">
          Describe your desired style (e.g., Cyberpunk, wood texture, red metal). Leave blank for AI auto-styling.
        </p>
        <input
          v-model="customRefinePrompt"
          type="text"
          placeholder="e.g., glowing blue material, vintage..."
          class="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-indigo-500 mb-4"
          @keydown.enter="submitRefine"
        />
        <div class="flex items-center justify-end gap-2 mt-auto">
          <button
            @click="isRefineModalOpen = false"
            class="px-3 py-1.5 rounded-lg text-xs font-medium text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition cursor-pointer"
          >
            Cancel
          </button>
          <button
            @click="submitRefine"
            class="px-3 py-1.5 rounded-lg text-xs font-medium bg-indigo-600 hover:bg-indigo-500 text-white transition cursor-pointer flex items-center gap-1.5"
          >
            <Palette class="w-3.5 h-3.5" />
            Start Refine
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
