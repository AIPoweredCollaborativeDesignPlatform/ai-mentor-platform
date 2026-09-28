<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch, nextTick } from 'vue';
import { useRoomStore } from '../stores/room';
import { useAuthStore } from '../stores/auth';
import * as fabric from 'fabric';
import {
  X, Pencil, Image as ImageIcon, Undo2, Trash2, Maximize, Minimize, Check, Loader2, Sparkles, Send, Radio, Settings2, MousePointer2, Type, Square, Circle, Triangle, Minus, Group, Ungroup, BringToFront, SendToBack, MoveUp, MoveDown, Copy, Scissors, ClipboardPaste, AlertTriangle, AlertCircle, RefreshCw, ChevronDown, ChevronUp
} from 'lucide-vue-next';
import { generateSvgForWhiteboard } from '../services/ai';

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

const colors = ['#0f172a', '#38bdf8', '#818cf8', '#e879f9', '#34d399', '#fbbf24', '#f87171'];
const strokeSizes = [
  { label: 'S', value: 2 },
  { label: 'M', value: 4 },
  { label: 'L', value: 8 },
  { label: 'XL', value: 16 }
];

const isBrushMenuOpen = ref(false);
const currentTool = ref('draw'); // 'select', 'draw', 'text', 'rect', 'circle', 'triangle', 'line'

let isInternalChange = false;
const historyStack = ref<string[]>([]);

// Selection & Context Menu state
let clipboard: any = null;
let contextMenuScenePoint: { x: number; y: number } | null = null;
const contextMenu = ref({ visible: false, x: 0, y: 0 });
const hasSelection = ref(false);
const isMultiSelection = ref(false);
const isGroupSelected = ref(false);

const updateSelectionState = () => {
  if (!canvas) {
    hasSelection.value = false;
    isMultiSelection.value = false;
    isGroupSelected.value = false;
    return;
  }
  const active = canvas.getActiveObject();
  hasSelection.value = !!active;
  isMultiSelection.value = active?.type === 'activeSelection';
  isGroupSelected.value = active?.type === 'group';
};

// Hit-test helper: ensures selection marquee checks actual stroke/entity, not empty bounding box
const isObjectHitByRect = (canvasObj: fabric.Canvas, obj: any, rect: { left: number; top: number; width: number; height: number }): boolean => {
  if (obj.isType?.('image') || obj.isType?.('i-text') || obj.isType?.('text') || obj.isType?.('textbox')) {
    return true;
  }
  const fill = obj.get?.('fill') || obj.fill;
  if (fill && fill !== 'transparent' && fill !== 'rgba(0,0,0,0)' && fill !== 'none') {
    return true;
  }

  const objRect = obj.getBoundingRect ? obj.getBoundingRect() : { left: obj.left, top: obj.top, width: obj.width, height: obj.height };
  const overlapX = Math.max(rect.left, objRect.left);
  const overlapY = Math.max(rect.top, objRect.top);
  const overlapRight = Math.min(rect.left + rect.width, objRect.left + objRect.width);
  const overlapBottom = Math.min(rect.top + rect.height, objRect.top + objRect.height);

  const overlapW = overlapRight - overlapX;
  const overlapH = overlapBottom - overlapY;

  if (overlapW <= 0 || overlapH <= 0) return false;

  const checkW = Math.min(48, Math.ceil(overlapW));
  const checkH = Math.min(48, Math.ceil(overlapH));

  const testCanvas = document.createElement('canvas');
  testCanvas.width = checkW;
  testCanvas.height = checkH;
  const ctx = testCanvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return true;

  ctx.save();
  ctx.scale(checkW / overlapW, checkH / overlapH);
  ctx.translate(-overlapX, -overlapY);
  try {
    obj.render(ctx);
  } catch {
    ctx.restore();
    return true;
  }
  ctx.restore();

  const imgData = ctx.getImageData(0, 0, checkW, checkH).data;
  for (let i = 3; i < imgData.length; i += 4) {
    if (imgData[i] > 10) {
      return true;
    }
  }
  return false;
};

