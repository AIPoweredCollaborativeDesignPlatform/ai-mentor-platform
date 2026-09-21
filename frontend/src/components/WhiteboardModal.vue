<script setup lang="ts">
import { ref, onMounted, onUnmounted, nextTick } from 'vue';
import {
  X,
  Pencil,
  Highlighter,
  Eraser,
  Square,
  Circle,
  ArrowRight,
  Type,
  RotateCcw,
  Trash2,
  Image as ImageIcon,
  Send,
  Download,
  Palette,
  Sparkles
} from 'lucide-vue-next';

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'share', file: File): void;
}>();

const canvasRef = ref<HTMLCanvasElement | null>(null);
const fileInputRef = ref<HTMLInputElement | null>(null);

type ToolType = 'pen' | 'highlighter' | 'eraser' | 'line' | 'arrow' | 'rect' | 'circle' | 'text';

const activeTool = ref<ToolType>('pen');
const activeColor = ref('#38bdf8'); // Sky blue default
const strokeWidth = ref(3);
const isDrawing = ref(false);
const startX = ref(0);
const startY = ref(0);

const colorPalette = [
  '#38bdf8', // Sky
  '#818cf8', // Indigo
  '#ec4899', // Pink
  '#10b981', // Emerald
  '#f59e0b', // Amber
  '#ef4444', // Red
  '#ffffff', // White
  '#0f172a'  // Dark slate (eraser/bg)
];

const strokeSizes = [
  { label: 'S', value: 2 },
  { label: 'M', value: 4 },
  { label: 'L', value: 8 },
  { label: 'XL', value: 16 }
];

let ctx: CanvasRenderingContext2D | null = null;
let history: ImageData[] = [];
let maxHistory = 20;

const initCanvas = () => {
  if (!canvasRef.value) return;
  const canvas = canvasRef.value;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width;
  canvas.height = rect.height;

  ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (ctx) {
    ctx.fillStyle = '#0f172a'; // slate-900 canvas bg
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    saveState();
  }
};

const saveState = () => {
  if (!ctx || !canvasRef.value) return;
  if (history.length >= maxHistory) history.shift();
  history.push(ctx.getImageData(0, 0, canvasRef.value.width, canvasRef.value.height));
};

const undo = () => {
  if (!ctx || history.length <= 1 || !canvasRef.value) return;
  history.pop(); // Remove current state
  const prev = history[history.length - 1];
  if (prev) {
    ctx.putImageData(prev, 0, 0);
  }
};

const clearCanvas = () => {
  if (!ctx || !canvasRef.value) return;
  ctx.fillStyle = '#0f172a';
  ctx.fillRect(0, 0, canvasRef.value.width, canvasRef.value.height);
  saveState();
};

const getPos = (e: MouseEvent | TouchEvent) => {
  if (!canvasRef.value) return { x: 0, y: 0 };
  const rect = canvasRef.value.getBoundingClientRect();
  const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
  const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;
  return {
    x: clientX - rect.left,
    y: clientY - rect.top
  };
};

const startDrawing = (e: MouseEvent | TouchEvent) => {
  if (!ctx) return;
  isDrawing.value = true;
  const pos = getPos(e);
  startX.value = pos.x;
  startY.value = pos.y;

  if (activeTool.value === 'pen' || activeTool.value === 'highlighter' || activeTool.value === 'eraser') {
    ctx.beginPath();
    ctx.moveTo(pos.x, pos.y);
  } else if (activeTool.value === 'text') {
    const text = prompt('Enter annotation text:');
    if (text && text.trim()) {
      ctx.font = `${strokeWidth.value * 5 + 12}px sans-serif`;
      ctx.fillStyle = activeColor.value;
      ctx.fillText(text.trim(), pos.x, pos.y);
      saveState();
    }
    isDrawing.value = false;
  }
};

const draw = (e: MouseEvent | TouchEvent) => {
  if (!isDrawing.value || !ctx || !canvasRef.value) return;
  const pos = getPos(e);

  if (activeTool.value === 'pen') {
    ctx.globalAlpha = 1.0;
    ctx.strokeStyle = activeColor.value;
    ctx.lineWidth = strokeWidth.value;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineTo(pos.x, pos.y);
    ctx.stroke();
  } else if (activeTool.value === 'highlighter') {
    ctx.globalAlpha = 0.35;
    ctx.strokeStyle = activeColor.value;
    ctx.lineWidth = strokeWidth.value * 3;
    ctx.lineCap = 'square';
    ctx.lineTo(pos.x, pos.y);
    ctx.stroke();
  } else if (activeTool.value === 'eraser') {
    ctx.globalAlpha = 1.0;
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = strokeWidth.value * 4;
    ctx.lineCap = 'round';
    ctx.lineTo(pos.x, pos.y);
    ctx.stroke();
  } else {
    // Shape preview using last saved snapshot
    if (history.length > 0) {
      ctx.putImageData(history[history.length - 1], 0, 0);
    }
    ctx.globalAlpha = 1.0;
    ctx.strokeStyle = activeColor.value;
    ctx.fillStyle = activeColor.value;
    ctx.lineWidth = strokeWidth.value;
    ctx.lineCap = 'round';

    if (activeTool.value === 'line') {
      ctx.beginPath();
      ctx.moveTo(startX.value, startY.value);
      ctx.lineTo(pos.x, pos.y);
      ctx.stroke();
    } else if (activeTool.value === 'arrow') {
      drawArrow(ctx, startX.value, startY.value, pos.x, pos.y);
    } else if (activeTool.value === 'rect') {
      ctx.strokeRect(startX.value, startY.value, pos.x - startX.value, pos.y - startY.value);
    } else if (activeTool.value === 'circle') {
      const radius = Math.sqrt(Math.pow(pos.x - startX.value, 2) + Math.pow(pos.y - startY.value, 2));
      ctx.beginPath();
      ctx.arc(startX.value, startY.value, radius, 0, 2 * Math.PI);
      ctx.stroke();
    }
  }
};

