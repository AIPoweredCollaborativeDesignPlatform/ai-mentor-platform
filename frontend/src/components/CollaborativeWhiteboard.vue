<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch, nextTick } from 'vue';
import { useRoomStore } from '../stores/room';
import { useAuthStore } from '../stores/auth';
import * as fabric from 'fabric';
import {
  X, Pencil, Image as ImageIcon, Undo2, Trash2, Maximize, Minimize, Check, Loader2, Sparkles, Send, Radio, Settings2, MousePointer2, Type, Square, Circle, Triangle, Minus, Group, Ungroup, BringToFront, SendToBack, MoveUp, MoveDown, Copy, Scissors, ClipboardPaste, AlertTriangle, AlertCircle, RefreshCw, ChevronDown, ChevronUp, StickyNote, MoreHorizontal, Lock, Unlock, HelpCircle
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

// Workspace boundary (3200x2000px)
const WORKSPACE_WIDTH = 3200;
const WORKSPACE_HEIGHT = 2000;

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

// Sticky Notes Configuration & State
interface StickyColorConfig {
  name: string;
  bg: string;
  text: string;
  border: string;
}

const stickyColors: StickyColorConfig[] = [
  { name: 'Yellow', bg: '#fef08a', text: '#854d0e', border: '#fde047' },
  { name: 'Green', bg: '#bbf7d0', text: '#166534', border: '#86efac' },
  { name: 'Blue', bg: '#bae6fd', text: '#075985', border: '#7dd3fc' },
  { name: 'Pink', bg: '#fbcfe8', text: '#9d174d', border: '#f472b6' },
  { name: 'Purple', bg: '#e9d5ff', text: '#6b21a8', border: '#c084fc' },
  { name: 'Orange', bg: '#fed7aa', text: '#9a3412', border: '#fdba74' },
];

const selectedStickyColor = ref<StickyColorConfig>(stickyColors[0]);
const isStickyMenuOpen = ref(false);
const activeStickyNote = ref<any>(null);
const stickyToolbarPosition = ref({ x: 0, y: 0, visible: false });

const isBrushMenuOpen = ref(false);
const currentTool = ref('draw'); // 'select', 'draw', 'text', 'sticky', 'rect', 'circle', 'triangle', 'line'

let isInternalChange = false;
const historyStack = ref<string[]>([]);

// Selection & Context Menu state
let clipboard: any = null;
let contextMenuScenePoint: { x: number; y: number } | null = null;
const contextMenu = ref({ visible: false, x: 0, y: 0 });
const hasSelection = ref(false);
const isMultiSelection = ref(false);
const isGroupSelected = ref(false);
const isObjectLocked = ref(false);

// Group Isolation Mode (Illustrator style)
const isIsolationMode = ref(false);
let isolatedGroup: fabric.Group | null = null;
let isolatedItems: any[] = [];

// Hover highlight & toast & cheatsheet
const isHoveringSend = ref(false);
const toastMsg = ref('');
const showToast = ref(false);
let toastTimer: any = null;
const displayToast = (msg: string) => {
  toastMsg.value = msg;
  showToast.value = true;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { showToast.value = false; }, 2500);
};
const showShortcutsModal = ref(false);

const updateStickyToolbar = () => {
  if (!canvas) {
    activeStickyNote.value = null;
    stickyToolbarPosition.value.visible = false;
    return;
  }
  const active = canvas.getActiveObject() as any;
  if (active && (active.isStickyNote || (active.type === 'textbox' && active.stickyColorConfig))) {
    activeStickyNote.value = active;
    const bound = active.getBoundingRect();
    const vpt = canvas.viewportTransform || [1, 0, 0, 1, 0, 0];
    const zoom = canvas.getZoom();
    const screenX = bound.left * zoom + vpt[4];
    const screenY = bound.top * zoom + vpt[5];
    const screenW = bound.width * zoom;
    stickyToolbarPosition.value = {
      x: screenX + screenW / 2,
      y: Math.max(10, screenY - 50), // Position higher to not block top rotation handle (mtr)
      visible: true
    };
  } else {
    activeStickyNote.value = null;
    stickyToolbarPosition.value.visible = false;
  }
};