// Snapshot helper: guarantees a light background (#f8fafc) and dot grid for JPEG exports
const getCanvasSnapshot = (quality = 0.7): string => {
  if (!canvas) return '';
  const width = canvas.getWidth();
  const height = canvas.getHeight();

  const offscreen = document.createElement('canvas');
  offscreen.width = width;
  offscreen.height = height;
  const ctx = offscreen.getContext('2d');
  if (!ctx) return canvas.toDataURL({ format: 'jpeg', quality, multiplier: 1 });

  // 1. Fill light background
  ctx.fillStyle = '#f8fafc';
  ctx.fillRect(0, 0, width, height);

  // 2. Draw dot grid matching the canvas view
  const vpt = canvas.viewportTransform || [1, 0, 0, 1, 0, 0];
  const zoom = canvas.getZoom();
  const panX = vpt[4];
  const panY = vpt[5];
  const baseSpacing = 28;
  const screenSpacing = baseSpacing * zoom;

  if (screenSpacing >= 8) {
    ctx.fillStyle = '#cbd5e1';
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

  // 3. Draw fabric lower canvas elements
  const lowerCanvas = canvas.lowerCanvasEl;
  if (lowerCanvas) {
    ctx.drawImage(lowerCanvas, 0, 0);
  }

  return offscreen.toDataURL('image/jpeg', quality);
};

let drawingObject: any = null;
let drawingStartPoint: { x: number; y: number } | null = null;
let isDragging = false;
let lastPosX = 0;
let lastPosY = 0;

const initFabric = () => {
  if (!canvasRef.value || !wrapperRef.value) return;

  canvas = new fabric.Canvas(canvasRef.value, {
    selectionFullyContained: false,
    perPixelTargetFind: true,
    targetFindTolerance: 6,
    fireRightClick: true,
    stopContextMenu: true,
    isDrawingMode: true,
    backgroundColor: '#f8fafc',
    width: wrapperRef.value.clientWidth,
    height: wrapperRef.value.clientHeight
  });

  // Override collectObjects for precise entity-level marquee selection
  const originalCollectObjects = (canvas as any).collectObjects;
  (canvas as any).collectObjects = function(rect: any, options: any = {}) {
    const candidates = originalCollectObjects.call(this, rect, options);
    if (!candidates || candidates.length === 0) return [];

    const rectObj = {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height
    };

    return candidates.filter((obj: any) => {
      const tl = new fabric.Point(rect.left, rect.top);
      const br = tl.add(new fabric.Point(rect.width, rect.height));
      if (obj.isContainedWithinRect && obj.isContainedWithinRect(tl, br)) {
        return true;
      }
      return isObjectHitByRect(this, obj, rectObj);
    });
  };

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
      ctx.fillStyle = '#cbd5e1';
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

  // Selection change listeners
  canvas.on('selection:created', updateSelectionState);
  canvas.on('selection:updated', updateSelectionState);
  canvas.on('selection:cleared', updateSelectionState);

  // Sync and history on changes
  canvas.on('path:created', (e: any) => {
    if (e.path) {
      e.path.set({ perPixelTargetFind: true });
    }
    if (!isInternalChange) {
      saveHistoryState();
      syncToFirebase();
    }
  });

  canvas.on('object:modified', () => {
    if (!isInternalChange) {
      saveHistoryState();
      syncToFirebase();
    }
  });

  canvas.on('text:editing:exited', (e) => {
    if (!canvas) return;
    const textObj = e.target as any;
    if (!textObj.text.trim() || textObj.text === 'Type here...') {
      canvas.remove(textObj);
      canvas.requestRenderAll();
      saveHistoryState();
      syncToFirebase();
      updateSelectionState();
    }
  });

  // Pan & Zoom via wheel
  canvas.on('mouse:wheel', function(opt) {
    if (!canvas) return;
    const delta = opt.e.deltaY;

    if (opt.e.ctrlKey) {
      let zoom = canvas.getZoom();
      zoom *= 0.999 ** delta;
      if (zoom > 20) zoom = 20;
      if (zoom < 0.05) zoom = 0.05;
      canvas.zoomToPoint({ x: opt.e.offsetX, y: opt.e.offsetY } as fabric.Point, zoom);
      opt.e.preventDefault();
      opt.e.stopPropagation();
    } else if (opt.e.altKey) {
      const vpt = canvas.viewportTransform;
      if (vpt) {
        vpt[4] -= delta;
        canvas.requestRenderAll();
      }
      opt.e.preventDefault();
      opt.e.stopPropagation();
    } else {
      const vpt = canvas.viewportTransform;
      if (vpt) {
        vpt[5] -= delta;
        canvas.requestRenderAll();
      }
      opt.e.preventDefault();
      opt.e.stopPropagation();
    }
  });

  // Unified Mouse Down
  canvas.on('mouse:down', (opt) => {
    if (!canvas) return;
    const e = opt.e as MouseEvent;
    isBrushMenuOpen.value = false;

    // Middle click pan
    if (e.button === 1) {
      isDragging = true;
      canvas.selection = false;
      lastPosX = e.clientX;
      lastPosY = e.clientY;
      return;
    }

    // Right click context menu
    if (e.button === 2) {
      e.preventDefault();
      if (isDrawingMode.value) {
        toggleMode(false);
      }
      const scenePoint = canvas.getScenePoint(e);
      contextMenuScenePoint = { x: scenePoint.x, y: scenePoint.y };

      const target = opt.target || (canvas.findTarget(e) as any)?.target || null;
      const activeObj = canvas.getActiveObject();

      if (activeObj && target && (activeObj === target || (activeObj as any).contains?.(target))) {
        // Kept within existing active selection
      } else if (target) {
        canvas.setActiveObject(target);
        canvas.requestRenderAll();
      }
      updateSelectionState();

      const clientX = Math.min(e.clientX, window.innerWidth - 220);
      const clientY = Math.min(e.clientY, window.innerHeight - 340);
      contextMenu.value = { visible: true, x: clientX, y: clientY };
      return;
    }

    // Left click dismisses context menu
    if (contextMenu.value.visible) {
      contextMenu.value.visible = false;
    }

    if (e.button !== 0) return;

    const scenePoint = canvas.getScenePoint(e);

    // Text tool
    if (currentTool.value === 'text') {
      const text = new fabric.IText('Type here...', {
        left: scenePoint.x,
        top: scenePoint.y,
        fontFamily: 'Inter, sans-serif',
        fontSize: 24,
        fill: activeColor.value,
        perPixelTargetFind: true
      });
      canvas.add(text);
      canvas.setActiveObject(text);
      saveHistoryState();
      syncToFirebase();
      text.enterEditing();
      text.selectAll();
      updateSelectionState();
      // Keep text tool active until user switches tools!
      return;
    }

    // Shapes
    if (['rect', 'circle', 'triangle', 'line'].includes(currentTool.value)) {
      drawingStartPoint = { x: scenePoint.x, y: scenePoint.y };
      const options = {
        left: scenePoint.x,
        top: scenePoint.y,
        fill: 'transparent',
        stroke: activeColor.value,
        strokeWidth: strokeWidth.value,
        originX: 'left' as const,
        originY: 'top' as const,
        selectable: false,
        evented: false,
        perPixelTargetFind: true
      };

      if (currentTool.value === 'rect') drawingObject = new fabric.Rect({ ...options, width: 0, height: 0 });
      else if (currentTool.value === 'circle') drawingObject = new fabric.Circle({ ...options, radius: 0 });
      else if (currentTool.value === 'triangle') drawingObject = new fabric.Triangle({ ...options, width: 0, height: 0 });
      else if (currentTool.value === 'line') drawingObject = new fabric.Line([scenePoint.x, scenePoint.y, scenePoint.x, scenePoint.y], { ...options });

      if (drawingObject) canvas.add(drawingObject);
    }
  });

  // Unified Mouse Move
  canvas.on('mouse:move', (opt) => {
    if (!canvas) return;
    const e = opt.e as MouseEvent;

    if (isDragging) {
      const vpt = canvas.viewportTransform;
      if (vpt) {
        vpt[4] += e.clientX - lastPosX;
        vpt[5] += e.clientY - lastPosY;
        canvas.requestRenderAll();
      }
      lastPosX = e.clientX;
      lastPosY = e.clientY;
      return;
    }

    if (!drawingObject || !drawingStartPoint) return;
    const scenePoint = canvas.getScenePoint(e);

    if (currentTool.value === 'rect' || currentTool.value === 'triangle') {
      drawingObject.set({
        width: Math.abs(scenePoint.x - drawingStartPoint.x),
        height: Math.abs(scenePoint.y - drawingStartPoint.y),
      });
      if (scenePoint.x < drawingStartPoint.x) drawingObject.set({ left: scenePoint.x });
      if (scenePoint.y < drawingStartPoint.y) drawingObject.set({ top: scenePoint.y });
    } else if (currentTool.value === 'circle') {
      const radius = Math.max(Math.abs(scenePoint.x - drawingStartPoint.x), Math.abs(scenePoint.y - drawingStartPoint.y)) / 2;
      drawingObject.set({ radius });
      if (scenePoint.x < drawingStartPoint.x) drawingObject.set({ left: drawingStartPoint.x - radius * 2 });
      if (scenePoint.y < drawingStartPoint.y) drawingObject.set({ top: drawingStartPoint.y - radius * 2 });
    } else if (currentTool.value === 'line') {
      drawingObject.set({ x2: scenePoint.x, y2: scenePoint.y });
    }
    canvas.requestRenderAll();
  });

  // Unified Mouse Up
  canvas.on('mouse:up', (opt) => {
    if (!canvas) return;
    const e = opt.e as MouseEvent;

    if (isDragging) {
      isDragging = false;
      canvas.selection = true;
    }

    if (drawingObject) {
      let isTooSmall = false;
      if (currentTool.value === 'rect' || currentTool.value === 'triangle') {
        isTooSmall = (drawingObject.width || 0) < 5 || (drawingObject.height || 0) < 5;
      } else if (currentTool.value === 'circle') {
        isTooSmall = (drawingObject.radius || 0) < 3;
      } else if (currentTool.value === 'line') {
        const dx = (drawingObject.x2 || 0) - (drawingObject.x1 || 0);
        const dy = (drawingObject.y2 || 0) - (drawingObject.y1 || 0);
        isTooSmall = Math.hypot(dx, dy) < 5;
      }

      if (isTooSmall) {
        canvas.remove(drawingObject);
        canvas.requestRenderAll();
      } else {
        drawingObject.set({ selectable: true, evented: true, perPixelTargetFind: true });
        drawingObject.setCoords();
        canvas.setActiveObject(drawingObject);
        canvas.requestRenderAll();
        saveHistoryState();
        syncToFirebase();
        updateSelectionState();
      }

      drawingObject = null;
      drawingStartPoint = null;
    }
  });

  // Handle resizing
  const resizeObserver = new ResizeObserver(() => {
    if (canvas && wrapperRef.value) {
      canvas.setDimensions({
        width: wrapperRef.value.clientWidth,
        height: wrapperRef.value.clientHeight
      });
      canvas.requestRenderAll();
    }
  });
  resizeObserver.observe(wrapperRef.value);

  // Load initial state
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
  canvas.getObjects().forEach((o: any) => {
    o.set({ perPixelTargetFind: true });
  });
  canvas.requestRenderAll();

  if (historyStack.value[historyStack.value.length - 1] !== json) {
    historyStack.value.push(json);
    if (historyStack.value.length > 50) historyStack.value.shift();
  }

  isInternalChange = false;
};

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

// Context Menu & Selection Actions
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

const pasteSelection = async (targetPoint?: { x: number; y: number }) => {
  if (!canvas || !clipboard) return;

  const clonedObj = await clipboard.clone();
  canvas.discardActiveObject();

  if (targetPoint) {
    clonedObj.set({
      left: targetPoint.x,
      top: targetPoint.y,
      evented: true,
      perPixelTargetFind: true
    });
  } else {
    clonedObj.set({
      left: (clonedObj.left || 0) + 16,
      top: (clonedObj.top || 0) + 16,
      evented: true,
      perPixelTargetFind: true
    });
    clipboard.top = (clipboard.top || 0) + 16;
    clipboard.left = (clipboard.left || 0) + 16;
  }

  if (clonedObj.type === 'activeSelection' || clonedObj.type === 'activeselection') {
    clonedObj.canvas = canvas;
    clonedObj.forEachObject((obj: any) => {
      obj.set({ selectable: true, evented: true, perPixelTargetFind: true });
      canvas?.add(obj);
    });
    clonedObj.setCoords();
  } else {
    clonedObj.set({ selectable: true, evented: true, perPixelTargetFind: true });
    canvas.add(clonedObj);
  }

  canvas.setActiveObject(clonedObj);
  canvas.requestRenderAll();
  saveHistoryState();
  syncToFirebase();
  updateSelectionState();
};

const pasteAtContext = () => {
  pasteSelection(contextMenuScenePoint || undefined);
};

const deleteSelected = () => {
  if (!canvas) return;
  const activeObjects = canvas.getActiveObjects();
  if (activeObjects.length) {
    activeObjects.forEach(obj => canvas?.remove(obj));
    canvas.discardActiveObject();
    canvas.requestRenderAll();
    saveHistoryState();
    syncToFirebase();
    updateSelectionState();
  }
};

const selectAll = () => {
  if (!canvas) return;
  const objects = canvas.getObjects().filter(o => o.selectable && o.visible);
  if (!objects.length) return;
  canvas.discardActiveObject();
  const sel = new fabric.ActiveSelection(objects, { canvas });
  canvas.setActiveObject(sel);
  canvas.requestRenderAll();
  updateSelectionState();
};

const bringToFront = () => {
  if (!canvas) return;
  const activeObj = canvas.getActiveObject();
  if (!activeObj) return;
  if (activeObj.type === 'activeSelection') {
    (activeObj as fabric.ActiveSelection).getObjects().forEach(obj => canvas?.bringObjectToFront(obj));
  } else {
    canvas.bringObjectToFront(activeObj);
  }
  canvas.requestRenderAll();
  saveHistoryState();
  syncToFirebase();
};

const sendToBack = () => {
  if (!canvas) return;
  const activeObj = canvas.getActiveObject();
  if (!activeObj) return;
  if (activeObj.type === 'activeSelection') {
    const objs = [...(activeObj as fabric.ActiveSelection).getObjects()].reverse();
    objs.forEach(obj => canvas?.sendObjectToBack(obj));
  } else {
    canvas.sendObjectToBack(activeObj);
  }
  canvas.requestRenderAll();
  saveHistoryState();
  syncToFirebase();
};

const bringForward = () => {
  if (!canvas) return;
  const activeObj = canvas.getActiveObject();
  if (!activeObj) return;
  if (activeObj.type === 'activeSelection') {
    const objs = [...(activeObj as fabric.ActiveSelection).getObjects()].reverse();
    objs.forEach(obj => canvas?.bringObjectForward(obj));
  } else {
    canvas.bringObjectForward(activeObj);
  }
  canvas.requestRenderAll();
  saveHistoryState();
  syncToFirebase();
};

const sendBackwards = () => {
  if (!canvas) return;
  const activeObj = canvas.getActiveObject();
  if (!activeObj) return;
  if (activeObj.type === 'activeSelection') {
    (activeObj as fabric.ActiveSelection).getObjects().forEach(obj => canvas?.sendObjectBackwards(obj));
  } else {
    canvas.sendObjectBackwards(activeObj);
  }
  canvas.requestRenderAll();
  saveHistoryState();
  syncToFirebase();
};

const groupObjects = () => {
  if (!canvas) return;
  const activeObj = canvas.getActiveObject();
  if (activeObj && activeObj.type === 'activeSelection') {
    const items = (activeObj as fabric.ActiveSelection).getObjects();
    canvas.discardActiveObject();
    items.forEach(item => canvas?.remove(item));
    const group = new fabric.Group(items, {
      canvas,
      subTargetCheck: false,
      perPixelTargetFind: true
    });
    canvas.add(group);
    canvas.setActiveObject(group);
    canvas.requestRenderAll();
    saveHistoryState();
    syncToFirebase();
    updateSelectionState();
  }
};

const ungroupObjects = () => {
  if (!canvas) return;
  const activeObj = canvas.getActiveObject();
  if (activeObj && activeObj.type === 'group') {
    const items = (activeObj as fabric.Group).removeAll();
    canvas.remove(activeObj);
    items.forEach(item => {
      item.set({ selectable: true, evented: true, perPixelTargetFind: true });
      canvas?.add(item);
    });
    const sel = new fabric.ActiveSelection(items, { canvas });
    canvas.setActiveObject(sel);
    canvas.requestRenderAll();
    saveHistoryState();
    syncToFirebase();
    updateSelectionState();
  }
};

const undo = async () => {
  if (!canvas || historyStack.value.length <= 1) return;
  isInternalChange = true;
  historyStack.value.pop(); // remove current state
  const previousState = historyStack.value[historyStack.value.length - 1];
  await canvas.loadFromJSON(previousState);
  canvas.getObjects().forEach((o: any) => {
    o.set({ perPixelTargetFind: true });
  });
  canvas.requestRenderAll();
  syncToFirebase();
  updateSelectionState();
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
      if (img.width && img.width > 800) {
        img.scaleToWidth(800);
      }
      if (canvas && wrapperRef.value) {
        const center = canvas.getVpCenter();
        img.set({
          left: center.x,
          top: center.y,
          originX: 'center',
          originY: 'center',
          perPixelTargetFind: true
        });
        canvas.add(img);
        canvas.setActiveObject(img);
        saveHistoryState();
        syncToFirebase();
        updateSelectionState();
        toggleMode(false);
      }
    });
  };
  reader.readAsDataURL(file);
  target.value = '';
};