const stopDrawing = () => {
  if (!isDrawing.value || !ctx) return;
  isDrawing.value = false;
  ctx.globalAlpha = 1.0;
  saveState();
};

const drawArrow = (context: CanvasRenderingContext2D, fromx: number, fromy: number, tox: number, toy: number) => {
  const headlen = strokeWidth.value * 3 + 8;
  const dx = tox - fromx;
  const dy = toy - fromy;
  const angle = Math.atan2(dy, dx);
  context.beginPath();
  context.moveTo(fromx, fromy);
  context.lineTo(tox, toy);
  context.lineTo(tox - headlen * Math.cos(angle - Math.PI / 6), toy - headlen * Math.sin(angle - Math.PI / 6));
  context.moveTo(tox, toy);
  context.lineTo(tox - headlen * Math.cos(angle + Math.PI / 6), toy - headlen * Math.sin(angle + Math.PI / 6));
  context.stroke();
};

// Import Image Backdrop for annotation
const handleImageUpload = (e: Event) => {
  const target = e.target as HTMLInputElement;
  const file = target.files?.[0];
  if (!file || !ctx || !canvasRef.value) return;

  const reader = new FileReader();
  reader.onload = (event) => {
    const img = new Image();
    img.onload = () => {
      if (!ctx || !canvasRef.value) return;
      const canvas = canvasRef.value;
      // Scale image to fit inside canvas nicely
      const hRatio = canvas.width / img.width;
      const vRatio = canvas.height / img.height;
      const ratio = Math.min(hRatio, vRatio, 1);
      const centerShiftX = (canvas.width - img.width * ratio) / 2;
      const centerShiftY = (canvas.height - img.height * ratio) / 2;
      
      ctx.drawImage(img, 0, 0, img.width, img.height, centerShiftX, centerShiftY, img.width * ratio, img.height * ratio);
      saveState();
    };
    img.src = event.target?.result as string;
  };
  reader.readAsDataURL(file);
  target.value = '';
};

// Export to File and Share
const handleShare = () => {
  if (!canvasRef.value) return;
  canvasRef.value.toBlob((blob) => {
    if (!blob) return;
    const file = new File([blob], `Design_Sketch_${Date.now()}.png`, { type: 'image/png' });
    emit('share', file);
    emit('close');
  }, 'image/png');
};

const handleDownload = () => {
  if (!canvasRef.value) return;
  const url = canvasRef.value.toDataURL('image/png');
  const a = document.createElement('a');
  a.href = url;
  a.download = `Design_Sketch_${Date.now()}.png`;
  a.click();
};

onMounted(() => {
  nextTick(() => {
    initCanvas();
  });
  window.addEventListener('resize', initCanvas);
});

onUnmounted(() => {
  window.removeEventListener('resize', initCanvas);
});
</script>

