<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch, nextTick } from 'vue';
import { useRoomStore } from '../stores/room';
import { useAuthStore } from '../stores/auth';
import * as fabric from 'fabric';
import {
  X, Pencil, Image as ImageIcon, Undo2, Trash2, Maximize, Minimize, Check, Loader2, Sparkles, Send, Radio, Settings2, MousePointer2, Type, Square, Circle, Triangle, Minus, Group, Ungroup, BringToFront, SendToBack, MoveUp, MoveDown, Copy, Scissors, ClipboardPaste, AlertTriangle, AlertCircle, RefreshCw, ChevronDown, ChevronUp
} from 'lucide-vue-next';

const props = defineProps<{
  initialJson?: string;
  activeAssetId?: string | null;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'share', file: File): void;
  (e: 'save-state', json: string, previewDataUrl: string): void;
}>();

const hasUnsavedChanges = ref(false);
const showCloseConfirmModal = ref(false);

const roomStore = useRoomStore();
const authStore = useAuthStore();

const canvasRef = ref<HTMLCanvasElement | null>(null);
const fileInputRef = ref<HTMLInputElement | null>(null);
const wrapperRef = ref<HTMLDivElement | null>(null);

let canvas: fabric.Canvas | null = null;

const activeColor = ref('#0f172a'); // Dark slate for drawing on light background
const strokeWidth = ref(4);
const isDrawingMode = ref(true);

const colorPalette = [
  '#0f172a', // Dark slate
  '#38bdf8', // Sky
  '#818cf8', // Indigo
  '#ec4899', // Pink
  '#10b981', // Emerald
  '#f59e0b', // Amber
  '#ef4444', // Red
];

const colors = ['#0f172a', '#38bdf8', '#818cf8', '#e879f9', '#34d399', '#fbbf24', '#f87171'];
const strokeSizes = [
  { label: 'S', value: 2 },
  { label: 'M', value: 4 },
  { label: 'L', value: 8 },
  { label: 'XL', value: 16 }
];

const isBrushMenuOpen = ref(false);

let isInternalChange = false;
const historyStack = ref<string[]>([]);