const toggleMode = (drawing: boolean) => {
  currentTool.value = drawing ? 'draw' : 'select';
  if (canvas) {
    isDrawingMode.value = drawing;
    canvas.isDrawingMode = drawing;
  }
};

const addShape = (type: any) => {
  currentTool.value = type;
  isDrawingMode.value = false;
  if (canvas) canvas.isDrawingMode = false;
  canvas?.discardActiveObject();
  canvas?.requestRenderAll();
  updateSelectionState();
};

const addText = () => {
  currentTool.value = 'text';
  isDrawingMode.value = false;
  if (canvas) canvas.isDrawingMode = false;
  canvas?.discardActiveObject();
  canvas?.requestRenderAll();
  updateSelectionState();
};

const applyColorToSelected = (color: string) => {
  activeColor.value = color;
  if (!canvas) return;
  const activeObj = canvas.getActiveObject();
  if (activeObj) {
    if (activeObj.isType('path')) {
      activeObj.set({ stroke: color });
    } else if (activeObj.isType('i-text')) {
      activeObj.set({ fill: color });
    } else if (activeObj.isType('rect') || activeObj.isType('circle') || activeObj.isType('triangle')) {
      activeObj.set({ stroke: color });
    }
    canvas.requestRenderAll();
    saveHistoryState();
    syncToFirebase();
  } else if (isDrawingMode.value) {
    updateBrush();
  }
};