<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4 bg-slate-950/85 backdrop-blur-md">
    <div class="w-full max-w-5xl h-[92dvh] bg-slate-900 border border-indigo-500/30 rounded-2xl shadow-2xl flex flex-col overflow-hidden">
      <!-- Header -->
      <div class="p-3 sm:p-4 border-b border-slate-800 flex items-center justify-between bg-slate-950/70">
        <div class="flex items-center gap-2">
          <div class="p-2 rounded-xl bg-indigo-500/10 border border-indigo-500/30 text-indigo-400">
            <Palette class="w-4 h-4 sm:w-5 sm:h-5" />
          </div>
          <div>
            <h3 class="text-sm sm:text-base font-bold text-white flex items-center gap-1.5">
              Design Whiteboard & Annotation
              <span class="text-[10px] bg-indigo-500/20 text-indigo-300 font-mono px-2 py-0.5 rounded-full border border-indigo-500/30">
                Design Studio
              </span>
            </h3>
            <p class="text-[11px] text-slate-400 hidden xs:block">
              Sketch ideas, annotate reference images, and share directly with the team & AI Mentor.
            </p>
          </div>
        </div>

        <div class="flex items-center gap-2">
          <button
            @click="handleDownload"
            class="p-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition border border-slate-700"
            title="Download Image"
          >
            <Download class="w-4 h-4" />
          </button>
          <button
            @click="handleShare"
            class="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-gradient-to-r from-sky-600 to-indigo-600 hover:from-sky-500 hover:to-indigo-500 text-white font-semibold text-xs shadow-lg shadow-indigo-950/50 transition cursor-pointer"
          >
            <Send class="w-3.5 h-3.5" />
            <span>Share to Meeting</span>
          </button>
          <button
            @click="emit('close')"
            class="p-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white transition border border-slate-700 ml-1"
          >
            <X class="w-4 h-4" />
          </button>
        </div>
      </div>

      <!-- Toolbar -->
      <div class="p-2 border-b border-slate-800/80 bg-slate-950/40 flex flex-wrap items-center justify-between gap-2 text-xs">
        <!-- Tools -->
        <div class="flex items-center gap-1 overflow-x-auto pb-1 sm:pb-0">
          <button
            @click="activeTool = 'pen'"
            :class="activeTool === 'pen' ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'"
            class="p-2 rounded-xl transition"
            title="Pen"
          >
            <Pencil class="w-4 h-4" />
          </button>
          <button
            @click="activeTool = 'highlighter'"
            :class="activeTool === 'highlighter' ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'"
            class="p-2 rounded-xl transition"
            title="Highlighter"
          >
            <Highlighter class="w-4 h-4" />
          </button>
          <button
            @click="activeTool = 'eraser'"
            :class="activeTool === 'eraser' ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'"
            class="p-2 rounded-xl transition"
            title="Eraser"
          >
            <Eraser class="w-4 h-4" />
          </button>

          <div class="h-4 w-px bg-slate-700 mx-1"></div>

          <button
            @click="activeTool = 'arrow'"
            :class="activeTool === 'arrow' ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'"
            class="p-2 rounded-xl transition"
            title="Arrow"
          >
            <ArrowRight class="w-4 h-4" />
          </button>
          <button
            @click="activeTool = 'rect'"
            :class="activeTool === 'rect' ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'"
            class="p-2 rounded-xl transition"
            title="Rectangle"
          >
            <Square class="w-4 h-4" />
          </button>
          <button
            @click="activeTool = 'circle'"
            :class="activeTool === 'circle' ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'"
            class="p-2 rounded-xl transition"
            title="Circle"
          >
            <Circle class="w-4 h-4" />
          </button>
          <button
            @click="activeTool = 'text'"
            :class="activeTool === 'text' ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'"
            class="p-2 rounded-xl transition"
            title="Text Label"
          >
            <Type class="w-4 h-4" />
          </button>

          <div class="h-4 w-px bg-slate-700 mx-1"></div>

          <!-- Upload Image to Annotate -->
          <input
            ref="fileInputRef"
            type="file"
            accept="image/*"
            class="hidden"
            @change="handleImageUpload"
          />
          <button
            @click="fileInputRef?.click()"
            class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 transition"
            title="Import Reference Image to Annotate"
          >
            <ImageIcon class="w-4 h-4 text-emerald-400" />
            <span class="hidden sm:inline">Add Image</span>
          </button>
        </div>

        <!-- Color Picker & Stroke Size -->
        <div class="flex items-center gap-2">
          <!-- Colors -->
          <div class="flex items-center gap-1">
            <button
              v-for="color in colorPalette"
              :key="color"
              @click="activeColor = color"
              class="w-6 h-6 rounded-full border-2 transition transform hover:scale-110"
              :class="activeColor === color ? 'border-white scale-110' : 'border-transparent opacity-80'"
              :style="{ backgroundColor: color }"
            ></button>
          </div>

          <div class="h-4 w-px bg-slate-700 mx-1"></div>

          <!-- Stroke Size -->
          <div class="flex items-center gap-1 bg-slate-800 p-1 rounded-xl">
            <button
              v-for="size in strokeSizes"
              :key="size.value"
              @click="strokeWidth = size.value"
              class="px-2 py-0.5 rounded-lg text-xs font-semibold transition"
              :class="strokeWidth === size.value ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white'"
            >
              {{ size.label }}
            </button>
          </div>

          <div class="h-4 w-px bg-slate-700 mx-1"></div>

          <!-- Undo & Clear -->
          <button
            @click="undo"
            class="p-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 transition"
            title="Undo"
          >
            <RotateCcw class="w-4 h-4" />
          </button>
          <button
            @click="clearCanvas"
            class="p-1.5 rounded-xl bg-slate-800 hover:bg-rose-900/50 text-rose-400 transition"
            title="Clear Canvas"
          >
            <Trash2 class="w-4 h-4" />
          </button>
        </div>
      </div>

      <!-- Canvas Area -->
      <div class="flex-1 relative bg-slate-950 overflow-hidden cursor-crosshair">
        <canvas
          ref="canvasRef"
          class="w-full h-full block touch-none"
          @mousedown="startDrawing"
          @mousemove="draw"
          @mouseup="stopDrawing"
          @mouseleave="stopDrawing"
          @touchstart="startDrawing"
          @touchmove="draw"
          @touchend="stopDrawing"
        ></canvas>
      </div>
    </div>
  </div>
</template>
