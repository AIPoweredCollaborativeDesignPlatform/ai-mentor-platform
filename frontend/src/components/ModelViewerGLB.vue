<script setup lang="ts">
import { onMounted } from 'vue';
import { Layers, Sparkles } from 'lucide-vue-next';

defineProps<{
  assetData: any;
}>();

onMounted(async () => {
  // Dynamically import @google/model-viewer to ensure custom element registration
  try {
    await import('@google/model-viewer');
  } catch (e) {
    console.error('Failed to load model-viewer element:', e);
  }
});
</script>

<template>
  <div class="mt-3 bg-slate-950/80 border border-purple-500/30 rounded-2xl p-4 shadow-xl">
    <div class="flex items-center justify-between mb-2">
      <div class="flex items-center gap-2">
        <Layers class="w-5 h-5 text-purple-400" />
        <h4 class="font-semibold text-slate-100 text-sm tracking-wide">
          {{ assetData?.title || 'External 3D Model' }}
        </h4>
        <span class="text-[10px] bg-purple-500/20 text-purple-300 font-mono px-2 py-0.5 rounded-full border border-purple-500/30 flex items-center gap-1">
          <Sparkles class="w-2.5 h-2.5" /> GLB / External Mesh
        </span>
      </div>
      <span class="text-xs text-slate-400">
        {{ assetData?.provider || 'Meshy / Tripo3D Pipeline' }}
      </span>
    </div>

    <!-- Model Viewer Canvas -->
    <div class="w-full h-80 rounded-xl overflow-hidden bg-slate-900 border border-slate-800 relative">
      <model-viewer
        :src="assetData?.modelUrl || 'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Models/master/2.0/DamagedHelmet/glTF-Binary/DamagedHelmet.glb'"
        alt="3D GLB Model"
        auto-rotate
        camera-controls
        shadow-intensity="1.5"
        exposure="1"
        style="width: 100%; height: 100%;"
      ></model-viewer>
    </div>

    <div class="mt-2 flex items-center justify-between text-xs text-slate-400">
      <span>Format: {{ assetData?.format?.toUpperCase() || 'GLB' }}</span>
      <span>Size: {{ assetData?.filesize || '3.2 MB' }}</span>
      <span class="text-purple-400">360° drag & scroll zoom</span>
    </div>
  </div>
</template>