const updateSelectionState = () => {
  if (!canvas) {
    hasSelection.value = false;
    isMultiSelection.value = false;
    isGroupSelected.value = false;
    isObjectLocked.value = false;
    activeStickyNote.value = null;
    stickyToolbarPosition.value.visible = false;
    return;
  }
  const active = canvas.getActiveObject() as any;
  hasSelection.value = !!active;
  isMultiSelection.value = active?.type === 'activeSelection';
  isGroupSelected.value = active?.type === 'group';
  isObjectLocked.value = !!(active && active.isLocked);
  updateStickyToolbar();
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

  // Clamps viewport pan to prevent dragging workspace infinitely into the void
  const clampViewportPan = () => {
    if (!canvas || !wrapperRef.value) return;
    const vpt = canvas.viewportTransform;
    if (!vpt) return;
    const zoom = canvas.getZoom();
    const w = wrapperRef.value.clientWidth;
    const h = wrapperRef.value.clientHeight;
    const minX = w - WORKSPACE_WIDTH * zoom - 150;
    const maxX = 150;
    const minY = h - WORKSPACE_HEIGHT * zoom - 150;
    const maxY = 150;
    vpt[4] = Math.min(maxX, Math.max(minX, vpt[4]));
    vpt[5] = Math.min(maxY, Math.max(minY, vpt[5]));
  };

  // Render workspace background with dark gray mask outside boundary
  canvas.on('before:render', () => {
    if (!canvas) return;
    const ctx = canvas.getContext();
    if (!ctx) return;
    const width = canvas.getWidth();
    const height = canvas.getHeight();

    // 1. Fill outer space with dark slate mask
    ctx.save();
    ctx.fillStyle = '#1e293b';
    ctx.fillRect(0, 0, width, height);

    // 2. Calculate workspace boundary on screen
    const vpt = canvas.viewportTransform || [1, 0, 0, 1, 0, 0];
    const zoom = canvas.getZoom();
    const screenX = vpt[4];
    const screenY = vpt[5];
    const screenW = WORKSPACE_WIDTH * zoom;
    const screenH = WORKSPACE_HEIGHT * zoom;

    // 3. Fill bounded workspace with light background
    ctx.fillStyle = '#f8fafc';
    ctx.fillRect(screenX, screenY, screenW, screenH);

    // 4. Draw dot grid ONLY inside workspace boundary
    const baseSpacing = 28;
    const screenSpacing = baseSpacing * zoom;

    if (screenSpacing >= 8) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(screenX, screenY, screenW, screenH);
      ctx.clip();

      ctx.fillStyle = '#cbd5e1';
      const dotRadius = Math.max(0.75, Math.min(2.0, 1.1 * Math.sqrt(zoom)));

      const startX = screenX + (((0 - screenX) % screenSpacing + screenSpacing) % screenSpacing);
      const startY = screenY + (((0 - screenY) % screenSpacing + screenSpacing) % screenSpacing);

      for (let x = startX; x < screenX + screenW; x += screenSpacing) {
        for (let y = startY; y < screenY + screenH; y += screenSpacing) {
          ctx.beginPath();
          ctx.arc(x, y, dotRadius, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.restore();
    }

    // 5. Draw subtle workspace boundary border
    ctx.strokeStyle = '#94a3b8';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(screenX, screenY, screenW, screenH);

    ctx.restore();
  });

  updateBrush();
  saveHistoryState(); // Initial empty state

  // Center workspace in initial canvas view
  if (wrapperRef.value) {
    const w = wrapperRef.value.clientWidth;
    const h = wrapperRef.value.clientHeight;
    const vpt = canvas.viewportTransform || [1, 0, 0, 1, 0, 0];
    vpt[4] = Math.round((w - WORKSPACE_WIDTH) / 2);
    vpt[5] = Math.round((h - WORKSPACE_HEIGHT) / 2);
    canvas.setViewportTransform(vpt);
  }

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
    if (!textObj.text?.trim() || textObj.text === 'Type here...' || textObj.text === 'Type note here...') {
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
      if (zoom > 5) zoom = 5;
      if (zoom < 0.2) zoom = 0.2;
      canvas.zoomToPoint({ x: opt.e.offsetX, y: opt.e.offsetY } as fabric.Point, zoom);
      clampViewportPan();
      opt.e.preventDefault();
      opt.e.stopPropagation();
    } else if (opt.e.altKey) {
      const vpt = canvas.viewportTransform;
      if (vpt) {
        vpt[4] -= delta;
        clampViewportPan();
        canvas.requestRenderAll();
      }
      opt.e.preventDefault();
      opt.e.stopPropagation();
    } else {
      const vpt = canvas.viewportTransform;
      if (vpt) {
        vpt[5] -= delta;
        clampViewportPan();
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

    // Sticky Note tool
    if (currentTool.value === 'sticky') {
      spawnStickyNote(scenePoint.x, scenePoint.y);
      return;
    }

    // Text tool
    if (currentTool.value === 'text') {
      const target = opt.target || (canvas.findTarget(e) as any);
      if (target && (target.type === 'i-text' || target.type === 'text' || target.type === 'textbox')) {
        canvas.setActiveObject(target);
        if ((target as any).enterEditing) {
          (target as any).enterEditing();
          (target as any).selectAll?.();
        }
        canvas.requestRenderAll();
        updateSelectionState();
        return;
      }

      const text = new fabric.IText('Type here...', {
        left: scenePoint.x,
        top: scenePoint.y,
        originX: 'left',
        originY: 'bottom',
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
      return;
    }

    // Shapes
    if (['rect', 'circle', 'triangle', 'line'].includes(currentTool.value)) {
      canvas.selection = false;
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
      else if (currentTool.value === 'circle') drawingObject = new fabric.Ellipse({ ...options, originX: 'center', originY: 'center', rx: 0, ry: 0 });
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
        clampViewportPan();
        canvas.requestRenderAll();
      }
      lastPosX = e.clientX;
      lastPosY = e.clientY;
      return;
    }

    if (!drawingObject || !drawingStartPoint) return;
    const scenePoint = canvas.getScenePoint(e);

    if (currentTool.value === 'rect' || currentTool.value === 'triangle') {
      const left = Math.min(scenePoint.x, drawingStartPoint.x);
      const top = Math.min(scenePoint.y, drawingStartPoint.y);
      const width = Math.abs(scenePoint.x - drawingStartPoint.x);
      const height = Math.abs(scenePoint.y - drawingStartPoint.y);
      drawingObject.set({ left, top, width, height });
    } else if (currentTool.value === 'circle') {
      const minX = Math.min(scenePoint.x, drawingStartPoint.x);
      const minY = Math.min(scenePoint.y, drawingStartPoint.y);
      const rx = Math.abs(scenePoint.x - drawingStartPoint.x) / 2;
      const ry = Math.abs(scenePoint.y - drawingStartPoint.y) / 2;
      drawingObject.set({
        left: minX + rx,
        top: minY + ry,
        rx,
        ry
      });
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
      canvas.selection = currentTool.value === 'select';
    }

    if (drawingObject) {
      let isTooSmall = false;
      if (currentTool.value === 'rect' || currentTool.value === 'triangle') {
        isTooSmall = (drawingObject.width || 0) < 5 || (drawingObject.height || 0) < 5;
      } else if (currentTool.value === 'circle') {
        isTooSmall = (drawingObject.rx || 0) < 3 || (drawingObject.ry || 0) < 3;
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

  // Double click for sticky notes inline editing or group isolation mode
  canvas.on('mouse:dblclick', (opt) => {
    const target = opt.target as any;
    if (!target) return;
    if (target.isStickyNote && target.enterEditing) {
      target.enterEditing();
      return;
    }
    if (target.type === 'group' && !target.isStickyNote && !isIsolationMode.value) {
      enterGroupIsolation(target as fabric.Group);
    }
  });

  // Clamp moving objects within workspace boundary
  canvas.on('object:moving', (e: any) => {
    const obj = e.target;
    if (obj) {
      const bound = obj.getBoundingRect(true);
      if (obj.left < 0) obj.left = 0;
      if (obj.top < 0) obj.top = 0;
      if (obj.left + (bound.width || 0) > WORKSPACE_WIDTH) {
        obj.left = Math.max(0, WORKSPACE_WIDTH - (bound.width || 0));
      }
      if (obj.top + (bound.height || 0) > WORKSPACE_HEIGHT) {
        obj.top = Math.max(0, WORKSPACE_HEIGHT - (bound.height || 0));
      }
    }
    updateStickyToolbar();
  });
  canvas.on('object:scaling', updateStickyToolbar);
  canvas.on('object:rotating', updateStickyToolbar);

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

// Sticky Note Actions (Native unified fabric.Textbox with instant typing mode)
const spawnStickyNote = (x: number, y: number, colorCfg = selectedStickyColor.value) => {
  if (!canvas) return;
  const size = 180;
  const note = new fabric.Textbox('Type note here...', {
    left: x - size / 2,
    top: y - size / 2,
    width: size,
    fontSize: 15,
    fontFamily: 'Inter, sans-serif',
    backgroundColor: colorCfg.bg,
    fill: colorCfg.text,
    textAlign: 'left',
    splitByGrapheme: true,
    padding: 14,
    rx: 0,
    ry: 0,
    strokeWidth: 0,
    shadow: new fabric.Shadow({
      color: 'rgba(0, 0, 0, 0.25)',
      blur: 4,
      offsetX: 3,
      offsetY: 4
    }),
    perPixelTargetFind: true,
    lockUniScaling: true
  });

  (note as any).isStickyNote = true;
  (note as any).stickyColorConfig = colorCfg;

  canvas.add(note);
  canvas.setActiveObject(note);
  canvas.requestRenderAll();
  saveHistoryState();
  syncToFirebase();
  updateSelectionState();

  // Instant typing mode without needing double-click
  note.enterEditing();
  note.selectAll();
  // Remains on currentTool = 'sticky' for consecutive placement!
};

const changeStickyNoteColor = (note: any, colorCfg: StickyColorConfig) => {
  if (!canvas || !note) return;
  note.set({
    backgroundColor: colorCfg.bg,
    fill: colorCfg.text
  });
  note.stickyColorConfig = colorCfg;
  note.dirty = true;
  canvas.requestRenderAll();
  saveHistoryState();
  syncToFirebase();
  updateStickyToolbar();
};

const duplicateStickyNote = async (note: any) => {
  if (!canvas || !note) return;
  const cloned = await note.clone();
  cloned.set({
    left: (note.left || 0) + 24,
    top: (note.top || 0) + 24,
    evented: true,
    perPixelTargetFind: true
  });
  (cloned as any).isStickyNote = true;
  (cloned as any).stickyColorConfig = (note as any).stickyColorConfig;
  canvas.add(cloned);
  canvas.setActiveObject(cloned);
  canvas.requestRenderAll();
  saveHistoryState();
  syncToFirebase();
  updateSelectionState();
};

// Group Isolation Mode Actions
const enterGroupIsolation = (group: fabric.Group) => {
  if (!canvas || isIsolationMode.value) return;
  isIsolationMode.value = true;
  isolatedGroup = group;

  // Dim all other canvas objects
  canvas.getObjects().forEach((o: any) => {
    if (o !== group) {
      o._origOpacity = o.opacity ?? 1;
      o._origSelectable = o.selectable ?? true;
      o._origEvented = o.evented ?? true;
      o.set({ opacity: 0.2, selectable: false, evented: false });
    }
  });

  // Extract items from group onto canvas
  isolatedItems = group.removeAll();
  canvas.remove(group);
  isolatedItems.forEach(item => {
    item.set({ selectable: true, evented: true, perPixelTargetFind: true });
    canvas?.add(item);
  });

  canvas.requestRenderAll();
  updateSelectionState();
};

const exitGroupIsolation = () => {
  if (!canvas || !isIsolationMode.value) return;

  // Restore opacity and interaction for non-isolated objects
  canvas.getObjects().forEach((o: any) => {
    if (!isolatedItems.includes(o)) {
      o.set({
        opacity: o._origOpacity ?? 1,
        selectable: o._origSelectable ?? true,
        evented: o._origEvented ?? true
      });
    }
  });

  // Re-bundle isolated items back into group
  isolatedItems.forEach(item => canvas?.remove(item));
  const newGroup = new fabric.Group(isolatedItems, {
    canvas,
    subTargetCheck: false,
    perPixelTargetFind: true
  });
  canvas.add(newGroup);
  canvas.setActiveObject(newGroup);
  canvas.requestRenderAll();

  isIsolationMode.value = false;
  isolatedGroup = null;
  isolatedItems = [];
  saveHistoryState();
  syncToFirebase();
  updateSelectionState();
};

// Object Lock Action
const toggleLockSelected = () => {
  if (!canvas) return;
  const activeObj = canvas.getActiveObject() as any;
  if (!activeObj) return;
  const newLocked = !activeObj.isLocked;
  activeObj.set({
    lockMovementX: newLocked,
    lockMovementY: newLocked,
    lockRotation: newLocked,
    lockScalingX: newLocked,
    lockScalingY: newLocked,
    hasControls: !newLocked,
    isLocked: newLocked
  });
  isObjectLocked.value = newLocked;
  canvas.requestRenderAll();
  saveHistoryState();
  syncToFirebase();
};

// Quick save action (Ctrl+S)
const handleQuickSave = () => {
  triggerAutoSaveAsAsset();
  displayToast('Whiteboard saved to Room Album');
};

const addSticky = (color?: StickyColorConfig) => {
  if (color) selectedStickyColor.value = color;
  currentTool.value = 'sticky';
  isDrawingMode.value = false;
  if (canvas) {
    canvas.isDrawingMode = false;
    canvas.selection = false;
    canvas.discardActiveObject();
    canvas.requestRenderAll();
  }
  updateSelectionState();
};

// Clipboard / Paste Actions
const insertPastedText = (text: string, point?: { x: number; y: number }) => {
  if (!canvas || !text) return;
  const targetPoint = point || canvas.getVpCenter();
  const textObj = new fabric.IText(text, {
    left: targetPoint.x,
    top: targetPoint.y,
    originX: 'left',
    originY: 'bottom',
    fontFamily: 'Inter, sans-serif',
    fontSize: 22,
    fill: activeColor.value,
    perPixelTargetFind: true
  });
  canvas.add(textObj);
  canvas.setActiveObject(textObj);
  canvas.requestRenderAll();
  saveHistoryState();
  syncToFirebase();
  updateSelectionState();
  toggleMode(false);
};

const insertPastedImage = (fileOrBlob: Blob, point?: { x: number; y: number }) => {
  if (!canvas) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    const imgUrl = e.target?.result as string;
    fabric.Image.fromURL(imgUrl).then(img => {
      if (!canvas) return;
      if (img.width && img.width > 800) {
        img.scaleToWidth(800);
      }
      const targetPoint = point || canvas.getVpCenter();
      img.set({
        left: targetPoint.x,
        top: targetPoint.y,
        originX: 'center',
        originY: 'center',
        perPixelTargetFind: true
      });
      canvas.add(img);
      canvas.setActiveObject(img);
      canvas.requestRenderAll();
      saveHistoryState();
      syncToFirebase();
      updateSelectionState();
      toggleMode(false);
    });
  };
  reader.readAsDataURL(fileOrBlob);
};

const handlePasteAction = async (targetPoint?: { x: number; y: number }) => {
  // 1. Internal Fabric clipboard
  if (clipboard) {
    await pasteSelection(targetPoint);
    return;
  }
  // 2. System clipboard (text or image)
  try {
    if (navigator.clipboard?.read) {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        for (const type of item.types) {
          if (type.startsWith('image/')) {
            const blob = await item.getType(type);
            insertPastedImage(blob, targetPoint);
            return;
          }
        }
      }
    }
    if (navigator.clipboard?.readText) {
      const text = await navigator.clipboard.readText();
      if (text.trim()) {
        insertPastedText(text.trim(), targetPoint);
        return;
      }
    }
  } catch (err) {
    console.warn('System clipboard read access not available:', err);
  }
};

const handleGlobalPaste = (e: ClipboardEvent) => {
  const targetTag = (e.target as HTMLElement)?.tagName?.toLowerCase();
  if (targetTag === 'input' || targetTag === 'textarea') return;
  if (!canvas) return;

  const items = e.clipboardData?.items;
  if (items) {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type.indexOf('image') !== -1) {
        const blob = item.getAsFile();
        if (blob) {
          e.preventDefault();
          insertPastedImage(blob);
          return;
        }
      }
    }
  }
  const text = e.clipboardData?.getData('text');
  if (text && text.trim()) {
    e.preventDefault();
    insertPastedText(text.trim());
  }
};

const pasteAtContext = () => {
  handlePasteAction(contextMenuScenePoint || undefined);
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
    canvas.selection = !drawing;
  }
};

const addShape = (type: any) => {
  currentTool.value = type;
  isDrawingMode.value = false;
  if (canvas) {
    canvas.isDrawingMode = false;
    canvas.selection = false;
  }
  canvas?.discardActiveObject();
  canvas?.requestRenderAll();
  updateSelectionState();
};

const addText = () => {
  currentTool.value = 'text';
  isDrawingMode.value = false;
  if (canvas) {
    canvas.isDrawingMode = false;
    canvas.selection = false;
  }
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
  displayToast('Viewport image sent to chat');
  // Keeps whiteboard open for continuous drawing!
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

  // ESC exits Group Isolation Mode
  if (e.key === 'Escape') {
    if (isIsolationMode.value) {
      e.preventDefault();
      exitGroupIsolation();
      return;
    }
  }

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
    if (clipboard) {
      e.preventDefault();
      pasteSelection();
    }
  } else if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
    e.preventDefault();
    selectAll();
  } else if ((e.ctrlKey || e.metaKey) && (e.key === 'g' || e.key === 'G')) {
    e.preventDefault();
    if (e.shiftKey) {
      ungroupObjects();
    } else {
      groupObjects();
    }
  } else if ((e.ctrlKey || e.metaKey) && (e.key === 'l' || e.key === 'L')) {
    e.preventDefault();
    toggleLockSelected();
  } else if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
    e.preventDefault();
    handleQuickSave();
  }
};

