<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue';
import '@google/model-viewer';
import {
  Layers,
  Sparkles,
  Download,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  Palette,
  Loader2,
  RefreshCw
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
const modelViewerRef = ref<any>(null);
const isLoading = ref(true);
const isModelInteractive = ref(false);
const isRehosting = ref(false);
const rehostError = ref('');
const showShiftPrompt = ref(false);
let shiftPromptTimeout: any = null;

const handleWheel = (e: WheelEvent) => {
  // If the user is scrolling the wheel without holding Shift, block zooming and show prompt
  if (isModelInteractive.value && !e.shiftKey) {
    e.preventDefault();
    e.stopPropagation();
    
    showShiftPrompt.value = true;
    if (shiftPromptTimeout) clearTimeout(shiftPromptTimeout);
    shiftPromptTimeout = setTimeout(() => {
      showShiftPrompt.value = false;
    }, 1500);
  }
};

// If assetData already tells us it's interactive (was stored as Firebase URL), skip loading state
watch(
  () => props.assetData?.isInteractive,
  (val) => {
    if (val) {
      // Pre-mark as interactive; model-viewer @load will confirm
    }
  },
  { immediate: true }
);

const recommendedFilename = computed(() => {
  let baseName = (props.assetData?.title || 'AI_3D_Model')
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^\w\u4e00-\u9fa5-_]/g, '');
  if (!baseName) baseName = 'AI_3D_Model';
  return `${baseName}.glb`;
});

const centerAndFrameModel = () => {
  if (!modelViewerRef.value) return;
  const mv = modelViewerRef.value;
  try {
    if (typeof mv.updateFraming === 'function') {
      mv.updateFraming();
    }
    if (typeof mv.getBoundingBoxCenter === 'function') {
      const center = mv.getBoundingBoxCenter();
      if (center && typeof center.x === 'number' && typeof center.y === 'number' && typeof center.z === 'number') {
        mv.cameraTarget = `${center.x}m ${center.y}m ${center.z}m`;
      }
    }
    mv.cameraOrbit = 'auto auto 105%';
    mv.fieldOfView = 'auto';
    if (typeof mv.jumpCameraToGoal === 'function') {
      mv.jumpCameraToGoal();
    }
  } catch (err) {
    console.warn('[ModelViewer] Auto centering failed:', err);
  }
};

const handleLoad = () => {
  isLoading.value = false;
  isModelInteractive.value = true;
  nextTick(() => {
    centerAndFrameModel();
    // Re-verify after small render frame to ensure tight bounds are populated
    setTimeout(centerAndFrameModel, 100);
  });
};

const handleError = (e: any) => {
  console.warn('[ModelViewer] Direct WebGL load prevented by browser security policy. Displaying high-res 3D preview render.', e);
  isLoading.value = false;
  isModelInteractive.value = false;
};

// Zoom In / Zoom Out controls (increased step for more noticeable zoom)
const zoomIn = () => {
  if (modelViewerRef.value?.zoom) {
    modelViewerRef.value.zoom(3);
  }
};

const zoomOut = () => {
  if (modelViewerRef.value?.zoom) {
    modelViewerRef.value.zoom(-3);
  }
};

const resetView = () => {
  centerAndFrameModel();
};

// Download GLB model file with proper filename via Proxy Content-Disposition
const downloadModel = async () => {
  const url = props.assetData?.modelUrl;
  if (!url) return;

  const filename = recommendedFilename.value;

  // Route through our proxy which sets Content-Disposition: attachment; filename="..."
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
      if (proxyRes.isPermanent) {
        roomStore.pushToast('Interactive 3D Enabled', 'Model permanently saved to cloud, you can now rotate and zoom.', 'success');
      } else {
        roomStore.pushToast('Interactive 3D Enabled', 'Model loaded (session only). You will need to re-enable it if you refresh.', 'info');
      }
      
      if (modelViewerRef.value) {
        modelViewerRef.value.src = proxyRes.firebaseUrl;
        modelViewerRef.value.dismissPoster?.();
      }
      isModelInteractive.value = true;
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
        <span class="text-[9px] text-slate-500 font-mono border border-slate-700/50 rounded px-1.5 py-0.5 ml-1 shrink-0">v1.6.7</span>
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

    <!-- Model Viewer Canvas / High-Res Render Hero -->
    <div
      class="w-full rounded-xl overflow-hidden bg-slate-900 border border-slate-800 relative group select-none h-72 sm:h-96"
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
          <div class="bg-slate-900/80 backdrop-blur-sm text-white px-4 py-2 rounded-full border border-slate-600/50 shadow-2xl flex items-center gap-2">
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
        <p class="text-xs font-medium">Loading 3D Preview...</p>
      </div>

      <!-- Native <model-viewer> element with natural centering & tight bounds -->
      <model-viewer
        ref="modelViewerRef"
        :src="assetData?.modelUrl"
        :poster="assetData?.posterUrl"
        alt="3D GLB Model"
        auto-rotate
        camera-controls
        touch-action="pan-y"
        bounds="tight"
        shadow-intensity="1.5"
        exposure="1.1"
        @load="handleLoad"
        @error="handleError"
        class="w-full h-full block"
      >
      </model-viewer>

      <!-- Fallback Poster (Outside model-viewer to ensure it shows on error) -->
      <div
        v-if="!isModelInteractive && assetData?.posterUrl"
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