const handleSendToChat = async () => {
  if (!canvas) return;
  const dataUrl = getCanvasSnapshot(0.85);
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
  const dataUrl = getCanvasSnapshot(0.7);
  emit('save-state', json, dataUrl);
  hasUnsavedChanges.value = false;
  roomStore.endWhiteboardSession();
  emit('close');
};

const handleCloseRequest = () => {
  if (roomStore.currentRoom?.whiteboardActive) {
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
  const dataUrl = getCanvasSnapshot(0.7);
  emit('save-state', json, dataUrl);
  hasUnsavedChanges.value = false;
  showCloseConfirmModal.value = false;
  emit('close');
};

// Keyboard Shortcuts
const handleKeydown = (e: KeyboardEvent) => {
  const activeObj = canvas?.getActiveObject() as any;
  if (activeObj?.isEditing) return;

  const targetTag = (e.target as HTMLElement)?.tagName?.toLowerCase();
  if (targetTag === 'input' || targetTag === 'textarea') return;

  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (activeObj) {
      e.preventDefault();
      deleteSelected();
    }
  } else if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
    e.preventDefault();
    undo();
  } else if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C')) {
    e.preventDefault();
    copySelection();
  } else if ((e.ctrlKey || e.metaKey) && (e.key === 'x' || e.key === 'X')) {
    e.preventDefault();
    cutSelection();
  } else if ((e.ctrlKey || e.metaKey) && (e.key === 'v' || e.key === 'V')) {
    e.preventDefault();
    pasteSelection();
  } else if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
    e.preventDefault();
    selectAll();
  }
};