const initFabric = () => {
  if (!canvasRef.value || !wrapperRef.value) return;
  
  canvas = new fabric.Canvas(canvasRef.value, {
    selectionFullyContained: false,
    perPixelTargetFind: true,
    targetFindTolerance: 4,
    fireRightClick: true,
    stopContextMenu: true,
    isDrawingMode: true,
    backgroundColor: 'transparent',
    width: wrapperRef.value.clientWidth,
    height: wrapperRef.value.clientHeight
  });

  // Render light dot grid that scales and pans with zoom and pan
  canvas.on('before:render', () => {
    if (!canvas) return;
    const ctx = canvas.getContext();
    if (!ctx) return;
    const width = canvas.getWidth();
    const height = canvas.getHeight();

    // 1. Fill crisp light background
    ctx.save();
    ctx.fillStyle = '#f8fafc';
    ctx.fillRect(0, 0, width, height);

    // 2. Draw responsive dot grid
    const vpt = canvas.viewportTransform || [1, 0, 0, 1, 0, 0];
    const zoom = canvas.getZoom();
    const panX = vpt[4];
    const panY = vpt[5];

    const baseSpacing = 28;
    const screenSpacing = baseSpacing * zoom;

    if (screenSpacing >= 8) {
      ctx.fillStyle = '#cbd5e1'; // light slate-300 dots
      const dotRadius = Math.max(0.75, Math.min(2.0, 1.1 * Math.sqrt(zoom)));

      const startX = ((panX % screenSpacing) + screenSpacing) % screenSpacing;
      const startY = ((panY % screenSpacing) + screenSpacing) % screenSpacing;

      for (let x = startX; x < width; x += screenSpacing) {
        for (let y = startY; y < height; y += screenSpacing) {
          ctx.beginPath();
          ctx.arc(x, y, dotRadius, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    ctx.restore();
  });

  updateBrush();
  saveHistoryState(); // Initial empty state

  // Listen to local changes to sync to Firestore and save history
  
    
    const handleObjectModification = (e: any) => {
      if (!isInternalChange) {
        saveHistoryState();
        syncToFirebase();
      }
    };

    canvas.on('path:created', () => {
      if (!isInternalChange) {
        saveHistoryState();
        syncToFirebase();
      }
    });
    
    canvas.on('object:modified', handleObjectModification);
    
    canvas.on('text:editing:exited', (e) => {
      if (!canvas) return;
      const textObj = e.target as any;
      if (!textObj.text.trim() || textObj.text === 'Type here...') {
        canvas.remove(textObj);
        if(canvas) canvas.requestRenderAll();
        saveHistoryState();
        syncToFirebase();
      }
    });

    canvas.on('mouse:down', (e) => {
      if (!canvas) return;
      isBrushMenuOpen.value = false;

      // Right click context menu
      if ((e.e as MouseEvent).button === 2) {
        const target = e.target;
        if (isDrawingMode.value) {
          toggleMode(false);
        }
        
        const activeObj = canvas.getActiveObject();
        // If clicked on an existing active selection, just show menu
        if (activeObj && target && (activeObj as any).contains(target)) {
           selectedObjForContext = activeObj;
           contextMenu.value = { visible: true, x: (e as any).viewportPoint.x || 0, y: (e as any).viewportPoint.y || 0 };
        } 
        // If clicked on a specific object not selected, select it
        else if (target) {
          canvas.setActiveObject(target);
          if(canvas) canvas.requestRenderAll();
          selectedObjForContext = target;
          contextMenu.value = { visible: true, x: (e as any).viewportPoint.x || 0, y: (e as any).viewportPoint.y || 0 };
        } 
        // If clicked empty space but have selection (Goal 5)
        else if (activeObj) {
           selectedObjForContext = activeObj;
           contextMenu.value = { visible: true, x: (e as any).viewportPoint.x || 0, y: (e as any).viewportPoint.y || 0 };
        } else {
           contextMenu.value.visible = false;
        }
        return;
      }

      // Close menu on left click
      if ((e.e as MouseEvent).button === 0 && !e.target && contextMenu.value.visible) {
        contextMenu.value.visible = false;
      }

      if ((e.e as MouseEvent).button !== 0) return; // Only process left click for drawing

      const pointer = canvas.getViewportPoint(e.e);

      // Handle spawning text
      if (currentTool.value === 'text') {
        const text = new fabric.IText('Type here...', {
          left: pointer.x,
          top: pointer.y,
          fontFamily: 'Inter, sans-serif',
          fontSize: 24,
          fill: activeColor.value,
        });
        canvas.add(text);
        canvas.setActiveObject(text);
        saveHistoryState();
        syncToFirebase();
        text.enterEditing();
        text.selectAll();
        currentTool.value = 'select'; // revert to select after spawning
        return;
      }

      // Handle drawing shapes
      if (['rect', 'circle', 'triangle', 'line'].includes(currentTool.value)) {
        drawingStartPoint = pointer;
        const options = { 
          left: pointer.x, top: pointer.y, 
          fill: 'transparent', stroke: activeColor.value, strokeWidth: strokeWidth.value,
          originX: 'left' as const, originY: 'top' as const, selectable: false, evented: false 
        };

        if (currentTool.value === 'rect') drawingObject = new fabric.Rect({ ...options, width: 0, height: 0 });
        else if (currentTool.value === 'circle') drawingObject = new fabric.Circle({ ...options, radius: 0 });
        else if (currentTool.value === 'triangle') drawingObject = new fabric.Triangle({ ...options, width: 0, height: 0 });
        else if (currentTool.value === 'line') drawingObject = new fabric.Line([pointer.x, pointer.y, pointer.x, pointer.y], { ...options });

        if (drawingObject) canvas.add(drawingObject);
      }
    });

    canvas.on('mouse:move', (e) => {
      if (!canvas || !drawingObject || !drawingStartPoint) return;
      const pointer = canvas.getViewportPoint(e.e);
      
      if (currentTool.value === 'rect' || currentTool.value === 'triangle') {
        drawingObject.set({
          width: Math.abs(pointer.x - drawingStartPoint.x),
          height: Math.abs(pointer.y - drawingStartPoint.y),
        });
        if (pointer.x < drawingStartPoint.x) drawingObject.set({ left: pointer.x });
        if (pointer.y < drawingStartPoint.y) drawingObject.set({ top: pointer.y });
      } else if (currentTool.value === 'circle') {
        const radius = Math.max(Math.abs(pointer.x - drawingStartPoint.x), Math.abs(pointer.y - drawingStartPoint.y)) / 2;
        drawingObject.set({ radius });
        if (pointer.x < drawingStartPoint.x) drawingObject.set({ left: drawingStartPoint.x - radius * 2 });
        if (pointer.y < drawingStartPoint.y) drawingObject.set({ top: drawingStartPoint.y - radius * 2 });
      } else if (currentTool.value === 'line') {
        drawingObject.set({ x2: pointer.x, y2: pointer.y });
      }
      if(canvas) canvas.requestRenderAll();
    });

    canvas.on('mouse:up', () => {
      if (drawingObject) {
        drawingObject.set({ selectable: true, evented: true });
        drawingObject.setCoords();
        if(canvas) canvas.setActiveObject(drawingObject);
        if(canvas) canvas.requestRenderAll();
        saveHistoryState();
        syncToFirebase();
        drawingObject = null;
        drawingStartPoint = null;
      }
    });



  // Implement Pan & Zoom
  canvas.on('mouse:wheel', function(opt) {
    if (!canvas) return;
    const delta = opt.e.deltaY;
    
    if (opt.e.ctrlKey) {
      // Zoom
      let zoom = canvas.getZoom();
      zoom *= 0.999 ** delta;
      if (zoom > 20) zoom = 20;
      if (zoom < 0.05) zoom = 0.05;
      canvas.zoomToPoint({ x: opt.e.offsetX, y: opt.e.offsetY } as fabric.Point, zoom);
      opt.e.preventDefault();
      opt.e.stopPropagation();
    } else if (opt.e.altKey) {
      // Pan X
      const vpt = canvas.viewportTransform;
      if (vpt) {
        vpt[4] -= delta;
        canvas?.requestRenderAll();
      }
      opt.e.preventDefault();
      opt.e.stopPropagation();
    } else {
      // Pan Y
      const vpt = canvas.viewportTransform;
      if (vpt) {
        vpt[5] -= delta;
        canvas?.requestRenderAll();
      }
      opt.e.preventDefault();
      opt.e.stopPropagation();
    }
  });

  let isDragging = false;
  let lastPosX = 0;
  let lastPosY = 0;

  canvas.on('mouse:down', function(opt) {
    const e = opt.e as MouseEvent;
    if (e.button === 1) { // Middle click
      isDragging = true;
      if (canvas) canvas.selection = false;
      lastPosX = e.clientX;
      lastPosY = e.clientY;
    } else if (e.button === 2) { // Right click
      if (opt.target && canvas) {
        canvas?.setActiveObject(opt.target);
        selectedObjForContext = opt.target;
        contextMenu.value = { visible: true, x: e.clientX, y: e.clientY };
      } else {
        contextMenu.value.visible = false;
      }
    } else {
      contextMenu.value.visible = false;
    }
  });
  canvas.on('mouse:move', function(opt) {
    if (isDragging && canvas) {
      const e = opt.e as MouseEvent;
      const vpt = canvas.viewportTransform;
      if (vpt) {
        vpt[4] += e.clientX - lastPosX;
        vpt[5] += e.clientY - lastPosY;
        canvas?.requestRenderAll();
      }
      lastPosX = e.clientX;
      lastPosY = e.clientY;
    }
  });
  canvas.on('mouse:up', function(opt) {
    const e = opt.e as MouseEvent;
    if (e.button === 1) {
      isDragging = false;
      if (canvas) canvas.selection = true;
    }
  });

  // Handle resizing
  const resizeObserver = new ResizeObserver(() => {
    if (canvas && wrapperRef.value) {
      canvas.setDimensions({
        width: wrapperRef.value.clientWidth,
        height: wrapperRef.value.clientHeight
      });
      canvas?.requestRenderAll();
    }
  });
  resizeObserver.observe(wrapperRef.value);

  // Load initial state from props (when opened from album) or active broadcast
  if (props.initialJson) {
    loadFromFirebase(props.initialJson);
    hasUnsavedChanges.value = false;
  } else if (roomStore.currentRoom?.whiteboardActive && roomStore.currentRoom?.whiteboardState) {
    loadFromFirebase(roomStore.currentRoom.whiteboardState);
  }
};

const updateBrush = () => {
  if (!canvas) return;
  const brush = new fabric.PencilBrush(canvas);
  brush.color = activeColor.value;
  brush.width = strokeWidth.value;
  canvas.freeDrawingBrush = brush;
};

watch([activeColor, strokeWidth], () => {
  updateBrush();
});

const saveHistoryState = () => {
  if (!canvas || isInternalChange) return;
  const json = JSON.stringify(canvas.toJSON());
  historyStack.value.push(json);
  if (historyStack.value.length > 50) {
    historyStack.value.shift();
  }
  if (historyStack.value.length > 1) {
    hasUnsavedChanges.value = true;
  }
};

const syncToFirebase = () => {
  if (isInternalChange || !canvas || !roomStore.currentRoom?.whiteboardActive) return;
  const json = JSON.stringify(canvas.toJSON());
  roomStore.syncWhiteboardState(json);
};

const loadFromFirebase = async (json: string) => {
  if (!canvas || !json) return;
  isInternalChange = true;
  await canvas.loadFromJSON(json);
  canvas?.requestRenderAll();
  
  // Maintain history synchronization loosely for remote viewers
  if (historyStack.value[historyStack.value.length - 1] !== json) {
    historyStack.value.push(json);
    if (historyStack.value.length > 50) historyStack.value.shift();
  }
  
  isInternalChange = false;
};

// Listen for remote updates
watch(() => roomStore.currentRoom?.whiteboardState, (newState, oldState) => {
  if (newState && newState !== oldState && roomStore.currentRoom?.whiteboardActive) {
    loadFromFirebase(newState);
  }
});

watch(() => props.initialJson, (newJson) => {
  if (newJson && canvas) {
    loadFromFirebase(newJson);
    hasUnsavedChanges.value = false;
  }
});


let clipboard: any = null;

const copySelection = async () => {
  if (!canvas) return;
  const activeObj = canvas.getActiveObject();
  if (activeObj) {
    clipboard = await activeObj.clone();
  }
};

const cutSelection = async () => {
  await copySelection();
  deleteSelected();
};

const pasteSelection = async () => {
  if (!canvas || !clipboard) return;
  
  const clonedObj = await clipboard.clone();
  if(canvas) canvas.discardActiveObject();
  
  clonedObj.set({
    left: clonedObj.left + 10,
    top: clonedObj.top + 10,
    evented: true,
  });
  
  if (clonedObj.type === 'activeSelection') {
    clonedObj.canvas = canvas;
    clonedObj.forEachObject(function(obj: any) {
      if (canvas) canvas.add(obj);
    });
    clonedObj.setCoords();
  } else {
    canvas.add(clonedObj);
  }
  
  clipboard.top += 10;
  clipboard.left += 10;
  
  if (canvas) if (canvas) canvas.setActiveObject(clonedObj);
  if(canvas) canvas.requestRenderAll();
  saveHistoryState();
  syncToFirebase();
};

const deleteSelected = () => {
  if (!canvas) return;
  const activeObjects = canvas.getActiveObjects();
  if (activeObjects.length) {
    activeObjects.forEach(obj => canvas?.remove(obj));
    if(canvas) canvas.discardActiveObject();
    canvas?.requestRenderAll();
    saveHistoryState();
    syncToFirebase();
  }
};

const undo = async () => {
  if (!canvas || historyStack.value.length <= 1) return;
  isInternalChange = true;
  historyStack.value.pop(); // remove current state
  const previousState = historyStack.value[historyStack.value.length - 1];
  await canvas.loadFromJSON(previousState);
  canvas?.requestRenderAll();
  syncToFirebase();
  isInternalChange = false;
};

const handleImageUpload = (e: Event) => {
  const target = e.target as HTMLInputElement;
  const file = target.files?.[0];
  if (!file || !canvas) return;

  const reader = new FileReader();
  reader.onload = (event) => {
    const imgUrl = event.target?.result as string;
    fabric.Image.fromURL(imgUrl).then(img => {
      // Compress/Scale image
      if (img.width && img.width > 800) {
        img.scaleToWidth(800);
      }
      if (canvas && wrapperRef.value) {
        // Reset viewport transform before calculating center to spawn where user is looking
        const center = canvas.getVpCenter();
        img.set({
          left: center.x,
          top: center.y,
          originX: 'center',
          originY: 'center'
        });
        canvas.add(img);
        canvas?.setActiveObject(img);
        saveHistoryState();
        syncToFirebase();
        toggleMode(false);
      }
    });
  };
  reader.readAsDataURL(file);
  target.value = '';
};

const toggleMode = (drawing: boolean) => { currentTool.value = drawing ? 'draw' : 'select'; 
  if (canvas) {
    isDrawingMode.value = drawing;
    canvas.isDrawingMode = drawing;
  }
};

const handleSendToChat = async () => {
  if (!canvas) return;
  
  // Reset zoom/pan temporarily to capture full canvas correctly if needed, or just capture current view.
  // We'll just capture what's visible for now, which is standard.
  const dataUrl = canvas.toDataURL({
    format: 'jpeg',
    quality: 0.85,
    multiplier: 1
  });
  
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  const file = new File([blob], `Whiteboard_${Date.now()}.jpg`, { type: 'image/jpeg' });
  
  emit('share', file);
  emit('close');
};

const handleBroadcast = () => {
  if (!canvas) return;
  const json = JSON.stringify(canvas.toJSON());
  roomStore.startWhiteboardSession(json);
};

const handleStopBroadcast = async () => {
  if (!canvas) return;
  const json = JSON.stringify(canvas.toJSON());
  const dataUrl = canvas.toDataURL({ format: 'jpeg', quality: 0.6, multiplier: 1 });
  
  emit('save-state', json, dataUrl);
  hasUnsavedChanges.value = false;
  roomStore.endWhiteboardSession();
  emit('close');
};

const handleCloseRequest = () => {
  if (roomStore.currentRoom?.whiteboardActive) {
    // If broadcast is active, closing simply hides the whiteboard panel locally
    emit('close');
    return;
  }

  if (hasUnsavedChanges.value) {
    showCloseConfirmModal.value = true;
  } else {
    emit('close');
  }
};

const handleConfirmDiscard = () => {
  hasUnsavedChanges.value = false;
  showCloseConfirmModal.value = false;
  emit('close');
};

const handleConfirmSave = () => {
  if (!canvas) return;
  const json = JSON.stringify(canvas.toJSON());
  const dataUrl = canvas.toDataURL({ format: 'jpeg', quality: 0.6, multiplier: 1 });
  emit('save-state', json, dataUrl);
  hasUnsavedChanges.value = false;
  showCloseConfirmModal.value = false;
  emit('close');
};


  
  const handleKeydown = (e: any) => {
    if ((e.key === 'Delete' || e.key === 'Backspace') && !e.target?.matches('input, textarea')) {
      const activeObj = canvas?.getActiveObject();
      if (activeObj && !(activeObj as any).isEditing) {
        deleteSelected();
      }
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'c' && !e.target?.matches('input, textarea')) {
      copySelection();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'x' && !e.target?.matches('input, textarea')) {
      cutSelection();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'v' && !e.target?.matches('input, textarea')) {
      pasteSelection();
    }
  };

  
  
const currentTool = ref('select'); // 'select', 'draw', 'text', 'rect', 'circle', 'triangle', 'line'
let drawingObject: any = null;
let drawingStartPoint: any = null;

const addShape = (type: any) => {
  currentTool.value = type;
  isDrawingMode.value = false;
  if (canvas) canvas.isDrawingMode = false;
  canvas?.discardActiveObject();
  canvas?.requestRenderAll();
};

const addText = () => {
  currentTool.value = 'text';
  isDrawingMode.value = false;
  if (canvas) canvas.isDrawingMode = false;
  canvas?.discardActiveObject();
  canvas?.requestRenderAll();
};
onMounted(() => {
    window.addEventListener('keydown', handleKeydown);

  nextTick(() => {
    initFabric();
  });
});

// --- AI Generator ---
import { generateSvgForWhiteboard } from '../services/ai';
const aiPrompt = ref('');
const isGeneratingSvg = ref(false);

interface AiErrorDetail {
  title: string;
  category: string;
  suggestion: string;
  attempts?: Array<{ model: string; error: string }>;
  rawMessage: string;
}

const aiError = ref<AiErrorDetail | null>(null);
const showAiErrorDetails = ref(false);
const errorCopied = ref(false);
const lastFailedPrompt = ref('');

const copyErrorDetails = () => {
  if (!aiError.value) return;
  const payload = JSON.stringify(aiError.value, null, 2);
  navigator.clipboard.writeText(payload);
  errorCopied.value = true;
  setTimeout(() => { errorCopied.value = false; }, 2000);
};

const retryGenerateAIObject = () => {
  if (lastFailedPrompt.value) {
    aiPrompt.value = lastFailedPrompt.value;
    aiError.value = null;
    generateAIObject();
  }
};


const generateAIObject = async () => {
    if (!aiPrompt.value.trim() || !canvas || isGeneratingSvg.value) return;
    const currentPrompt = aiPrompt.value.trim();
    lastFailedPrompt.value = currentPrompt;
    isGeneratingSvg.value = true;
    aiError.value = null;
    showAiErrorDetails.value = false;

    try {
      const svgString = await generateSvgForWhiteboard(currentPrompt, roomStore.currentRoom!.mentorConfig);
      const { objects, options } = await fabric.loadSVGFromString(svgString);
      if (!canvas) return;
      const validObjects = objects.filter((o): o is fabric.FabricObject => o !== null);
      const obj = fabric.util.groupSVGElements(validObjects, options);
      const center = canvas.getVpCenter();
      obj.set({
        left: center.x,
        top: center.y,
        originX: 'center',
        originY: 'center',
        scaleX: 2,
        scaleY: 2
      });
      if (canvas) canvas.add(obj);
      canvas?.setActiveObject(obj);
      saveHistoryState();
      syncToFirebase();
      aiPrompt.value = '';
      toggleMode(false);
    } catch (e: any) {
      console.error('Whiteboard AI Generation Error:', e);
      if (e?.isAiError) {
        aiError.value = {
          title: e.title,
          category: e.category,
          suggestion: e.suggestion,
          attempts: e.attempts,
          rawMessage: e.rawMessage
        };
      } else {
        aiError.value = {
          title: 'AI Vector Generation Failed',
          category: 'UNKNOWN',
          suggestion: e.message || 'An unexpected error occurred while generating vector graphics.',
          rawMessage: String(e)
        };
      }
    } finally {
      isGeneratingSvg.value = false;
    }
  };

// --- Context Menu (Right Click) ---
const contextMenu = ref({ visible: false, x: 0, y: 0 });
let selectedObjForContext: fabric.Object | null = null;

onMounted(() => {
  if (wrapperRef.value) {
    // Disable native context menu
    wrapperRef.value.addEventListener('contextmenu', (e) => e.preventDefault());
  }
});


const bringToFront = () => {
  if (selectedObjForContext && canvas) {
    canvas.bringObjectToFront(selectedObjForContext);
    saveHistoryState();
    syncToFirebase();
  }
};
const sendToBack = () => {
  if (selectedObjForContext && canvas) {
    canvas.sendObjectToBack(selectedObjForContext);
    saveHistoryState();
    syncToFirebase();
  }
};
const groupObjects = () => {
  if (!canvas) return;
  const activeObj = canvas?.getActiveObject();
  if (activeObj && activeObj.type === 'activeSelection') {
    (activeObj as any).toGroup();
    canvas?.requestRenderAll();
    saveHistoryState();
    syncToFirebase();
  }
};
const ungroupObjects = () => {
  if (!canvas) return;
  const activeObj = canvas?.getActiveObject();
  if (activeObj && activeObj.type === 'group') {
    (activeObj as any).toActiveSelection();
    canvas?.requestRenderAll();
    saveHistoryState();
    syncToFirebase();
  }
};

const bringForward = () => {
  if (selectedObjForContext && canvas) {
    canvas.bringObjectForward(selectedObjForContext);
    saveHistoryState();
    syncToFirebase();
  }
};

const sendBackwards = () => {
  if (selectedObjForContext && canvas) {
    canvas.sendObjectBackwards(selectedObjForContext);
    saveHistoryState();
    syncToFirebase();
  }
};

const applyColorToSelected = (color: string) => {
  activeColor.value = color;
  if (!canvas) return;
  const activeObj = canvas?.getActiveObject();
  if (activeObj) {
    if (activeObj.isType('path')) {
      activeObj.set({ stroke: color });
    } else if (activeObj.isType('i-text')) {
      activeObj.set({ fill: color });
    }
    canvas?.requestRenderAll();
    saveHistoryState();
    syncToFirebase();
  } else if (isDrawingMode.value) {
    updateBrush();
  }
};



onUnmounted(() => {
    window.removeEventListener('keydown', handleKeydown);
  if (canvas) {
    canvas.dispose();
  }
});
</script>

<template>
  <div class="h-full w-full flex flex-col relative bg-slate-900 overflow-hidden">
    <!-- Header -->
    <div class="absolute top-4 left-4 z-10 flex items-center gap-2">
      <div v-if="roomStore.currentRoom?.whiteboardActive" class="px-3 py-1.5 rounded-full bg-indigo-600/90 backdrop-blur shadow-sm border border-indigo-400 flex items-center gap-2 text-xs font-semibold text-white animate-pulse">
        <Radio class="w-3.5 h-3.5" />
        {{ roomStore.currentRoom?.whiteboardHostName }} is Broadcasting
      </div>
      <div v-else class="px-3 py-1.5 rounded-full bg-white/90 backdrop-blur shadow-sm border border-slate-200 flex items-center gap-2 text-xs font-semibold text-slate-700">
        <Sparkles class="w-3.5 h-3.5 text-sky-500" />
        Local Sketchpad
      </div>
    </div>
    
    <div class="absolute top-4 right-4 z-10 flex items-center gap-2">
      <button v-if="roomStore.currentRoom?.whiteboardActive && roomStore.currentRoom?.whiteboardHostUid === authStore.uid" @click="handleStopBroadcast()" class="px-3 py-1.5 rounded-xl bg-rose-500/90 hover:bg-rose-600 text-white shadow-sm transition text-xs font-semibold flex items-center gap-1">
        <X class="w-3.5 h-3.5" /> Stop Broadcast
      </button>
      <button v-if="!roomStore.currentRoom?.whiteboardActive" @click="handleBroadcast" class="px-3 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white shadow-sm transition text-xs font-semibold flex items-center gap-1">
        <Radio class="w-3.5 h-3.5" /> Broadcast
      </button>
      <button @click="handleCloseRequest" class="p-1.5 rounded-xl bg-white/90 hover:bg-white text-slate-500 hover:text-slate-700 shadow-sm transition" title="Close Panel">
        <X class="w-4 h-4" />
      </button>
    </div>

    <!-- Canvas Wrapper -->
    <div ref="wrapperRef" class="flex-1 w-full h-full relative cursor-crosshair">
      <canvas ref="canvasRef" class="w-full h-full touch-none"></canvas>
    </div>

    <!-- Floating Unified Toolbar (Bottom Center) -->
    
    
    <!-- AI Error Reporting Card -->
    <transition
      enter-active-class="transition duration-200 ease-out"
      enter-from-class="transform opacity-0 translate-y-4"
      enter-to-class="transform opacity-100 translate-y-0"
      leave-active-class="transition duration-150 ease-in"
      leave-from-class="transform opacity-100 translate-y-0"
      leave-to-class="transform opacity-0 translate-y-4"
    >
      <div
        v-if="aiError"
        class="absolute bottom-28 left-1/2 -translate-x-1/2 z-30 w-[94vw] sm:w-[460px] max-w-lg bg-slate-900/95 backdrop-blur-xl border border-rose-500/40 rounded-2xl shadow-2xl p-3.5 text-slate-200 text-xs flex flex-col gap-2.5 animate-in fade-in"
      >
        <div class="flex items-start justify-between gap-2">
          <div class="flex items-center gap-2 text-rose-400 font-semibold text-sm">
            <AlertTriangle class="w-4 h-4 shrink-0 text-rose-400" />
            <span>{{ aiError.title }}</span>
          </div>
          <button @click="aiError = null" class="p-1 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition">
            <X class="w-4 h-4" />
          </button>
        </div>

        <p class="text-slate-300 leading-relaxed text-[11px] sm:text-xs">
          {{ aiError.suggestion }}
        </p>

        <!-- Collapsible Diagnostic Details -->
        <div v-if="aiError.attempts && aiError.attempts.length > 0" class="border border-slate-800 rounded-xl bg-slate-950/60 overflow-hidden">
          <button
            @click="showAiErrorDetails = !showAiErrorDetails"
            class="w-full px-3 py-1.5 flex items-center justify-between text-[11px] text-slate-400 hover:text-slate-300 transition"
          >
            <span>Diagnostic Attempts ({{ aiError.attempts.length }} models attempted)</span>
            <component :is="showAiErrorDetails ? ChevronUp : ChevronDown" class="w-3.5 h-3.5" />
          </button>

          <div v-if="showAiErrorDetails" class="px-3 py-2 border-t border-slate-800/80 space-y-1.5 max-h-40 overflow-y-auto custom-scrollbar text-[10px] font-mono">
            <div
              v-for="(att, idx) in aiError.attempts"
              :key="idx"
              class="p-1.5 rounded bg-slate-900/80 border border-slate-800 text-slate-300"
            >
              <div class="text-rose-400 font-semibold">{{ att.model }}:</div>
              <div class="text-slate-400 break-words mt-0.5">{{ att.error }}</div>
            </div>
          </div>
        </div>

        <!-- Action Buttons -->
        <div class="flex items-center justify-between pt-1 border-t border-slate-800/60 text-xs">
          <button
            @click="copyErrorDetails"
            class="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition flex items-center gap-1.5 text-[11px]"
          >
            <Check v-if="errorCopied" class="w-3.5 h-3.5 text-emerald-400" />
            <Copy v-else class="w-3.5 h-3.5 text-slate-400" />
            <span>{{ errorCopied ? 'Copied' : 'Copy Diagnostic Log' }}</span>
          </button>

          <div class="flex items-center gap-1.5">
            <button
              @click="retryGenerateAIObject"
              class="px-3 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium transition flex items-center gap-1.5 text-[11px]"
            >
              <RefreshCw class="w-3.5 h-3.5" /> Retry
            </button>
            <button
              @click="aiError = null"
              class="px-2.5 py-1 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-slate-300 transition text-[11px]"
            >Dismiss</button>
          </div>
        </div>
      </div>
    </transition>

    <!-- Controls hint -->
    <div class="absolute bottom-20 left-1/2 -translate-x-1/2 text-[10px] text-slate-400/60 pointer-events-none text-center whitespace-nowrap">
      Ctrl+Wheel: Zoom • Alt+Wheel / Mid-click: Pan • Right-Click: Context Menu
    </div>

    <div class="absolute bottom-6 left-1/2 -translate-x-1/2 z-10 flex items-center gap-2 sm:gap-4 transition-all w-max max-w-[95%]">
      
      <!-- AI Input -->
      <div class="flex flex-col gap-2 w-[180px] sm:w-[220px]">
        <div v-if="isGeneratingSvg" class="px-3 py-2 bg-slate-900/90 text-sky-400 text-xs font-medium rounded-xl flex items-center gap-2 backdrop-blur border border-slate-700 shadow-xl">
          <Loader2 class="w-4 h-4 animate-spin" /> Generating...
        </div>
        <form v-else @submit.prevent="generateAIObject" class="flex bg-white/95 backdrop-blur-md rounded-2xl shadow-xl border border-slate-200 p-1">
          <input v-model="aiPrompt" type="text" placeholder="Generate icon, chart..." class="flex-1 bg-transparent px-3 py-1.5 text-xs focus:outline-none text-slate-700 placeholder-slate-400 min-w-0" />
          <button type="submit" :disabled="!aiPrompt.trim()" class="p-1.5 rounded-xl bg-indigo-100 text-indigo-600 hover:bg-indigo-200 transition disabled:opacity-50 disabled:cursor-not-allowed shrink-0">
            <Sparkles class="w-3.5 h-3.5" />
          </button>
        </form>
      </div>

      <!-- Main Tools -->
      <div class="bg-white/95 backdrop-blur-md rounded-2xl shadow-xl border border-slate-200 p-2 flex items-center gap-1 sm:gap-2">
        <button @click="toggleMode(false)" class="p-2 rounded-xl transition" :class="currentTool === 'select' ? 'bg-indigo-100 text-indigo-600' : 'hover:bg-slate-100 text-slate-500'" title="Select / Move">
          <MousePointer2 class="w-4 h-4" />
        </button>
        
        <div class="relative">
          <button @click="toggleMode(true); isBrushMenuOpen = !isBrushMenuOpen" class="p-2 rounded-xl transition flex items-center gap-1" :class="currentTool !== 'select' && currentTool !== 'text' ? 'bg-indigo-100 text-indigo-600' : 'hover:bg-slate-100 text-slate-500'" title="Draw & Shapes">
            <Pencil class="w-4 h-4" />
          </button>
          
          <div v-if="isBrushMenuOpen && isDrawingMode" class="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 bg-white rounded-xl shadow-xl border border-slate-200 p-3 flex flex-col gap-3 min-w-[140px]">
            <div class="flex items-center justify-between gap-1">
              <button v-for="size in strokeSizes" :key="size.value" @click="strokeWidth = size.value; isBrushMenuOpen = false" class="px-2 py-1 rounded-lg text-[10px] font-bold transition flex-1" :class="strokeWidth === size.value ? 'bg-indigo-100 text-indigo-700' : 'text-slate-400 hover:text-slate-600 bg-slate-50'">
                {{ size.label }}
              </button>
            </div>
            <div class="h-px bg-slate-100"></div>
            <div class="flex items-center gap-1 justify-between">
              <button @click="addShape('rect')" class="p-1.5 hover:bg-slate-100 rounded text-slate-500"><Square class="w-4 h-4" /></button>
              <button @click="addShape('circle')" class="p-1.5 hover:bg-slate-100 rounded text-slate-500"><Circle class="w-4 h-4" /></button>
              <button @click="addShape('triangle')" class="p-1.5 hover:bg-slate-100 rounded text-slate-500"><Triangle class="w-4 h-4" /></button>
              <button @click="addShape('line')" class="p-1.5 hover:bg-slate-100 rounded text-slate-500"><Minus class="w-4 h-4" /></button>
            </div>
          </div>
        </div>
        
        <button @click="addText" class="p-2 rounded-xl transition" :class="currentTool === 'text' ? 'bg-indigo-100 text-indigo-600' : 'hover:bg-slate-100 text-slate-500'" title="Add Text">
          <Type class="w-4 h-4" />
        </button>
        
        <div class="w-px h-6 bg-slate-200 mx-1 hidden sm:block"></div>
        
        <div class="flex items-center gap-1">
          <button v-for="color in colors" :key="color" @click="applyColorToSelected(color)" class="w-4 h-4 sm:w-5 sm:h-5 rounded-full border-2 transition transform hover:scale-110" :class="activeColor === color ? 'border-indigo-400 scale-110 shadow-sm' : 'border-transparent opacity-80 hover:opacity-100'" :style="{ backgroundColor: color }"></button>
        </div>
        
        <div class="w-px h-6 bg-slate-200 mx-1 hidden sm:block"></div>
        
        <div class="flex items-center gap-1">
          <input ref="fileInputRef" type="file" accept="image/*" class="hidden" @change="handleImageUpload" />
          <button @click="fileInputRef?.click()" class="p-1.5 rounded-xl hover:bg-slate-100 text-slate-500 transition" title="Add Image"><ImageIcon class="w-4 h-4" /></button>
          <button @click="undo" class="p-1.5 rounded-xl hover:bg-slate-100 text-slate-500 transition" title="Undo" :disabled="historyStack.length <= 1" :class="{'opacity-50 cursor-not-allowed': historyStack.length <= 1}"><Undo2 class="w-4 h-4" /></button>
          <button @click="deleteSelected" class="p-1.5 rounded-xl hover:bg-rose-100 text-rose-500 transition" title="Delete Selected"><Trash2 class="w-4 h-4" /></button>
        </div>
        
        <div class="w-px h-6 bg-slate-200 mx-1"></div>
        
        <button @click="handleSendToChat" class="p-1.5 px-3 rounded-xl bg-sky-500 hover:bg-sky-600 text-white transition flex items-center gap-1.5 text-xs font-medium" title="Send drawing to chat">
          <Send class="w-3.5 h-3.5" /> <span class="hidden sm:inline">Send</span>
        </button>
      </div>
    </div>

    <!-- Unsaved Changes Confirmation Modal (English) -->
    <div
      v-if="showCloseConfirmModal"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4"
    >
      <div class="bg-slate-900 border border-slate-800 rounded-2xl p-6 max-w-sm w-full shadow-2xl text-slate-100 space-y-4 animate-in fade-in zoom-in-95">
        <div class="flex items-center gap-3">
          <div class="p-2.5 rounded-xl bg-amber-500/20 text-amber-400">
            <AlertTriangle class="w-6 h-6" />
          </div>
          <div>
            <h3 class="font-bold text-base text-slate-100">Save Whiteboard?</h3>
            <p class="text-xs text-slate-400">You have unsaved changes on your sketchpad.</p>
          </div>
        </div>
        <p class="text-xs text-slate-300 leading-relaxed">
          Would you like to save this whiteboard as an asset in the Room Album and post it to chat, or discard your modifications?
        </p>
        <div class="flex items-center justify-end gap-2 pt-2">
          <button
            @click="handleConfirmDiscard"
            class="px-3 py-2 rounded-xl text-xs font-semibold text-rose-400 hover:bg-rose-950/40 border border-rose-500/30 transition cursor-pointer"
          >
            Discard Changes
          </button>
          <button
            @click="handleConfirmSave"
            class="px-4 py-2 rounded-xl text-xs font-semibold bg-indigo-600 hover:bg-indigo-500 text-white shadow-md transition cursor-pointer"
          >
            Save to Assets
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