const handleWindowClick = () => {
  if (contextMenu.value.visible) {
    contextMenu.value.visible = false;
  }
};

const triggerAutoSaveAsAsset = async () => {
  if (!canvas) return;
  const json = JSON.stringify(canvas.toJSON());
  const dataUrl = getCanvasSnapshot(0.7);
  emit('save-state', json, dataUrl);
  hasUnsavedChanges.value = false;
};

const handleBeforeUnload = (e: BeforeUnloadEvent) => {
  if (roomStore.currentRoom?.whiteboardActive && roomStore.currentRoom?.whiteboardHostUid === authStore.uid) {
    triggerAutoSaveAsAsset();
    return;
  }
  if (hasUnsavedChanges.value) {
    e.preventDefault();
    e.returnValue = '';
  }
};

defineExpose({
  hasUnsavedChanges,
  showCloseConfirmModal,
  triggerAutoSaveAsAsset,
  handleStopBroadcast,
  getCanvasSnapshot,
  getCanvasJson: () => canvas ? JSON.stringify(canvas.toJSON()) : ''
});

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

let aiAbortController: AbortController | null = null;
const abortAiGeneration = () => {
  if (aiAbortController) {
    aiAbortController.abort();
    aiAbortController = null;
  }
  isGeneratingSvg.value = false;
};