const handleWindowClick = () => {
  if (contextMenu.value.visible) {
    contextMenu.value.visible = false;
  }
};

// --- AI Generator ---
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
      scaleY: 2,
      perPixelTargetFind: true
    });
    canvas.add(obj);
    canvas.setActiveObject(obj);
    saveHistoryState();
    syncToFirebase();
    updateSelectionState();
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

onMounted(() => {
  window.addEventListener('keydown', handleKeydown);
  window.addEventListener('click', handleWindowClick);
  if (wrapperRef.value) {
    wrapperRef.value.addEventListener('contextmenu', (e) => e.preventDefault());
  }
  nextTick(() => {
    initFabric();
  });
});

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeydown);
  window.removeEventListener('click', handleWindowClick);
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

    <!-- Right-Click Context Menu -->
    <div
      v-if="contextMenu.visible"
      :style="{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }"
      class="fixed z-50 min-w-[200px] bg-slate-900/95 backdrop-blur-md border border-slate-700/80 rounded-2xl shadow-2xl p-1.5 text-xs text-slate-200 select-none animate-in fade-in zoom-in-95 duration-100"
      @click.stop
    >
      <!-- When selection is active -->
      <template v-if="hasSelection">
        <button
          @click="copySelection(); contextMenu.visible = false"
          class="w-full flex items-center justify-between px-3 py-1.5 rounded-xl hover:bg-slate-800 text-slate-200 hover:text-white transition cursor-pointer"
        >
          <span class="flex items-center gap-2"><Copy class="w-3.5 h-3.5 text-sky-400" /> Copy</span>
          <span class="text-[10px] text-slate-400 font-mono">Ctrl+C</span>
        </button>
        <button
          @click="cutSelection(); contextMenu.visible = false"
          class="w-full flex items-center justify-between px-3 py-1.5 rounded-xl hover:bg-slate-800 text-slate-200 hover:text-white transition cursor-pointer"
        >
          <span class="flex items-center gap-2"><Scissors class="w-3.5 h-3.5 text-amber-400" /> Cut</span>
          <span class="text-[10px] text-slate-400 font-mono">Ctrl+X</span>
        </button>
      </template>

      <!-- Paste (always visible when clipboard has content) -->
      <button
        v-if="clipboard"
        @click="pasteAtContext(); contextMenu.visible = false"
        class="w-full flex items-center justify-between px-3 py-1.5 rounded-xl hover:bg-slate-800 text-slate-200 hover:text-white transition cursor-pointer"
      >
        <span class="flex items-center gap-2"><ClipboardPaste class="w-3.5 h-3.5 text-emerald-400" /> Paste Here</span>
        <span class="text-[10px] text-slate-400 font-mono">Ctrl+V</span>
      </button>

      <div v-if="hasSelection" class="my-1 border-t border-slate-800"></div>

      <!-- Layer Ordering -->
      <template v-if="hasSelection">
        <button
          @click="bringToFront(); contextMenu.visible = false"
          class="w-full flex items-center gap-2 px-3 py-1.5 rounded-xl hover:bg-slate-800 text-slate-200 hover:text-white transition cursor-pointer"
        >
          <BringToFront class="w-3.5 h-3.5 text-indigo-400" /> Bring to Front
        </button>
        <button
          @click="bringForward(); contextMenu.visible = false"
          class="w-full flex items-center gap-2 px-3 py-1.5 rounded-xl hover:bg-slate-800 text-slate-200 hover:text-white transition cursor-pointer"
        >
          <MoveUp class="w-3.5 h-3.5 text-indigo-400" /> Move Forward
        </button>
        <button
          @click="sendBackwards(); contextMenu.visible = false"
          class="w-full flex items-center gap-2 px-3 py-1.5 rounded-xl hover:bg-slate-800 text-slate-200 hover:text-white transition cursor-pointer"
        >
          <MoveDown class="w-3.5 h-3.5 text-indigo-400" /> Move Backward
        </button>
        <button
          @click="sendToBack(); contextMenu.visible = false"
          class="w-full flex items-center gap-2 px-3 py-1.5 rounded-xl hover:bg-slate-800 text-slate-200 hover:text-white transition cursor-pointer"
        >
          <SendToBack class="w-3.5 h-3.5 text-indigo-400" /> Send to Back
        </button>

        <div class="my-1 border-t border-slate-800"></div>

        <!-- Group / Ungroup -->
        <button
          v-if="isMultiSelection"
          @click="groupObjects(); contextMenu.visible = false"
          class="w-full flex items-center gap-2 px-3 py-1.5 rounded-xl hover:bg-slate-800 text-slate-200 hover:text-white transition cursor-pointer"
        >
          <Group class="w-3.5 h-3.5 text-violet-400" /> Group Objects
        </button>
        <button
          v-if="isGroupSelected"
          @click="ungroupObjects(); contextMenu.visible = false"
          class="w-full flex items-center gap-2 px-3 py-1.5 rounded-xl hover:bg-slate-800 text-slate-200 hover:text-white transition cursor-pointer"
        >
          <Ungroup class="w-3.5 h-3.5 text-violet-400" /> Ungroup
        </button>

        <div class="my-1 border-t border-slate-800"></div>

        <!-- Delete -->
        <button
          @click="deleteSelected(); contextMenu.visible = false"
          class="w-full flex items-center justify-between px-3 py-1.5 rounded-xl hover:bg-rose-950/50 text-rose-400 hover:text-rose-300 transition cursor-pointer"
        >
          <span class="flex items-center gap-2"><Trash2 class="w-3.5 h-3.5" /> Delete</span>
          <span class="text-[10px] text-rose-400/70 font-mono">Del</span>
        </button>
      </template>

      <!-- If no object selected -->
      <template v-if="!hasSelection">
        <button
          @click="selectAll(); contextMenu.visible = false"
          class="w-full flex items-center justify-between px-3 py-1.5 rounded-xl hover:bg-slate-800 text-slate-200 hover:text-white transition cursor-pointer"
        >
          <span class="flex items-center gap-2"><MousePointer2 class="w-3.5 h-3.5 text-slate-400" /> Select All</span>
          <span class="text-[10px] text-slate-400 font-mono">Ctrl+A</span>
        </button>
      </template>
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