const generateAIObject = async () => {
  if (!aiPrompt.value.trim() || !canvas || isGeneratingSvg.value) return;
  const currentPrompt = aiPrompt.value.trim();
  lastFailedPrompt.value = currentPrompt;
  isGeneratingSvg.value = true;
  aiError.value = null;
  showAiErrorDetails.value = false;
  aiAbortController = new AbortController();

  try {
    const svgString = await generateSvgForWhiteboard(currentPrompt, roomStore.currentRoom!.mentorConfig, aiAbortController.signal);
    const { objects, options } = await fabric.loadSVGFromString(svgString);
    if (!canvas) return;
    const validObjects = objects.filter((o): o is fabric.FabricObject => o !== null);
    const obj = fabric.util.groupSVGElements(validObjects, options);

    // Natural bounding box calculation with min 140px, max 360px constraint
    const bound = obj.getBoundingRect ? obj.getBoundingRect() : { width: obj.width || 200, height: obj.height || 200 };
    const maxDim = Math.max(bound.width || 200, bound.height || 200);
    let targetScale = 1;
    if (maxDim > 360) {
      targetScale = 360 / maxDim;
    } else if (maxDim < 140) {
      targetScale = 140 / maxDim;
    }

    const center = canvas.getVpCenter();
    obj.set({
      left: center.x,
      top: center.y,
      originX: 'center',
      originY: 'center',
      scaleX: targetScale,
      scaleY: targetScale,
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
    if (e?.message?.includes('aborted') || e?.name === 'AbortError') return;
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
    aiAbortController = null;
  }
};

const handleContextMenuCapture = (e: MouseEvent) => {
  e.preventDefault();
  e.stopPropagation();
};

onMounted(() => {
  window.addEventListener('keydown', handleKeydown);
  window.addEventListener('click', handleWindowClick);
  window.addEventListener('paste', handleGlobalPaste);
  window.addEventListener('beforeunload', handleBeforeUnload);
  if (wrapperRef.value) {
    wrapperRef.value.addEventListener('contextmenu', handleContextMenuCapture, { capture: true });
  }
  nextTick(() => {
    initFabric();
  });
});

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeydown);
  window.removeEventListener('click', handleWindowClick);
  window.removeEventListener('paste', handleGlobalPaste);
  window.removeEventListener('beforeunload', handleBeforeUnload);
  if (wrapperRef.value) {
    wrapperRef.value.removeEventListener('contextmenu', handleContextMenuCapture, { capture: true });
  }
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

    <!-- Group Isolation Mode Top Floating Banner -->
    <div
      v-if="isIsolationMode"
      class="absolute top-4 left-1/2 -translate-x-1/2 z-30 flex items-center gap-3 px-4 py-2 bg-slate-900/95 border border-indigo-500/80 rounded-2xl shadow-2xl backdrop-blur-md animate-in fade-in zoom-in-95"
    >
      <div class="flex items-center gap-2 text-indigo-300 font-semibold text-xs">
        <Group class="w-4 h-4 text-indigo-400" />
        <span>Group Isolation Mode</span>
        <span class="text-slate-400 font-normal hidden sm:inline">(Press ESC or Exit to return)</span>
      </div>
      <button
        @click="exitGroupIsolation"
        class="px-2.5 py-1 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs transition cursor-pointer"
      >
        Exit Isolation
      </button>
    </div>
    
    <div class="absolute top-4 right-4 z-10 flex items-center gap-2">
      <button v-if="roomStore.currentRoom?.whiteboardActive && roomStore.currentRoom?.whiteboardHostUid === authStore.uid" @click="handleStopBroadcast()" class="px-3 py-1.5 rounded-xl bg-rose-500/90 hover:bg-rose-600 text-white shadow-sm transition text-xs font-semibold flex items-center gap-1 cursor-pointer">
        <X class="w-3.5 h-3.5" /> Stop Broadcast
      </button>
      <button v-if="!roomStore.currentRoom?.whiteboardActive" @click="handleBroadcast" class="px-3 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white shadow-sm transition text-xs font-semibold flex items-center gap-1 cursor-pointer">
        <Radio class="w-3.5 h-3.5" /> Broadcast
      </button>
      <button @click="showShortcutsModal = true" class="p-1.5 rounded-xl bg-white/90 hover:bg-white text-slate-600 hover:text-indigo-600 shadow-sm transition cursor-pointer" title="Shortcuts Cheatsheet (?)">
        <HelpCircle class="w-4 h-4" />
      </button>
      <button @click="handleCloseRequest" class="p-1.5 rounded-xl bg-white/90 hover:bg-white text-slate-500 hover:text-slate-700 shadow-sm transition cursor-pointer" title="Close Panel">
        <X class="w-4 h-4" />
      </button>
    </div>

    <!-- Quick Save & Action Toast Notification -->
    <transition
      enter-active-class="transition duration-200 ease-out"
      enter-from-class="opacity-0 -translate-y-2"
      enter-to-class="opacity-100 translate-y-0"
      leave-active-class="transition duration-150 ease-in"
      leave-from-class="opacity-100 translate-y-0"
      leave-to-class="opacity-0 -translate-y-2"
    >
      <div v-if="showToast" class="absolute top-16 left-1/2 -translate-x-1/2 z-40 px-4 py-2 bg-slate-900/95 border border-emerald-500/60 text-emerald-300 text-xs font-semibold rounded-2xl shadow-2xl flex items-center gap-2 backdrop-blur-md">
        <Check class="w-4 h-4 text-emerald-400" />
        <span>{{ toastMsg }}</span>
      </div>
    </transition>

    <!-- Canvas Wrapper with glowing Send viewport border on hover -->
    <div
      ref="wrapperRef"
      class="flex-1 w-full h-full relative cursor-crosshair transition-all duration-300"
      :class="{ 'ring-4 ring-sky-400/80 shadow-[0_0_35px_rgba(56,189,248,0.35)]': isHoveringSend }"
    >
      <canvas ref="canvasRef" class="w-full h-full touch-none"></canvas>

      <!-- Floating Quick-Action Bar above Selected Sticky Note -->
      <div
        v-if="stickyToolbarPosition.visible && activeStickyNote"
        class="absolute z-30 flex items-center gap-1.5 p-1.5 bg-slate-900/95 backdrop-blur-md border border-slate-700 rounded-xl shadow-2xl transition-all animate-in fade-in zoom-in-95 pointer-events-auto"
        :style="{
          left: `${stickyToolbarPosition.x}px`,
          top: `${stickyToolbarPosition.y}px`,
          transform: 'translate(-50%, -100%)'
        }"
      >
        <div class="flex items-center gap-1 px-1">
          <button
            v-for="color in stickyColors"
            :key="color.name"
            @click="changeStickyNoteColor(activeStickyNote, color)"
            class="w-4 h-4 rounded-full border border-black/20 hover:scale-125 transition transform cursor-pointer"
            :style="{ backgroundColor: color.bg }"
            :title="color.name"
          ></button>
        </div>
        <div class="w-px h-4 bg-slate-700"></div>
        <button
          @click="duplicateStickyNote(activeStickyNote)"
          class="p-1 hover:bg-slate-800 text-slate-300 hover:text-white rounded-lg transition cursor-pointer"
          title="Duplicate Note"
        >
          <Copy class="w-3.5 h-3.5" />
        </button>
        <button
          @click="deleteSelected"
          class="p-1 hover:bg-rose-950/60 text-rose-400 hover:text-rose-300 rounded-lg transition cursor-pointer"
          title="Delete Note"
        >
          <Trash2 class="w-3.5 h-3.5" />
        </button>
      </div>
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
      <div class="flex flex-col gap-2 w-[190px] sm:w-[240px]">
        <div v-if="isGeneratingSvg" class="h-11 sm:h-12 px-3 bg-slate-900/95 text-sky-400 text-xs font-medium rounded-2xl flex items-center justify-between gap-2 backdrop-blur border border-slate-700 shadow-xl">
          <span class="flex items-center gap-1.5 min-w-0 truncate">
            <Loader2 class="w-4 h-4 animate-spin text-sky-400 shrink-0" />
            <span class="truncate">Generating...</span>
          </span>
          <button
            @click="abortAiGeneration"
            class="px-2.5 py-1 rounded-xl bg-rose-600 hover:bg-rose-500 text-white text-[11px] font-semibold transition cursor-pointer shrink-0"
          >
            Stop
          </button>
        </div>
        <form v-else @submit.prevent="generateAIObject" class="flex items-center h-11 sm:h-12 bg-white/95 backdrop-blur-md rounded-2xl shadow-xl border border-slate-200 p-1">
          <input v-model="aiPrompt" type="text" placeholder="Generate icon, chart..." class="flex-1 bg-transparent px-3 py-1.5 text-xs focus:outline-none text-slate-700 placeholder-slate-400 min-w-0" />
          <button type="submit" :disabled="!aiPrompt.trim()" class="p-2 rounded-xl bg-indigo-100 text-indigo-600 hover:bg-indigo-200 transition disabled:opacity-50 disabled:cursor-not-allowed shrink-0 cursor-pointer">
            <Sparkles class="w-4 h-4" />
          </button>
        </form>
      </div>

      <!-- Main Tools -->
      <div class="h-11 sm:h-12 bg-white/95 backdrop-blur-md rounded-2xl shadow-xl border border-slate-200 p-1.5 sm:p-2 flex items-center gap-1 sm:gap-2">
        <button @click="toggleMode(false)" class="p-2 rounded-xl transition cursor-pointer" :class="currentTool === 'select' ? 'bg-indigo-100 text-indigo-600' : 'hover:bg-slate-100 text-slate-500'" title="Select / Move">
          <MousePointer2 class="w-4 h-4" />
        </button>
        
        <div class="relative">
          <button @click="toggleMode(true); isBrushMenuOpen = !isBrushMenuOpen" class="p-2 rounded-xl transition flex items-center gap-1 cursor-pointer" :class="currentTool !== 'select' && currentTool !== 'text' && currentTool !== 'sticky' ? 'bg-indigo-100 text-indigo-600' : 'hover:bg-slate-100 text-slate-500'" title="Draw & Shapes">
            <Pencil class="w-4 h-4" />
          </button>
          
          <div v-if="isBrushMenuOpen && isDrawingMode" class="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 bg-white rounded-xl shadow-xl border border-slate-200 p-3 flex flex-col gap-3 min-w-[140px]">
            <div class="flex items-center justify-between gap-1">
              <button v-for="size in strokeSizes" :key="size.value" @click="strokeWidth = size.value; isBrushMenuOpen = false" class="px-2 py-1 rounded-lg text-[10px] font-bold transition flex-1 cursor-pointer" :class="strokeWidth === size.value ? 'bg-indigo-100 text-indigo-700' : 'text-slate-400 hover:text-slate-600 bg-slate-50'">
                {{ size.label }}
              </button>
            </div>
            <div class="h-px bg-slate-100"></div>
            <div class="flex items-center gap-1 justify-between">
              <button @click="addShape('rect')" class="p-1.5 hover:bg-slate-100 rounded text-slate-500 cursor-pointer" title="Rectangle"><Square class="w-4 h-4" /></button>
              <button @click="addShape('circle')" class="p-1.5 hover:bg-slate-100 rounded text-slate-500 cursor-pointer" title="Circle / Ellipse"><Circle class="w-4 h-4" /></button>
              <button @click="addShape('triangle')" class="p-1.5 hover:bg-slate-100 rounded text-slate-500 cursor-pointer" title="Triangle"><Triangle class="w-4 h-4" /></button>
              <button @click="addShape('line')" class="p-1.5 hover:bg-slate-100 rounded text-slate-500 cursor-pointer" title="Line"><Minus class="w-4 h-4" /></button>
            </div>
          </div>
        </div>
        
        <button @click="addText" class="p-2 rounded-xl transition cursor-pointer" :class="currentTool === 'text' ? 'bg-indigo-100 text-indigo-600' : 'hover:bg-slate-100 text-slate-500'" title="Add Text">
          <Type class="w-4 h-4" />
        </button>

        <!-- Sticky Note Tool -->
        <div class="relative">
          <button
            @click="addSticky(); isStickyMenuOpen = !isStickyMenuOpen"
            class="p-2 rounded-xl transition flex items-center gap-1 cursor-pointer"
            :class="currentTool === 'sticky' ? 'bg-indigo-100 text-indigo-600' : 'hover:bg-slate-100 text-slate-500'"
            title="Sticky Note (便條紙)"
          >
            <StickyNote class="w-4 h-4" />
          </button>
          <div
            v-if="isStickyMenuOpen"
            class="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 bg-white rounded-xl shadow-xl border border-slate-200 p-2 flex items-center gap-1.5 z-20 min-w-max"
          >
            <button
              v-for="color in stickyColors"
              :key="color.name"
              @click="addSticky(color); isStickyMenuOpen = false"
              class="w-5 h-5 rounded-full border-2 transition transform hover:scale-110 cursor-pointer"
              :class="selectedStickyColor.name === color.name ? 'border-indigo-500 scale-110 shadow-sm' : 'border-black/10 hover:border-black/30'"
              :style="{ backgroundColor: color.bg }"
              :title="color.name"
            ></button>
          </div>
        </div>
        
        <div class="w-px h-6 bg-slate-200 mx-1 hidden sm:block"></div>
        
        <div class="flex items-center gap-1">
          <button v-for="color in colors" :key="color" @click="applyColorToSelected(color)" class="w-4 h-4 sm:w-5 sm:h-5 rounded-full border-2 transition transform hover:scale-110 cursor-pointer" :class="activeColor === color ? 'border-indigo-400 scale-110 shadow-sm' : 'border-transparent opacity-80 hover:opacity-100'" :style="{ backgroundColor: color }"></button>
        </div>
        
        <div class="w-px h-6 bg-slate-200 mx-1 hidden sm:block"></div>
        
        <div class="flex items-center gap-1">
          <input ref="fileInputRef" type="file" accept="image/*" class="hidden" @change="handleImageUpload" />
          <button @click="fileInputRef?.click()" class="p-1.5 rounded-xl hover:bg-slate-100 text-slate-500 transition cursor-pointer" title="Add Image"><ImageIcon class="w-4 h-4" /></button>
          <button @click="undo" class="p-1.5 rounded-xl hover:bg-slate-100 text-slate-500 transition cursor-pointer" title="Undo (Ctrl+Z)" :disabled="historyStack.length <= 1" :class="{'opacity-50 cursor-not-allowed': historyStack.length <= 1}"><Undo2 class="w-4 h-4" /></button>
          <button @click="deleteSelected" class="p-1.5 rounded-xl hover:bg-rose-100 text-rose-500 transition cursor-pointer" title="Delete Selected (Del)"><Trash2 class="w-4 h-4" /></button>
        </div>
        
        <div class="w-px h-6 bg-slate-200 mx-1"></div>
        
        <button
          @click="handleSendToChat"
          @mouseenter="isHoveringSend = true"
          @mouseleave="isHoveringSend = false"
          class="p-1.5 px-3 rounded-xl bg-sky-500 hover:bg-sky-600 text-white transition flex items-center gap-1.5 text-xs font-medium cursor-pointer shadow-xs"
          title="Send viewport image to chat"
        >
          <Send class="w-3.5 h-3.5" /> <span class="hidden sm:inline">Send</span>
        </button>
      </div>
    </div>

    <!-- Right-Click Context Menu -->
    <div
      v-if="contextMenu.visible"
      :style="{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }"
      class="fixed z-50 min-w-[210px] bg-slate-900/95 backdrop-blur-md border border-slate-700/80 rounded-2xl shadow-2xl p-1.5 text-xs text-slate-200 select-none animate-in fade-in zoom-in-95 duration-100"
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
        <button
          @click="toggleLockSelected(); contextMenu.visible = false"
          class="w-full flex items-center justify-between px-3 py-1.5 rounded-xl hover:bg-slate-800 text-slate-200 hover:text-white transition cursor-pointer"
        >
          <span class="flex items-center gap-2">
            <component :is="isObjectLocked ? Unlock : Lock" class="w-3.5 h-3.5" :class="isObjectLocked ? 'text-amber-400' : 'text-slate-400'" />
            {{ isObjectLocked ? 'Unlock Object' : 'Lock Object' }}
          </span>
          <span class="text-[10px] text-slate-400 font-mono">Ctrl+L</span>
        </button>
      </template>

      <!-- Paste (always visible by default) -->
      <button
        @click="handlePasteAction(contextMenuScenePoint || undefined); contextMenu.visible = false"
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
          class="w-full flex items-center justify-between px-3 py-1.5 rounded-xl hover:bg-slate-800 text-slate-200 hover:text-white transition cursor-pointer"
        >
          <span class="flex items-center gap-2"><Group class="w-3.5 h-3.5 text-violet-400" /> Group Objects</span>
          <span class="text-[10px] text-slate-400 font-mono">Ctrl+G</span>
        </button>
        <button
          v-if="isGroupSelected"
          @click="ungroupObjects(); contextMenu.visible = false"
          class="w-full flex items-center justify-between px-3 py-1.5 rounded-xl hover:bg-slate-800 text-slate-200 hover:text-white transition cursor-pointer"
        >
          <span class="flex items-center gap-2"><Ungroup class="w-3.5 h-3.5 text-violet-400" /> Ungroup</span>
          <span class="text-[10px] text-slate-400 font-mono">Ctrl+Shift+G</span>
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

    <!-- Shortcuts Cheatsheet Modal -->
    <div
      v-if="showShortcutsModal"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4"
      @click.self="showShortcutsModal = false"
    >
      <div class="bg-slate-900 border border-slate-800 rounded-2xl p-6 max-w-md w-full shadow-2xl text-slate-100 space-y-4 animate-in fade-in zoom-in-95">
        <div class="flex items-center justify-between pb-2 border-b border-slate-800">
          <div class="flex items-center gap-2 font-bold text-sm text-slate-200">
            <HelpCircle class="w-4 h-4 text-indigo-400" />
            <span>Whiteboard Keyboard Shortcuts</span>
          </div>
          <button @click="showShortcutsModal = false" class="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition cursor-pointer">
            <X class="w-4 h-4" />
          </button>
        </div>
        <div class="grid grid-cols-2 gap-2 text-xs">
          <div class="flex items-center justify-between p-2 rounded-xl bg-slate-950/60 border border-slate-800/80">
            <span class="text-slate-400">Quick Save</span>
            <kbd class="px-1.5 py-0.5 rounded bg-slate-800 font-mono text-[10px] text-indigo-300">Ctrl+S</kbd>
          </div>
          <div class="flex items-center justify-between p-2 rounded-xl bg-slate-950/60 border border-slate-800/80">
            <span class="text-slate-400">Lock / Unlock</span>
            <kbd class="px-1.5 py-0.5 rounded bg-slate-800 font-mono text-[10px] text-indigo-300">Ctrl+L</kbd>
          </div>
          <div class="flex items-center justify-between p-2 rounded-xl bg-slate-950/60 border border-slate-800/80">
            <span class="text-slate-400">Group Objects</span>
            <kbd class="px-1.5 py-0.5 rounded bg-slate-800 font-mono text-[10px] text-indigo-300">Ctrl+G</kbd>
          </div>
          <div class="flex items-center justify-between p-2 rounded-xl bg-slate-950/60 border border-slate-800/80">
            <span class="text-slate-400">Ungroup</span>
            <kbd class="px-1.5 py-0.5 rounded bg-slate-800 font-mono text-[10px] text-indigo-300">Ctrl+Shift+G</kbd>
          </div>
          <div class="flex items-center justify-between p-2 rounded-xl bg-slate-950/60 border border-slate-800/80">
            <span class="text-slate-400">Copy / Paste</span>
            <kbd class="px-1.5 py-0.5 rounded bg-slate-800 font-mono text-[10px] text-indigo-300">Ctrl+C / V</kbd>
          </div>
          <div class="flex items-center justify-between p-2 rounded-xl bg-slate-950/60 border border-slate-800/80">
            <span class="text-slate-400">Cut / Delete</span>
            <kbd class="px-1.5 py-0.5 rounded bg-slate-800 font-mono text-[10px] text-indigo-300">Ctrl+X / Del</kbd>
          </div>
          <div class="flex items-center justify-between p-2 rounded-xl bg-slate-950/60 border border-slate-800/80">
            <span class="text-slate-400">Undo Action</span>
            <kbd class="px-1.5 py-0.5 rounded bg-slate-800 font-mono text-[10px] text-indigo-300">Ctrl+Z</kbd>
          </div>
          <div class="flex items-center justify-between p-2 rounded-xl bg-slate-950/60 border border-slate-800/80">
            <span class="text-slate-400">Select All</span>
            <kbd class="px-1.5 py-0.5 rounded bg-slate-800 font-mono text-[10px] text-indigo-300">Ctrl+A</kbd>
          </div>
          <div class="flex items-center justify-between p-2 rounded-xl bg-slate-950/60 border border-slate-800/80">
            <span class="text-slate-400">Zoom Canvas</span>
            <kbd class="px-1.5 py-0.5 rounded bg-slate-800 font-mono text-[10px] text-indigo-300">Ctrl+Wheel</kbd>
          </div>
          <div class="flex items-center justify-between p-2 rounded-xl bg-slate-950/60 border border-slate-800/80">
            <span class="text-slate-400">Pan Canvas</span>
            <kbd class="px-1.5 py-0.5 rounded bg-slate-800 font-mono text-[10px] text-indigo-300">Alt+Wheel / Mid</kbd>
          </div>
          <div class="col-span-2 p-2.5 rounded-xl bg-slate-950/60 border border-slate-800/80 text-[11px] text-slate-300">
            💡 <span class="font-semibold text-indigo-300">Group Isolation Mode:</span> Double-click any group to edit items individually. Press <kbd class="px-1.5 py-0.5 bg-slate-800 rounded font-mono text-[10px]">ESC</kbd> or click Exit Isolation to return.
          </div>
        </div>
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

