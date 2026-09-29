<script setup lang="ts">
import { ref, shallowRef, toRaw, computed, onMounted, onUnmounted, watch, nextTick } from 'vue';
import { useRoomStore } from '../stores/room';
import { useAuthStore } from '../stores/auth';
import * as fabric from 'fabric';

// Globally disable objectCaching in Fabric 7 so scaling and zooming always render 100% crisp vector!
if ((fabric as any).BaseFabricObject?.ownDefaults) {
  (fabric as any).BaseFabricObject.ownDefaults.objectCaching = false;
  (fabric as any).BaseFabricObject.ownDefaults.minScaleLimit = 0.02;
}
if ((fabric as any).FabricObject?.prototype) {
  (fabric as any).FabricObject.prototype.objectCaching = false;
}
if ((fabric as any).Object?.prototype) {
  (fabric as any).Object.prototype.objectCaching = false;
}
import {
  X, Pencil, Image as ImageIcon, Undo2, Redo2, Trash2, Maximize, Minimize, Check, Loader2, Sparkles, Send, Radio, Settings2, MousePointer2, Type, Square, Circle, Triangle, Minus, ArrowUpRight, Group, Ungroup, BringToFront, SendToBack, MoveUp, MoveDown, Copy, Scissors, ClipboardPaste, AlertTriangle, AlertCircle, RefreshCw, ChevronDown, ChevronUp, StickyNote, MoreHorizontal, Lock, Unlock, HelpCircle, Waypoints
} from 'lucide-vue-next';
import { generateSvgForWhiteboard } from '../services/ai';

const props = defineProps<{
  initialJson?: string;
  activeAssetId?: string | null;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'share', file: File): void;
  (e: 'save-state', json: string, previewDataUrl: string, assetId?: string | null): void;
}>();

const currentAssetId = ref<string | null | undefined>(props.activeAssetId);
watch(() => props.activeAssetId, (newId) => {
  currentAssetId.value = newId;
});

// Custom properties that must be preserved across JSON serialization
const CUSTOM_PROPS = [
  'isStickyNote',
  'stickyColorConfig',
  'minHeight',
  'isLocked',
  'isArrow',
  'arrowPoints',
  'arrowColor',
  'arrowStrokeWidth',
  'isStraightArrow',
  'isStraightLine',
  'arrowId',
  'initialMatrix',
  'lockMovementX',
  'lockMovementY',
  'lockRotation',
  'lockScalingX',
  'lockScalingY',
  'hasControls'
];

const hasUnsavedChanges = ref(false);
const showCloseConfirmModal = ref(false);

const roomStore = useRoomStore();
const authStore = useAuthStore();

const canvasRef = ref<HTMLCanvasElement | null>(null);
const fileInputRef = ref<HTMLInputElement | null>(null);
const wrapperRef = ref<HTMLDivElement | null>(null);
const rootRef = ref<HTMLDivElement | null>(null);

const whiteboardContainerWidth = ref(800);
const isColorPickerOpen = ref(false);
const isSendTextVisible = computed(() => whiteboardContainerWidth.value >= 960);
const isFullColorsVisible = computed(() => whiteboardContainerWidth.value >= 880);
const isCompactToolbar = computed(() => whiteboardContainerWidth.value < 880);
const isStackedToolbar = computed(() => whiteboardContainerWidth.value < 680);
const isNarrowToolbar = computed(() => whiteboardContainerWidth.value < 520);

let canvas: fabric.Canvas | null = null;

// Workspace boundary (3200x2000px)
const WORKSPACE_WIDTH = 3200;
const WORKSPACE_HEIGHT = 2000;

// Clamps viewport pan to prevent dragging workspace infinitely into the void
const clampViewportPan = () => {
  if (!canvas || !wrapperRef.value) return;
  const vpt = canvas.viewportTransform;
  if (!vpt) return;
  const zoom = canvas.getZoom();
  const w = wrapperRef.value.clientWidth;
  const h = wrapperRef.value.clientHeight;
  const margin = Math.max(160, Math.min(w, h) * 0.45);
  const minX = w - WORKSPACE_WIDTH * zoom - margin;
  const maxX = margin;
  const minY = h - WORKSPACE_HEIGHT * zoom - margin;
  const maxY = margin;
  vpt[4] = Math.min(maxX, Math.max(minX, vpt[4]));
  vpt[5] = Math.min(maxY, Math.max(minY, vpt[5]));
};

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
const activeStickyNote = shallowRef<any>(null);
const stickyToolbarPosition = ref({ x: 0, y: 0, visible: false });

// Arrow Floating Toolbar & Node Editing State
const activeArrow = shallowRef<any>(null);
const arrowToolbarPosition = ref({ x: 0, y: 0, visible: false });
const isArrowNodeEditing = ref(false);
const editingArrow = shallowRef<any>(null);
const editingNodeIndex = ref<number | null>(null);
const editingArrowPoints = ref<Array<{ x: number; y: number }>>([]);
const isDraggingNode = ref(false);
const viewportVersion = ref(0);
let liveArrowPreview: any = null;
let arrowPreviewRafId: number | null = null;

const isLineOrArrow = (obj: any): boolean => {
  return !!(obj && (obj as any).isArrow);
};

const isBrushMenuOpen = ref(false);
const currentTool = ref('draw'); // 'select', 'draw', 'text', 'sticky', 'rect', 'circle', 'triangle', 'line'

let isInternalChange = false;
const historyStack = ref<string[]>([]);
const redoStack = ref<string[]>([]);

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
    active.setCoords();
    const vpt = canvas.viewportTransform || [1, 0, 0, 1, 0, 0];
    const coords = active.getCoords ? active.getCoords(true, true) : null;
    if (coords && coords.length >= 4) {
      const minSceneX = Math.min(coords[0].x, coords[1].x, coords[2].x, coords[3].x);
      const maxSceneX = Math.max(coords[0].x, coords[1].x, coords[2].x, coords[3].x);
      const maxSceneY = Math.max(coords[0].y, coords[1].y, coords[2].y, coords[3].y);
      const midSceneX = (minSceneX + maxSceneX) / 2;

      const screenX = midSceneX * vpt[0] + vpt[4];
      const screenY = maxSceneY * vpt[3] + vpt[5];

      stickyToolbarPosition.value = {
        x: screenX,
        y: screenY + 28,
        visible: true
      };
    } else {
      const bound = active.getBoundingRect(true);
      const screenX = (bound.left + bound.width / 2) * vpt[0] + vpt[4];
      const screenY = (bound.top + bound.height) * vpt[3] + vpt[5];
      stickyToolbarPosition.value = {
        x: screenX,
        y: screenY + 28,
        visible: true
      };
    }
  } else {
    activeStickyNote.value = null;
    stickyToolbarPosition.value.visible = false;
  }
};

const updateArrowToolbar = () => {
  if (!canvas) {
    activeArrow.value = null;
    arrowToolbarPosition.value.visible = false;
    return;
  }
  const active = canvas.getActiveObject() as any;
  if (active && isLineOrArrow(active) && !isArrowNodeEditing.value) {
    activeArrow.value = active;
    active.setCoords();
    const vpt = canvas.viewportTransform || [1, 0, 0, 1, 0, 0];
    const coords = active.getCoords ? active.getCoords(true, true) : null;
    if (coords && coords.length >= 4) {
      const minSceneX = Math.min(coords[0].x, coords[1].x, coords[2].x, coords[3].x);
      const maxSceneX = Math.max(coords[0].x, coords[1].x, coords[2].x, coords[3].x);
      const maxSceneY = Math.max(coords[0].y, coords[1].y, coords[2].y, coords[3].y);
      const midSceneX = (minSceneX + maxSceneX) / 2;

      const screenX = midSceneX * vpt[0] + vpt[4];
      const screenY = maxSceneY * vpt[3] + vpt[5];

      arrowToolbarPosition.value = {
        x: screenX,
        y: screenY + 28,
        visible: true
      };
    } else {
      const bound = active.getBoundingRect(true);
      const screenX = (bound.left + bound.width / 2) * vpt[0] + vpt[4];
      const screenY = (bound.top + bound.height) * vpt[3] + vpt[5];
      arrowToolbarPosition.value = {
        x: screenX,
        y: screenY + 28,
        visible: true
      };
    }
  } else {
    activeArrow.value = null;
    arrowToolbarPosition.value.visible = false;
  }
};

const getNodeScreenPos = (pt: { x: number; y: number }) => {
  void viewportVersion.value;
  if (!canvas) return { x: 0, y: 0 };
  const vpt = canvas.viewportTransform || [1, 0, 0, 1, 0, 0];
  return {
    x: pt.x * vpt[0] + vpt[4],
    y: pt.y * vpt[3] + vpt[5]
  };
};

const nodeScreenPolyline = computed(() => {
  void viewportVersion.value;
  if (!isArrowNodeEditing.value || !canvas) return '';
  return editingArrowPoints.value.map(pt => {
    const pos = getNodeScreenPos(pt);
    return `${pos.x.toFixed(1)},${pos.y.toFixed(1)}`;
  }).join(' ');
});

const liveNodeArrowSvg = computed(() => {
  void viewportVersion.value;
  if (!isArrowNodeEditing.value || !isDraggingNode.value || !editingArrow.value || !canvas) {
    return { pathD: '', headPoints: '', color: '#0f172a', strokeWidth: 3 };
  }
  const pts = editingArrowPoints.value;
  if (pts.length < 2) return { pathD: '', headPoints: '', color: '#0f172a', strokeWidth: 3 };

  const color = (editingArrow.value as any).arrowColor || activeColor.value;
  const rawWidth = (editingArrow.value as any).arrowStrokeWidth || strokeWidth.value;
  const zoom = canvas.getZoom();
  const screenWidth = rawWidth * zoom;

  const sPts = pts.map(p => getNodeScreenPos(p));
  const s0 = sPts[0];
  const sn = sPts[sPts.length - 1];
  const sDist = Math.hypot(sn.x - s0.x, sn.y - s0.y);
  if (sDist < 4) return { pathD: '', headPoints: '', color, strokeWidth: screenWidth };

  const headLen = Math.max(14, rawWidth * 3.6) * zoom;
  const headAngle = Math.PI / 6;

  let maxDev = 0;
  for (const pt of sPts) {
    const dist = Math.abs((sn.y - s0.y) * pt.x - (sn.x - s0.x) * pt.y + sn.x * s0.y - sn.y * s0.x) / sDist;
    if (dist > maxDev) maxDev = dist;
  }
  const isStraight = maxDev < Math.max(16 * zoom, sDist * 0.12) || sPts.length <= 3;

  let tangentAngle = Math.atan2(sn.y - s0.y, sn.x - s0.x);
  if (!isStraight && sPts.length >= 2) {
    const sBack = sPts[sPts.length - 2];
    tangentAngle = Math.atan2(sn.y - sBack.y, sn.x - sBack.x);
  }

  const shaftCut = headLen * 0.55;
  const shaftEndX = sn.x - shaftCut * Math.cos(tangentAngle);
  const shaftEndY = sn.y - shaftCut * Math.sin(tangentAngle);

  const w1x = sn.x - headLen * Math.cos(tangentAngle - headAngle);
  const w1y = sn.y - headLen * Math.sin(tangentAngle - headAngle);
  const w2x = sn.x - headLen * Math.cos(tangentAngle + headAngle);
  const w2y = sn.y - headLen * Math.sin(tangentAngle + headAngle);
  const headPoints = `${sn.x.toFixed(1)},${sn.y.toFixed(1)} ${w1x.toFixed(1)},${w1y.toFixed(1)} ${w2x.toFixed(1)},${w2y.toFixed(1)}`;

  let pathD = '';
  if (isStraight || sPts.length < 3) {
    pathD = `M ${s0.x.toFixed(1)} ${s0.y.toFixed(1)} L ${shaftEndX.toFixed(1)} ${shaftEndY.toFixed(1)}`;
  } else {
    const shaftSampled = [...sPts];
    shaftSampled[shaftSampled.length - 1] = { x: shaftEndX, y: shaftEndY };
    pathD = `M ${shaftSampled[0].x.toFixed(1)} ${shaftSampled[0].y.toFixed(1)}`;
    const m = shaftSampled.length - 1;
    for (let i = 0; i < m; i++) {
      const pPrev = shaftSampled[Math.max(0, i - 1)];
      const pCur = shaftSampled[i];
      const pNext = shaftSampled[i + 1];
      const pAfter = shaftSampled[Math.min(m, i + 2)];

      const cp1x = pCur.x + (pNext.x - pPrev.x) / 6;
      const cp1y = pCur.y + (pNext.y - pPrev.y) / 6;
      const cp2x = pNext.x - (pAfter.x - pCur.x) / 6;
      const cp2y = pNext.y - (pAfter.y - pCur.y) / 6;

      pathD += ` C ${cp1x.toFixed(1)} ${cp1y.toFixed(1)}, ${cp2x.toFixed(1)} ${cp2y.toFixed(1)}, ${pNext.x.toFixed(1)} ${pNext.y.toFixed(1)}`;
    }
  }

  return {
    pathD,
    headPoints,
    color,
    strokeWidth: screenWidth
  };
});

const enterArrowNodeEditing = (arrow: any) => {
  if (!arrow || !(arrow as any).isArrow) return;
  isArrowNodeEditing.value = true;
  editingArrow.value = arrow;

  if (Array.isArray(arrow.arrowPoints) && arrow.arrowPoints.length > 0) {
    editingArrowPoints.value = arrow.arrowPoints.map((p: any) => ({ x: p.x, y: p.y }));
  } else {
    return;
  }

  arrow.set({
    hasControls: false,
    selectable: true,
    evented: true
  });
  (arrow as any)._nodeDragLastLeft = arrow.left;
  (arrow as any)._nodeDragLastTop = arrow.top;
  canvas?.discardActiveObject();
  canvas?.requestRenderAll();
  updateSelectionState();
};

const exitArrowNodeEditing = () => {
  if (!isArrowNodeEditing.value) return;
  const arrow = editingArrow.value;
  isArrowNodeEditing.value = false;
  editingArrow.value = null;
  editingNodeIndex.value = null;
  isDraggingNode.value = false;

  if (arrow && canvas) {
    arrow.set({
      hasControls: !arrow.isLocked,
      selectable: true,
      evented: true,
      visible: true
    });
    arrow.setCoords();
    canvas.setActiveObject(arrow);
    canvas.requestRenderAll();
    saveHistoryState();
    syncToFirebase();
  }
  updateSelectionState();
};

const onNodePointerDown = (index: number, e: PointerEvent) => {
  e.preventDefault();
  e.stopPropagation();
  editingNodeIndex.value = index;
  isDraggingNode.value = true;

  if (editingArrow.value) {
    editingArrow.value.visible = false;
    canvas?.requestRenderAll();
  }

  let animFrameId: number | null = null;
  let latestScenePt: { x: number; y: number } | null = null;

  const onPointerMove = (ev: PointerEvent) => {
    if (!canvas || !wrapperRef.value || !editingArrow.value) return;
    const rect = wrapperRef.value.getBoundingClientRect();
    const vpt = canvas.viewportTransform || [1, 0, 0, 1, 0, 0];
    const clientX = ev.clientX;
    const clientY = ev.clientY;

    const sceneX = (clientX - rect.left - vpt[4]) / vpt[0];
    const sceneY = (clientY - rect.top - vpt[5]) / vpt[3];

    latestScenePt = { x: sceneX, y: sceneY };
    if (!animFrameId) {
      animFrameId = requestAnimationFrame(() => {
        animFrameId = null;
        if (latestScenePt) {
          editingArrowPoints.value[index] = { ...latestScenePt };
        }
      });
    }
  };

  const onPointerUp = () => {
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    if (animFrameId) {
      cancelAnimationFrame(animFrameId);
      animFrameId = null;
    }
    if (latestScenePt) {
      editingArrowPoints.value[index] = { ...latestScenePt };
    }
    editingNodeIndex.value = null;
    isDraggingNode.value = false;

    if (editingArrow.value && canvas) {
      const color = (editingArrow.value as any).arrowColor || activeColor.value;
      const width = (editingArrow.value as any).arrowStrokeWidth || strokeWidth.value;
      const isLocked = !!(editingArrow.value as any).isLocked;
      const arrowId = (editingArrow.value as any).arrowId;

      const finalArrow = createArrowFromPoints(editingArrowPoints.value, color, width, true);
      if (finalArrow) {
        finalArrow.set({
          hasControls: false,
          selectable: true,
          evented: true,
          visible: true
        });
        (finalArrow as any).isLocked = isLocked;
        (finalArrow as any).arrowId = arrowId;

        const rawOld = toRaw(editingArrow.value);
        const allObjs = canvas.getObjects();
        const curIdx = allObjs.indexOf(rawOld);
        if (curIdx !== -1) {
          canvas.remove(rawOld);
          canvas.insertAt(curIdx, finalArrow);
        } else {
          canvas.remove(rawOld);
          canvas.add(finalArrow);
        }
        editingArrow.value = finalArrow;
        finalArrow.setCoords();
      } else {
        editingArrow.value.visible = true;
      }
      canvas.requestRenderAll();
      saveHistoryState();
      syncToFirebase();
    }
  };

  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
};

const straightenEditingArrow = () => {
  if (!editingArrow.value || editingArrowPoints.value.length < 2) return;
  const pts = editingArrowPoints.value;
  const p0 = pts[0];
  const pn = pts[pts.length - 1];
  const dx = pn.x - p0.x;
  const dy = pn.y - p0.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-4) return;

  const tArr: number[] = [];
  for (let i = 0; i < pts.length; i++) {
    if (i === 0) {
      tArr.push(0);
    } else if (i === pts.length - 1) {
      tArr.push(1);
    } else {
      const t = ((pts[i].x - p0.x) * dx + (pts[i].y - p0.y) * dy) / lenSq;
      tArr.push(Math.max(0.001, Math.min(0.999, t)));
    }
  }
  const intermediate = tArr.slice(1, -1).sort((a, b) => a - b);
  const sortedT = [0, ...intermediate, 1];

  const straightened = sortedT.map(t => ({
    x: p0.x + t * dx,
    y: p0.y + t * dy
  }));

  editingArrowPoints.value = straightened;
  const color = (editingArrow.value as any).arrowColor || activeColor.value;
  const width = (editingArrow.value as any).arrowStrokeWidth || strokeWidth.value;
  const updatedObj = createArrowFromPoints(straightened, color, width, true);

  if (updatedObj && canvas) {
    updatedObj.set({
      hasControls: false,
      selectable: true,
      evented: true,
      visible: true
    });
    (updatedObj as any).isLocked = (editingArrow.value as any).isLocked;
    (updatedObj as any).arrowId = (editingArrow.value as any).arrowId || Math.random().toString(36).substring(2, 9);
    const allObjs = canvas.getObjects();
    const rawOld = toRaw(editingArrow.value);
    const curIdx = allObjs.indexOf(rawOld);
    if (curIdx !== -1) {
      canvas.remove(rawOld);
      canvas.insertAt(curIdx, updatedObj);
    } else {
      canvas.remove(rawOld);
      canvas.add(updatedObj);
    }
    editingArrow.value = updatedObj;
    canvas.requestRenderAll();
    saveHistoryState();
    syncToFirebase();
    displayToast('Straightened');
  }
};

const straightenSelectedArrow = (arrow: any) => {
  if (!canvas || !arrow || (!arrow.isArrow && !arrow.isStraightLine && arrow.type !== 'line')) return;
  let pts = arrow.arrowPoints;
  if (!pts || pts.length < 2) {
    if (arrow.type === 'line') {
      pts = [{ x: arrow.x1 ?? 0, y: arrow.y1 ?? 0 }, { x: arrow.x2 ?? 0, y: arrow.y2 ?? 0 }];
    } else {
      return;
    }
  }
  const p0 = pts[0];
  const pn = pts[pts.length - 1];
  const dx = pn.x - p0.x;
  const dy = pn.y - p0.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-4) return;

  const tArr: number[] = [];
  for (let i = 0; i < pts.length; i++) {
    if (i === 0) {
      tArr.push(0);
    } else if (i === pts.length - 1) {
      tArr.push(1);
    } else {
      const t = ((pts[i].x - p0.x) * dx + (pts[i].y - p0.y) * dy) / lenSq;
      tArr.push(Math.max(0.001, Math.min(0.999, t)));
    }
  }
  const intermediate = tArr.slice(1, -1).sort((a, b) => a - b);
  const sortedT = [0, ...intermediate, 1];

  const straightened = sortedT.map(t => ({
    x: p0.x + t * dx,
    y: p0.y + t * dy
  }));

  let updatedObj: any;
  if (arrow.isArrow) {
    const color = (arrow as any).arrowColor || activeColor.value;
    const width = (arrow as any).arrowStrokeWidth || strokeWidth.value;
    updatedObj = createArrowFromPoints(straightened, color, width, true);
  } else {
    const color = (arrow as any).stroke || activeColor.value;
    const width = (arrow as any).strokeWidth || strokeWidth.value;
    updatedObj = new fabric.Line([p0.x, p0.y, pn.x, pn.y], {
      stroke: color,
      strokeWidth: width,
      strokeLineCap: 'round',
      strokeUniform: true,
      perPixelTargetFind: true
    });
    (updatedObj as any).isStraightLine = true;
    (updatedObj as any).arrowPoints = straightened;
  }

  if (updatedObj && canvas) {
    (updatedObj as any).isLocked = arrow.isLocked;
    (updatedObj as any).arrowId = arrow.arrowId || Math.random().toString(36).substring(2, 9);
    if (arrow.isLocked) {
      updatedObj.set({
        lockMovementX: true,
        lockMovementY: true,
        lockRotation: true,
        lockScalingX: true,
        lockScalingY: true,
        hasControls: false
      });
    }
    const allObjs = canvas.getObjects();
    const curIdx = allObjs.indexOf(arrow);
    if (curIdx !== -1) {
      canvas.remove(arrow);
      canvas.insertAt(curIdx, updatedObj);
      updatedObj.setCoords();
      canvas.setActiveObject(updatedObj);
      canvas.requestRenderAll();
      saveHistoryState();
      syncToFirebase();
      updateSelectionState();
      displayToast('Straightened');
    }
  }
};

const duplicateArrow = (arrow: any) => {
  if (!canvas || !arrow) return;
  const offset = 24;
  let pts = arrow.arrowPoints;
  if (!pts && arrow.type === 'line') {
    pts = [{ x: arrow.x1 ?? 0, y: arrow.y1 ?? 0 }, { x: arrow.x2 ?? 0, y: arrow.y2 ?? 0 }];
  }
  if (!pts) return;
  const newPts = pts.map((p: any) => ({ x: p.x + offset, y: p.y + offset }));
  let newObj: any;
  if (arrow.isArrow) {
    const color = (arrow as any).arrowColor || activeColor.value;
    const width = (arrow as any).arrowStrokeWidth || strokeWidth.value;
    newObj = createArrowFromPoints(newPts, color, width, true);
  } else {
    const color = (arrow as any).stroke || activeColor.value;
    const width = (arrow as any).strokeWidth || strokeWidth.value;
    newObj = new fabric.Line([newPts[0].x, newPts[0].y, newPts[newPts.length - 1].x, newPts[newPts.length - 1].y], {
      stroke: color,
      strokeWidth: width,
      strokeLineCap: 'round',
      strokeUniform: true,
      perPixelTargetFind: true
    });
    (newObj as any).isStraightLine = true;
    (newObj as any).arrowPoints = newPts;
  }
  if (newObj) {
    (newObj as any).arrowId = Math.random().toString(36).substring(2, 9);
    canvas.add(newObj);
    canvas.setActiveObject(newObj);
    canvas.requestRenderAll();
    saveHistoryState();
    syncToFirebase();
    updateSelectionState();
    displayToast('Duplicated');
  }
};

const updateSelectionState = () => {
  if (!canvas) {
    hasSelection.value = false;
    isMultiSelection.value = false;
    isGroupSelected.value = false;
    isObjectLocked.value = false;
    activeStickyNote.value = null;
    activeArrow.value = null;
    stickyToolbarPosition.value.visible = false;
    arrowToolbarPosition.value.visible = false;
    return;
  }
  const active = canvas.getActiveObject() as any;
  hasSelection.value = !!active;
  isMultiSelection.value = !!(
    active && (
      active.type?.toLowerCase() === 'activeselection' ||
      active instanceof fabric.ActiveSelection ||
      (active._objects && active._objects.length > 1 && active.type?.toLowerCase() !== 'group')
    )
  );
  isGroupSelected.value = !!(
    active && (
      active.type?.toLowerCase() === 'group' ||
      active instanceof fabric.Group
    ) && !active.isStickyNote && !(active as any).isArrow
  );
  if (active && (active.type?.toLowerCase() === 'activeselection' || active instanceof fabric.ActiveSelection)) {
    const targets = active.getObjects ? active.getObjects() : active._objects || [];
    const allLocked = targets.length > 0 && targets.every((o: any) => o.isLocked === true);
    const anyLocked = targets.some((o: any) => o.isLocked === true);
    isObjectLocked.value = anyLocked;
    active.set({
      lockMovementX: allLocked,
      lockMovementY: allLocked,
      lockRotation: allLocked,
      lockScalingX: allLocked,
      lockScalingY: allLocked,
      hasControls: !allLocked
    });
  } else if (active && (active.type?.toLowerCase() === 'group' || active instanceof fabric.Group) && !active.isStickyNote && !(active as any).isArrow) {
    const targets = active.getObjects ? active.getObjects() : active._objects || [];
    const allLocked = targets.length > 0 && targets.every((o: any) => o.isLocked === true);
    const anyLocked = targets.some((o: any) => o.isLocked === true);
    isObjectLocked.value = !!active.isLocked || anyLocked;
    const shouldFreeze = !!active.isLocked || allLocked;
    active.set({
      lockMovementX: shouldFreeze,
      lockMovementY: shouldFreeze,
      lockRotation: shouldFreeze,
      lockScalingX: shouldFreeze,
      lockScalingY: shouldFreeze,
      hasControls: !shouldFreeze
    });
  } else {
    isObjectLocked.value = !!(active && active.isLocked === true);
  }
  updateStickyToolbar();
  updateArrowToolbar();
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
  // Deselect active object temporarily so nodes and handles are never in the exported picture
  const activeObj = canvas.getActiveObject();
  if (activeObj) {
    canvas.discardActiveObject();
    canvas.renderAll();
  }

  const width = canvas.getWidth();
  const height = canvas.getHeight();

  const offscreen = document.createElement('canvas');
  offscreen.width = width;
  offscreen.height = height;
  const ctx = offscreen.getContext('2d');
  if (!ctx) {
    if (activeObj) {
      canvas.setActiveObject(activeObj);
      canvas.renderAll();
    }
    return canvas.toDataURL({ format: 'jpeg', quality, multiplier: 1 });
  }

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

  // 3. Draw fabric lower canvas elements with precise Retina / high-DPI scaling
  const lowerCanvas = canvas.lowerCanvasEl;
  if (lowerCanvas) {
    ctx.drawImage(lowerCanvas, 0, 0, lowerCanvas.width, lowerCanvas.height, 0, 0, width, height);
  }

  // Restore selection
  if (activeObj) {
    canvas.setActiveObject(activeObj);
    canvas.renderAll();
  }

  return offscreen.toDataURL('image/jpeg', quality);
};

let drawingObject: any = null;
let drawingStartPoint: { x: number; y: number } | null = null;
let isDragging = false;
let lastPosX = 0;
let lastPosY = 0;

// Procreate-style QuickShape (Pencil Hold-to-Straighten / Multi-Shape Recognition & Resizing)
let pencilHoldTimer: any = null;
let pencilStrokePoints: Array<{ x: number; y: number }> = [];
let isPencilHolding = false;
let pendingQuickShape: any = null;
let lastPencilMovePos: { x: number; y: number } | null = null;
let isMouseDown = false;
let hasFlattenedShapeInCurrentStroke = false;

// QuickShape continuous resize state
let isQuickShapeResizing = false;
let quickShapeActiveObj: any = null;
let quickShapeAnchor = { x: 0, y: 0 };
let quickShapeArrowP0: { x: number; y: number } | null = null;
let quickShapeP0Scene: fabric.Point | null = null;
let quickShapeP0Local: fabric.Point | null = null;
let quickShapeInitialSpanX = 1;
let quickShapeInitialSpanY = 1;
let quickShapeInitialSignX = 1;
let quickShapeInitialSignY = 1;
let quickShapeBaseScaleX = 1;
let quickShapeBaseScaleY = 1;
let lastSyncedJson = '';
let pendingRemoteState: string | null = null;

// Ramer-Douglas-Peucker (RDP) polygonal simplification
const rdp = (points: Array<{ x: number; y: number }>, epsilon: number): Array<{ x: number; y: number }> => {
  if (points.length <= 2) return points;
  let dmax = 0;
  let index = 0;
  const p1 = points[0];
  const p2 = points[points.length - 1];
  const lineLen = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  for (let i = 1; i < points.length - 1; i++) {
    const d = lineLen === 0 ? Math.hypot(points[i].x - p1.x, points[i].y - p1.y) :
      Math.abs((p2.y - p1.y) * points[i].x - (p2.x - p1.x) * points[i].y + p2.x * p1.y - p2.y * p1.x) / lineLen;
    if (d > dmax) { index = i; dmax = d; }
  }
  if (dmax > epsilon) {
    const rec1 = rdp(points.slice(0, index + 1), epsilon);
    const rec2 = rdp(points.slice(index), epsilon);
    return rec1.slice(0, -1).concat(rec2);
  } else {
    return [p1, p2];
  }
};

// Generates an Arrow object with shaft and arrowhead oriented precisely with end tangent
const createArrowFromPoints = (
  pts: Array<{ x: number; y: number }>,
  customColor?: string,
  customWidth?: number,
  isExactNodes = false
) => {
  if (pts.length < 2) return null;
  const p0 = pts[0];
  const pn = pts[pts.length - 1];
  const lineLen = Math.hypot(pn.x - p0.x, pn.y - p0.y);
  if (lineLen < 6) return null;

  const color = customColor || activeColor.value;
  const width = customWidth || strokeWidth.value;

  // 1. Straight line check: perpendicular deviation from chord p0 -> pn
  let maxDev = 0;
  for (const pt of pts) {
    const dist = Math.abs((pn.y - p0.y) * pt.x - (pn.x - p0.x) * pt.y + pn.x * p0.y - pn.y * p0.x) / lineLen;
    if (dist > maxDev) maxDev = dist;
  }

  const headLen = Math.max(14, width * 3.6);
  const headAngle = Math.PI / 6; // 30 degrees

  let shaft: any;
  let tangentAngle = Math.atan2(pn.y - p0.y, pn.x - p0.x);

  const isStraight = maxDev < Math.max(16, lineLen * 0.12) || pts.length <= 3;
  let finalPts: Array<{ x: number; y: number }>;

  if (isStraight) {
    // For straight line: tangent is purely the chord angle (start to end)
    tangentAngle = Math.atan2(pn.y - p0.y, pn.x - p0.x);

    if (isExactNodes) {
      // In node edit mode: project existing nodes onto the straight line segment
      const dx = pn.x - p0.x;
      const dy = pn.y - p0.y;
      const lenSq = dx * dx + dy * dy;
      if (lenSq > 1e-4 && pts.length > 2) {
        const tArr: number[] = [];
        for (let i = 0; i < pts.length; i++) {
          if (i === 0) tArr.push(0);
          else if (i === pts.length - 1) tArr.push(1);
          else {
            const t = ((pts[i].x - p0.x) * dx + (pts[i].y - p0.y) * dy) / lenSq;
            tArr.push(Math.max(0.001, Math.min(0.999, t)));
          }
        }
        const intermediate = tArr.slice(1, -1).sort((a, b) => a - b);
        const sortedT = [0, ...intermediate, 1];
        finalPts = sortedT.map(t => ({ x: p0.x + t * dx, y: p0.y + t * dy }));
      } else {
        finalPts = [{ x: p0.x, y: p0.y }, { x: pn.x, y: pn.y }];
      }
    } else {
      // Newly created straight arrow: strictly 2 or 3 evenly spaced nodes to avoid dozens of points
      if (lineLen < 160) {
        finalPts = [{ x: p0.x, y: p0.y }, { x: pn.x, y: pn.y }];
      } else {
        finalPts = [
          { x: p0.x, y: p0.y },
          { x: (p0.x + pn.x) / 2, y: (p0.y + pn.y) / 2 },
          { x: pn.x, y: pn.y }
        ];
      }
    }

    // Terminate shaft slightly inside the arrowhead body so rounded stroke cap does not poke out past the tip
    const shaftCut = headLen * 0.55;
    const shaftEndX = pn.x - shaftCut * Math.cos(tangentAngle);
    const shaftEndY = pn.y - shaftCut * Math.sin(tangentAngle);

    shaft = new fabric.Line([p0.x, p0.y, shaftEndX, shaftEndY], {
      stroke: color,
      strokeWidth: width,
      strokeLineCap: 'round',
      strokeUniform: true,
      perPixelTargetFind: true
    });
  } else {
    let sampled: Array<{ x: number; y: number }>;
    const simplifiedPts = isExactNodes ? pts : rdp(pts, 2.5);
    if (isExactNodes) {
      // In node edit mode or preserved transform, keep exact knot points
      sampled = pts.map(p => ({ x: p.x, y: p.y }));
    } else {
      // Illustrator-style incremental forward anchor placement (~150px per anchor)
      // Anchors placed earlier remain permanently fixed at their spatial coordinates.
      // Drawing forward only appends new movement to the tip without shifting existing nodes.
      const step = 150;
      sampled = [{ x: simplifiedPts[0].x, y: simplifiedPts[0].y }];
      let lastAnchor = simplifiedPts[0];
      let distFromLastAnchor = 0;

      for (let i = 1; i < simplifiedPts.length - 1; i++) {
        const segDist = Math.hypot(simplifiedPts[i].x - simplifiedPts[i - 1].x, simplifiedPts[i].y - simplifiedPts[i - 1].y);
        distFromLastAnchor += segDist;
        if (distFromLastAnchor >= step) {
          sampled.push({ x: simplifiedPts[i].x, y: simplifiedPts[i].y });
          lastAnchor = simplifiedPts[i];
          distFromLastAnchor = 0;
        }
      }

      // Final point (current mouse position)
      const distToTip = Math.hypot(pn.x - lastAnchor.x, pn.y - lastAnchor.y);
      if (distToTip < 45 && sampled.length > 1) {
        // If the tip is very close to the last dropped anchor, merge to prevent a cramped stub at the head
        sampled[sampled.length - 1] = { x: pn.x, y: pn.y };
      } else {
        sampled.push({ x: pn.x, y: pn.y });
      }
    }
    finalPts = sampled.map(p => ({ x: p.x, y: p.y }));

    // Direct terminal tangent looking back ~28px to eliminate tip micro-jitter
    let pBack = sampled[Math.max(0, sampled.length - 2)];
    if (simplifiedPts.length >= 2) {
      let backDist = 0;
      for (let i = simplifiedPts.length - 1; i > 0; i--) {
        const d = Math.hypot(simplifiedPts[i].x - simplifiedPts[i - 1].x, simplifiedPts[i].y - simplifiedPts[i - 1].y);
        backDist += d;
        if (backDist >= 28) {
          pBack = simplifiedPts[i - 1];
          break;
        }
      }
    }
    tangentAngle = Math.atan2(pn.y - pBack.y, pn.x - pBack.x);

    // Shorten end of shaft by cutting the last segment so rounded cap does not poke out past tip
    const shaftCut = headLen * 0.55;
    const shaftEndX = pn.x - shaftCut * Math.cos(tangentAngle);
    const shaftEndY = pn.y - shaftCut * Math.sin(tangentAngle);

    // Replace final point in sampled with the cut shaftEnd
    const shaftSampled = [...sampled];
    shaftSampled[shaftSampled.length - 1] = { x: shaftEndX, y: shaftEndY };

    if (shaftSampled.length < 3) {
      shaft = new fabric.Line([p0.x, p0.y, shaftEndX, shaftEndY], {
        stroke: color,
        strokeWidth: width,
        strokeLineCap: 'round',
        strokeUniform: true,
        perPixelTargetFind: true
      });
    } else {
      let pathD = `M ${shaftSampled[0].x.toFixed(1)} ${shaftSampled[0].y.toFixed(1)}`;
      const m = shaftSampled.length - 1;
      for (let i = 0; i < m; i++) {
        const pPrev = shaftSampled[Math.max(0, i - 1)];
        const pCur = shaftSampled[i];
        const pNext = shaftSampled[i + 1];
        const pAfter = shaftSampled[Math.min(m, i + 2)];

        const cp1x = pCur.x + (pNext.x - pPrev.x) / 6;
        const cp1y = pCur.y + (pNext.y - pPrev.y) / 6;
        const cp2x = pNext.x - (pAfter.x - pCur.x) / 6;
        const cp2y = pNext.y - (pAfter.y - pCur.y) / 6;

        pathD += ` C ${cp1x.toFixed(1)} ${cp1y.toFixed(1)}, ${cp2x.toFixed(1)} ${cp2y.toFixed(1)}, ${pNext.x.toFixed(1)} ${pNext.y.toFixed(1)}`;
      }

      shaft = new fabric.Path(pathD, {
        stroke: color,
        strokeWidth: width,
        fill: 'transparent',
        strokeLineCap: 'round',
        strokeLineJoin: 'round',
        strokeUniform: true,
        perPixelTargetFind: true
      });
    }
  }

  // 2. Arrowhead triangle oriented along tangentAngle
  const w1x = pn.x - headLen * Math.cos(tangentAngle - headAngle);
  const w1y = pn.y - headLen * Math.sin(tangentAngle - headAngle);
  const w2x = pn.x - headLen * Math.cos(tangentAngle + headAngle);
  const w2y = pn.y - headLen * Math.sin(tangentAngle + headAngle);

  const head = new fabric.Polygon(
    [
      { x: pn.x, y: pn.y },
      { x: w1x, y: w1y },
      { x: w2x, y: w2y }
    ],
    {
      fill: color,
      stroke: color,
      strokeWidth: 1,
      strokeLineJoin: 'round',
      strokeUniform: true,
      perPixelTargetFind: true
    }
  );

  shaft.set({
    objectCaching: false,
    strokeUniform: true
  });
  head.set({
    objectCaching: false,
    strokeUniform: true
  });

  const arrow = new fabric.Group([shaft, head], {
    selectable: true,
    evented: true,
    strokeUniform: true,
    objectCaching: false,
    perPixelTargetFind: true
  });
  (arrow as any).isArrow = true;
  (arrow as any).arrowPoints = finalPts.map(p => ({ x: p.x, y: p.y }));
  (arrow as any).arrowColor = color;
  (arrow as any).arrowStrokeWidth = width;
  (arrow as any).isStraightArrow = isStraight;
  (arrow as any).arrowP0 = { x: p0.x, y: p0.y };
  (arrow as any).arrowPn = { x: pn.x, y: pn.y };
  (arrow as any).arrowId = Math.random().toString(36).substring(2, 9);
  (arrow as any).initialMatrix = arrow.calcTransformMatrix();
  return arrow;
};

const createSmoothedShape = (pts: Array<{ x: number; y: number }>) => {
  if (pts.length < 2) return null;
  const p0 = pts[0];
  const pn = pts[pts.length - 1];
  const endDist = Math.hypot(pn.x - p0.x, pn.y - p0.y);
  const lineLen = Math.hypot(pn.x - p0.x, pn.y - p0.y);

  if (currentTool.value === 'arrow') {
    return createArrowFromPoints(pts);
  }

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const pt of pts) {
    if (pt.x < minX) minX = pt.x;
    if (pt.x > maxX) maxX = pt.x;
    if (pt.y < minY) minY = pt.y;
    if (pt.y > maxY) maxY = pt.y;
  }
  const w = maxX - minX;
  const h = maxY - minY;
  const maxDim = Math.max(w, h);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;

  const isClosed = endDist < Math.max(45, maxDim * 0.32) && pts.length >= 8 && maxDim > 25;

  if (isClosed) {
    // 1. Strict Circle / Ellipse check: normalized radial mean deviation
    const rx = Math.max(10, w / 2);
    const ry = Math.max(10, h / 2);
    let sumDev = 0;
    for (const pt of pts) {
      const d = Math.hypot((pt.x - cx) / rx, (pt.y - cy) / ry);
      sumDev += Math.abs(d - 1.0);
    }
    const radialMeanDev = sumDev / pts.length;

    // Only classify as ellipse/circle if deviation from smooth oval is genuinely low (< 0.085)
    if (radialMeanDev < 0.085) {
      displayToast('Snapped to Circle / Ellipse');
      return new fabric.Ellipse({
        left: cx,
        top: cy,
        rx,
        ry,
        originX: 'center',
        originY: 'center',
        stroke: activeColor.value,
        strokeWidth: strokeWidth.value,
        fill: 'transparent',
        strokeUniform: true,
        perPixelTargetFind: true
      });
    }

    // 2. Polygonal simplification for Triangle, Rectangle, Star
    const epsilon = Math.max(10, maxDim * 0.07);
    const simplified = rdp(pts, epsilon);
    const corners = [...simplified];
    if (corners.length > 1 && Math.hypot(corners[corners.length - 1].x - corners[0].x, corners[corners.length - 1].y - corners[0].y) < epsilon * 1.5) {
      corners.pop();
    }
    const numCorners = corners.length;

    // Triangle
    if (numCorners === 3) {
      displayToast('Snapped to Triangle');
      return new fabric.Triangle({
        left: minX,
        top: minY,
        width: Math.max(10, w),
        height: Math.max(10, h),
        originX: 'left',
        originY: 'top',
        stroke: activeColor.value,
        strokeWidth: strokeWidth.value,
        fill: 'transparent',
        strokeUniform: true,
        perPixelTargetFind: true
      });
    }

    // Rectangle
    if (numCorners === 4) {
      displayToast('Snapped to Rectangle');
      return new fabric.Rect({
        left: minX,
        top: minY,
        width: Math.max(10, w),
        height: Math.max(10, h),
        originX: 'left',
        originY: 'top',
        stroke: activeColor.value,
        strokeWidth: strokeWidth.value,
        fill: 'transparent',
        strokeUniform: true,
        perPixelTargetFind: true
      });
    }

    // Fallback if somewhat round
    if (radialMeanDev < 0.15) {
      displayToast('Snapped to Circle / Ellipse');
      return new fabric.Ellipse({
        left: cx,
        top: cy,
        rx,
        ry,
        originX: 'center',
        originY: 'center',
        stroke: activeColor.value,
        strokeWidth: strokeWidth.value,
        fill: 'transparent',
        strokeUniform: true,
        perPixelTargetFind: true
      });
    }
  }

  // 3. Open stroke: Straight line check
  let maxDev = 0;
  if (lineLen > 1) {
    for (const pt of pts) {
      const dist = Math.abs((pn.y - p0.y) * pt.x - (pn.x - p0.x) * pt.y + pn.x * p0.y - pn.y * p0.x) / lineLen;
      if (dist > maxDev) maxDev = dist;
    }
  }

  if (maxDev < Math.max(15, lineLen * 0.08)) {
    displayToast('Snapped to straight line');
    return new fabric.Line([p0.x, p0.y, pn.x, pn.y], {
      stroke: activeColor.value,
      strokeWidth: strokeWidth.value,
      strokeLineCap: 'round',
      strokeUniform: true,
      perPixelTargetFind: true
    });
  }

  // 4. Open stroke: Catmull-Rom cubic Bezier spline
  displayToast('Smoothed curve');

  const sampled: Array<{ x: number; y: number }> = [pts[0]];
  let accumDist = 0;
  const targetStep = Math.max(16, lineLen / 12);
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    accumDist += d;
    if (accumDist >= targetStep) {
      sampled.push(pts[i]);
      accumDist = 0;
    }
  }
  if (sampled[sampled.length - 1] !== pn) {
    sampled.push(pn);
  }

  if (sampled.length < 3) {
    return new fabric.Line([p0.x, p0.y, pn.x, pn.y], {
      stroke: activeColor.value,
      strokeWidth: strokeWidth.value,
      strokeLineCap: 'round',
      strokeUniform: true,
      perPixelTargetFind: true
    });
  }

  let pathD = `M ${sampled[0].x.toFixed(1)} ${sampled[0].y.toFixed(1)}`;
  const m = sampled.length - 1;
  for (let i = 0; i < m; i++) {
    const pPrev = sampled[Math.max(0, i - 1)];
    const pCur = sampled[i];
    const pNext = sampled[i + 1];
    const pAfter = sampled[Math.min(m, i + 2)];

    const cp1x = pCur.x + (pNext.x - pPrev.x) / 6;
    const cp1y = pCur.y + (pNext.y - pPrev.y) / 6;
    const cp2x = pNext.x - (pAfter.x - pCur.x) / 6;
    const cp2y = pNext.y - (pAfter.y - pCur.y) / 6;

    pathD += ` C ${cp1x.toFixed(1)} ${cp1y.toFixed(1)}, ${cp2x.toFixed(1)} ${cp2y.toFixed(1)}, ${pNext.x.toFixed(1)} ${pNext.y.toFixed(1)}`;
  }

  return new fabric.Path(pathD, {
    stroke: activeColor.value,
    strokeWidth: strokeWidth.value,
    fill: 'transparent',
    strokeLineCap: 'round',
    strokeLineJoin: 'round',
    strokeUniform: true,
    perPixelTargetFind: true
  });
};

const onPencilHoldDetected = () => {
  if (!canvas || (!isDrawingMode.value && currentTool.value !== 'arrow') || pencilStrokePoints.length < 5) return;
  isPencilHolding = true;
  hasFlattenedShapeInCurrentStroke = true;

  if (liveArrowPreview && canvas.contains(liveArrowPreview)) {
    canvas.remove(liveArrowPreview);
    liveArrowPreview = null;
  }

  const shape = createSmoothedShape(pencilStrokePoints);
  if (!shape) return;

  // Clear in-progress brush line and disable drawing mode during quick shape hold to prevent ghost strokes
  canvas.isDrawingMode = false;
  canvas.clearContext(canvas.contextTop);
  if (canvas.freeDrawingBrush) {
    (canvas.freeDrawingBrush as any)._points = [];
    (canvas.freeDrawingBrush as any).oldEnd = void 0;
  }
  (canvas as any)._isCurrentlyDrawing = false;

  canvas.add(shape);
  shape.setCoords();
  canvas.setActiveObject(shape);
  canvas.requestRenderAll();
  updateSelectionState();

  // ONLY straight lines or straight arrows enter hold-to-resize with p0 pinned!
  // Irregular smoothed curves, circles, ellipses, rectangles, and triangles MUST NOT enter hold-to-resize!
  const isStraightLineOrArrow = shape.type === 'line' || (shape as any).isStraightArrow || (shape as any).isStraightLine;
  if (!isStraightLineOrArrow) {
    isQuickShapeResizing = false;
    quickShapeActiveObj = null;
    return;
  }

  // Enter continuous resize mode while left button continues to be held
  isQuickShapeResizing = true;
  quickShapeActiveObj = shape;
  const p0 = pencilStrokePoints[0];
  const pn = pencilStrokePoints[pencilStrokePoints.length - 1];

  // Scaling anchor is rigidly bound to the initial pen-down point p0 using Fabric transform matrices
  quickShapeP0Scene = new fabric.Point(p0.x, p0.y);
  const invM = fabric.util.invertTransform(shape.calcTransformMatrix());
  quickShapeP0Local = fabric.util.transformPoint(quickShapeP0Scene, invM);

  quickShapeAnchor = { x: p0.x, y: p0.y };
  quickShapeArrowP0 = { x: p0.x, y: p0.y };
  quickShapeInitialSpanX = Math.max(15, Math.abs(pn.x - p0.x));
  quickShapeInitialSpanY = Math.max(15, Math.abs(pn.y - p0.y));
  quickShapeInitialSignX = Math.sign(pn.x - p0.x) || 1;
  quickShapeInitialSignY = Math.sign(pn.y - p0.y) || 1;
  quickShapeBaseScaleX = shape.scaleX || 1;
  quickShapeBaseScaleY = shape.scaleY || 1;
  pendingQuickShape = null;
};

const initFabric = () => {
  if (!canvasRef.value || !wrapperRef.value) return;

  canvas = new fabric.Canvas(canvasRef.value, {
    selectionFullyContained: false,
    perPixelTargetFind: true,
    targetFindTolerance: 6,
    fireRightClick: true,
    stopContextMenu: true,
    isDrawingMode: true,
    backgroundColor: '',
    width: wrapperRef.value.clientWidth,
    height: wrapperRef.value.clientHeight,
    selectionColor: 'rgba(99, 102, 241, 0.18)',
    selectionBorderColor: '#6366f1',
    selectionLineWidth: 1.5,
    uniformScaling: false
  });

  // Guard against browser native context menu anywhere on canvas wrapper and elements
  const blockCanvasContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };
  canvas.upperCanvasEl.addEventListener('contextmenu', blockCanvasContextMenu, { capture: true });
  canvas.lowerCanvasEl?.addEventListener('contextmenu', blockCanvasContextMenu, { capture: true });
  canvas.wrapperEl?.addEventListener('contextmenu', blockCanvasContextMenu, { capture: true });

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

  // Render workspace background with dark uneditable area outside boundary
  canvas.on('before:render', () => {
    if (!canvas) return;
    const ctx = canvas.getContext();
    if (!ctx) return;
    const width = canvas.getWidth();
    const height = canvas.getHeight();

    // 1. Fill outer space with dark slate mask (#0f172a)
    ctx.save();
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, width, height);

    // 2. Calculate workspace boundary on screen
    const vpt = canvas.viewportTransform || [1, 0, 0, 1, 0, 0];
    const zoom = canvas.getZoom();
    const screenX = vpt[4];
    const screenY = vpt[5];
    const screenW = WORKSPACE_WIDTH * zoom;
    const screenH = WORKSPACE_HEIGHT * zoom;

    // 3. Fill bounded workspace with soft light background (#f8fafc)
    ctx.fillStyle = '#f8fafc';
    ctx.fillRect(screenX, screenY, screenW, screenH);

    // 4. Draw dot grid ONLY inside workspace boundary (fully synchronized with scene panning)
    const baseSpacing = 28;
    const screenSpacing = baseSpacing * zoom;

    if (screenSpacing >= 8) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(screenX, screenY, screenW, screenH);
      ctx.clip();

      ctx.fillStyle = 'rgba(148, 163, 184, 0.35)';
      const dotRadius = Math.max(0.8, Math.min(2.0, 1.0 * Math.sqrt(zoom)));

      const minVisibleSceneX = Math.max(0, -screenX / zoom);
      const maxVisibleSceneX = Math.min(WORKSPACE_WIDTH, (width - screenX) / zoom);
      const minVisibleSceneY = Math.max(0, -screenY / zoom);
      const maxVisibleSceneY = Math.min(WORKSPACE_HEIGHT, (height - screenY) / zoom);

      const firstSceneX = Math.ceil(minVisibleSceneX / baseSpacing) * baseSpacing;
      const firstSceneY = Math.ceil(minVisibleSceneY / baseSpacing) * baseSpacing;

      for (let sx = firstSceneX; sx <= maxVisibleSceneX; sx += baseSpacing) {
        const x = screenX + sx * zoom;
        for (let sy = firstSceneY; sy <= maxVisibleSceneY; sy += baseSpacing) {
          const y = screenY + sy * zoom;
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

  // After objects render, neatly mask any objects/strokes that extend into the outer uneditable zone
  canvas.on('after:render', () => {
    if (!canvas) return;
    const ctx = canvas.getContext();
    if (!ctx) return;
    const width = canvas.getWidth();
    const height = canvas.getHeight();

    const vpt = canvas.viewportTransform || [1, 0, 0, 1, 0, 0];
    const zoom = canvas.getZoom();
    const screenX = vpt[4];
    const screenY = vpt[5];
    const screenW = WORKSPACE_WIDTH * zoom;
    const screenH = WORKSPACE_HEIGHT * zoom;

    ctx.save();
    ctx.fillStyle = '#0f172a';

    // Top outer strip
    if (screenY > 0) {
      ctx.fillRect(0, 0, width, screenY);
    }
    // Bottom outer strip
    if (screenY + screenH < height) {
      ctx.fillRect(0, screenY + screenH, width, height - (screenY + screenH));
    }
    // Left outer strip
    if (screenX > 0) {
      ctx.fillRect(0, Math.max(0, screenY), screenX, screenH);
    }
    // Right outer strip
    if (screenX + screenW < width) {
      ctx.fillRect(screenX + screenW, Math.max(0, screenY), width - (screenX + screenW), screenH);
    }

    // Crisp workspace outline on top
    ctx.strokeStyle = '#94a3b8';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(screenX, screenY, screenW, screenH);

    ctx.restore();
  });

  updateBrush();

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

  // Ensure all objects added to canvas unconditionally disable bitmap caching for true vector rendering
  canvas.on('object:added', (e: any) => {
    if (e.target) {
      e.target.objectCaching = false;
      if (typeof e.target.getObjects === 'function') {
        e.target.getObjects().forEach((o: any) => {
          o.objectCaching = false;
        });
      }
    }
  });

  // Sync and history on changes
  canvas.on('path:created', (e: any) => {
    if (hasFlattenedShapeInCurrentStroke || isPencilHolding || isQuickShapeResizing || currentTool.value === 'arrow') {
      if (e.path) canvas?.remove(e.path);
      return;
    }
    if (e.path) {
      e.path.set({ perPixelTargetFind: true });
    }
    if (!isInternalChange) {
      saveHistoryState();
      syncToFirebase();
      updateSelectionState();
    }
  });

  canvas.on('object:modified', (e: any) => {
    const obj = e?.target;
    if (obj && (obj.isStickyNote || obj.stickyColorConfig)) {
      const sx = Math.abs(obj.scaleX || 1);
      const sy = Math.abs(obj.scaleY || 1);
      if (sx !== 1 || sy !== 1) {
        const transform = (e as any).transform || (canvas as any)?._currentTransform;
        const originX = transform?.originX || 'left';
        const originY = transform?.originY || 'top';
        const fixedPoint = (obj as any).getPositionByOrigin ? (obj as any).getPositionByOrigin(originX, originY) : null;

        const curW = obj.width || 180;
        const curMinH = (obj as any).minHeight !== undefined ? (obj as any).minHeight : (obj.height || 180);

        let targetW = Math.max(80, Math.round(curW * sx));
        let targetH = Math.max(80, Math.round(curMinH * sy));

        // Proportional font size scaling for sticky note
        const curFontSize = obj.fontSize || 18;
        const newFontSize = Math.max(10, Math.min(120, Math.round(curFontSize * sx)));

        (obj as any).minHeight = targetH;
        obj.set({
          width: targetW,
          fontSize: newFontSize,
          scaleX: 1,
          scaleY: 1
        });
        obj.initDimensions();
        if (fixedPoint && (obj as any).setPositionByOrigin) {
          (obj as any).setPositionByOrigin(fixedPoint, originX, originY);
        }
        obj.setCoords();
      }
    }

    // Minimum selectable dimension clamp for general objects
    if (obj && !obj.isStickyNote && !(obj as any).isArrow) {
      const minDim = 20;
      const curW = Math.abs((obj.width || 0) * (obj.scaleX || 1));
      const curH = Math.abs((obj.height || 0) * (obj.scaleY || 1));
      let changed = false;
      if (obj.width && curW < minDim) {
        obj.scaleX = (obj.scaleX < 0 ? -1 : 1) * (minDim / obj.width);
        changed = true;
      }
      if (obj.height && curH < minDim) {
        obj.scaleY = (obj.scaleY < 0 ? -1 : 1) * (minDim / obj.height);
        changed = true;
      }
      if (changed) {
        obj.setCoords();
      }
    }

    // Reconstruct arrow with fixed pristine arrowhead size, preserved points, and vector crispness
    if (obj && (obj as any).isArrow && (obj as any).arrowPoints) {
      if ((obj.scaleX && obj.scaleX !== 1) || (obj.scaleY && obj.scaleY !== 1)) {
        try {
          if (canvas) {
            const M0 = (obj as any).initialMatrix || obj.calcTransformMatrix();
            const M1 = obj.calcTransformMatrix();
            const invM0 = fabric.util.invertTransform(M0);
            const M_delta = fabric.util.multiplyTransformMatrices(M1, invM0);
            const newPts = (obj as any).arrowPoints.map((pt: any) => fabric.util.transformPoint(pt, M_delta));
            const newArrow = createArrowFromPoints(newPts, (obj as any).arrowColor, (obj as any).arrowStrokeWidth, true);
            if (newArrow) {
              (newArrow as any).isLocked = (obj as any).isLocked;
              (newArrow as any).arrowId = (obj as any).arrowId || Math.random().toString(36).substring(2, 9);
              if ((obj as any).isLocked) {
                newArrow.set({
                  lockMovementX: true,
                  lockMovementY: true,
                  lockRotation: true,
                  lockScalingX: true,
                  lockScalingY: true,
                  hasControls: false
                });
              }
              const allObjs = canvas.getObjects();
              const idx = allObjs.indexOf(obj);
              if (idx !== -1) {
                canvas.remove(obj);
                canvas.insertAt(idx, newArrow);
                newArrow.setCoords();
                canvas.setActiveObject(newArrow);
                canvas.requestRenderAll();
                updateSelectionState();
              }
            }
          }
        } catch (err) {
          console.warn('Failed to bake arrow scaling:', err);
        }
      }
    }

    if (isArrowNodeEditing.value && editingArrow.value && obj === editingArrow.value) {
      obj._nodeDragLastLeft = obj.left;
      obj._nodeDragLastTop = obj.top;
    }

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
      if (zoom < 0.08) zoom = 0.08;
      canvas.zoomToPoint({ x: opt.e.offsetX, y: opt.e.offsetY } as fabric.Point, zoom);
      clampViewportPan();
      const activeObj = canvas.getActiveObject();
      if (activeObj) activeObj.setCoords();
      updateStickyToolbar();
      updateArrowToolbar();
      viewportVersion.value++;
      opt.e.preventDefault();
      opt.e.stopPropagation();
    } else if (opt.e.altKey) {
      const vpt = canvas.viewportTransform;
      if (vpt) {
        vpt[4] -= delta;
        clampViewportPan();
        canvas.setViewportTransform(vpt);
        const activeObj = canvas.getActiveObject();
        if (activeObj) activeObj.setCoords();
        updateStickyToolbar();
        updateArrowToolbar();
        viewportVersion.value++;
        canvas.requestRenderAll();
      }
      opt.e.preventDefault();
      opt.e.stopPropagation();
    } else {
      const vpt = canvas.viewportTransform;
      if (vpt) {
        vpt[5] -= delta;
        clampViewportPan();
        canvas.setViewportTransform(vpt);
        const activeObj = canvas.getActiveObject();
        if (activeObj) activeObj.setCoords();
        updateStickyToolbar();
        updateArrowToolbar();
        viewportVersion.value++;
        canvas.requestRenderAll();
      }
      opt.e.preventDefault();
      opt.e.stopPropagation();
    }
  });

  // Smart tool switch on mousedown: clicking an existing object or control handle automatically switches to select tool
  canvas.on('mouse:down:before', (opt: any) => {
    if (!canvas) return;
    const e = opt.e as MouseEvent;
    if (e.button !== 0) return; // left click only

    const found = canvas.findTarget(e);
    const hitTarget = opt.target || (found as any)?.target || null;
    const isRealHit = !!(hitTarget && hitTarget instanceof fabric.FabricObject && hitTarget !== (canvas as any).clipPath);
    const activeObj = canvas.getActiveObject();

    let isControlHit = false;
    if (activeObj) {
      const vpPoint = canvas.getViewportPoint(e);
      if ((activeObj as any).findControl?.(vpPoint)) {
        isControlHit = true;
      }
    }

    if (isControlHit || isRealHit) {
      const targetObj = isRealHit ? hitTarget : activeObj;
      if (isDrawingMode.value || currentTool.value === 'sticky' || currentTool.value === 'arrow' || ['rect', 'circle', 'triangle', 'line'].includes(currentTool.value)) {
        toggleMode(false);
        currentTool.value = 'select';
        canvas.isDrawingMode = false;
        isDrawingMode.value = false;

        // Clear any in-progress brush line from contextTop
        canvas.clearContext(canvas.contextTop);
        if ((canvas.freeDrawingBrush as any)?._points) {
          (canvas.freeDrawingBrush as any)._points = [];
        }
        if (pencilHoldTimer) {
          clearTimeout(pencilHoldTimer);
          pencilHoldTimer = null;
        }

        if (targetObj) {
          canvas.setActiveObject(targetObj);
        }
        canvas.requestRenderAll();
        updateSelectionState();
      }
    }
  });

  // Unified Mouse Down
  canvas.on('mouse:down', (opt) => {
    if (!canvas) return;
    const e = opt.e as MouseEvent;
    isBrushMenuOpen.value = false;
    isStickyMenuOpen.value = false;

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

      if (activeObj && !target) {
        // Right-clicked on empty canvas: keep activeObj so user can group / copy / cut from anywhere!
      } else if (activeObj && target && (activeObj === target || (activeObj as any).contains?.(target))) {
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

    if (isArrowNodeEditing.value) {
      const hitTarget = opt.target || (canvas.findTarget(e) as any)?.target || null;
      if (!hitTarget || (hitTarget !== editingArrow.value && !editingArrow.value?.contains?.(hitTarget))) {
        exitArrowNodeEditing();
      }
    }

    isMouseDown = true;
    hasFlattenedShapeInCurrentStroke = false;
    canvas.getObjects().forEach((o: any) => {
      o._persisted = true;
    });

    const scenePoint = canvas.getScenePoint(e);

    // Arrow drawing mode: smart switch if clicked, else start live vector arrow tracking
    if (currentTool.value === 'arrow') {
      const hitTarget = opt.target || (canvas.findTarget(e) as any)?.target || null;
      if (hitTarget && hitTarget instanceof fabric.FabricObject && hitTarget !== (canvas as any).clipPath) {
        currentTool.value = 'select';
        canvas.setActiveObject(hitTarget);
        canvas.requestRenderAll();
        updateSelectionState();
        return;
      }

      pencilStrokePoints = [scenePoint];
      lastPencilMovePos = { x: scenePoint.x, y: scenePoint.y };
      isPencilHolding = false;
      isQuickShapeResizing = false;
      quickShapeActiveObj = null;
      pendingQuickShape = null;
      if (liveArrowPreview && canvas.contains(liveArrowPreview)) {
        canvas.remove(liveArrowPreview);
      }
      liveArrowPreview = null;
      if (pencilHoldTimer) clearTimeout(pencilHoldTimer);
      pencilHoldTimer = setTimeout(() => {
        onPencilHoldDetected();
      }, 650);
      return;
    }

    // Pencil drawing mode: smart switch if object was clicked, else start tracking for QuickShape hold
    if (isDrawingMode.value) {
      const hitTarget = opt.target || (canvas.findTarget(e) as any)?.target || null;
      if (hitTarget && hitTarget instanceof fabric.FabricObject && hitTarget !== (canvas as any).clipPath) {
        toggleMode(false);
        currentTool.value = 'select';
        canvas.setActiveObject(hitTarget);
        canvas.requestRenderAll();
        updateSelectionState();
        return;
      }

      pencilStrokePoints = [scenePoint];
      lastPencilMovePos = { x: scenePoint.x, y: scenePoint.y };
      isPencilHolding = false;
      isQuickShapeResizing = false;
      quickShapeActiveObj = null;
      pendingQuickShape = null;
      if (pencilHoldTimer) clearTimeout(pencilHoldTimer);
      pencilHoldTimer = setTimeout(() => {
        onPencilHoldDetected();
      }, 650);
    }

    // Sticky Note tool: smart switch if clicked on existing object, else spawn sticky note on empty space
    if (currentTool.value === 'sticky') {
      const hitTarget = opt.target || (canvas.findTarget(e) as any)?.target || null;
      if (hitTarget && hitTarget instanceof fabric.FabricObject && hitTarget !== (canvas as any).clipPath) {
        toggleMode(false);
        currentTool.value = 'select';
        canvas.setActiveObject(hitTarget);
        canvas.requestRenderAll();
        updateSelectionState();
        return;
      }
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
      const activeObj = canvas.getActiveObject();
      const hitTarget = opt.target || (canvas.findTarget(e) as any)?.target || null;
      const isRealHit = !!(hitTarget && hitTarget instanceof fabric.FabricObject && hitTarget !== (canvas as any).clipPath);
      const vpPoint = canvas.getViewportPoint(e);
      const isControlHit = activeObj && ((activeObj as any).findControl?.(vpPoint));

      if (isControlHit || isRealHit) {
        currentTool.value = 'select';
        if (isRealHit && hitTarget !== activeObj) {
          canvas.setActiveObject(hitTarget as fabric.FabricObject);
          canvas.requestRenderAll();
          updateSelectionState();
        }
        return;
      }

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
        canvas.setViewportTransform(vpt);
        const activeObj = canvas.getActiveObject();
        if (activeObj) activeObj.setCoords();
        updateStickyToolbar();
        canvas.requestRenderAll();
      }
      lastPosX = e.clientX;
      lastPosY = e.clientY;
      updateArrowToolbar();
      viewportVersion.value++;
      return;
    }

    // QuickShape continuous resize mode: width/height follow mouse movement while holding (strictly straight lines/arrows)
    if (isQuickShapeResizing && quickShapeActiveObj) {
      const curScene = canvas.getScenePoint(e);
      if (quickShapeActiveObj.isArrow) {
        const p0 = quickShapeArrowP0 || quickShapeAnchor;
        const color = (quickShapeActiveObj as any).arrowColor || activeColor.value;
        const width = (quickShapeActiveObj as any).arrowStrokeWidth || strokeWidth.value;
        const updatedArrow = createArrowFromPoints([p0, curScene], color, width);
        if (updatedArrow) {
          canvas.remove(quickShapeActiveObj);
          quickShapeActiveObj = updatedArrow;
          (quickShapeActiveObj as any).isArrow = true;
          canvas.add(quickShapeActiveObj);
          canvas.setActiveObject(quickShapeActiveObj);
        }
      } else if (quickShapeActiveObj.type === 'line' || (quickShapeActiveObj as any).isStraightLine) {
        quickShapeActiveObj.set({ x1: quickShapeAnchor.x, y1: quickShapeAnchor.y, x2: curScene.x, y2: curScene.y });
        (quickShapeActiveObj as any).arrowPoints = [
          { x: quickShapeAnchor.x, y: quickShapeAnchor.y },
          { x: curScene.x, y: curScene.y }
        ];
        quickShapeActiveObj.setCoords();
      }
      canvas.requestRenderAll();
      return;
    }

    // Arrow live sampled drawing: real-time vector arrow preview while dragging
    if (currentTool.value === 'arrow' && isMouseDown) {
      const scenePoint = canvas.getScenePoint(e);
      const lastPt = pencilStrokePoints[pencilStrokePoints.length - 1];
      const dist = lastPt ? Math.hypot(scenePoint.x - lastPt.x, scenePoint.y - lastPt.y) : 0;
      if (!lastPt || dist >= 8) {
        pencilStrokePoints.push(scenePoint);

        if (dist > 6 && lastPencilMovePos) {
          lastPencilMovePos = { x: scenePoint.x, y: scenePoint.y };
          if (pencilHoldTimer) clearTimeout(pencilHoldTimer);
          pencilHoldTimer = setTimeout(() => {
            onPencilHoldDetected();
          }, 650);
        }

        if (pencilStrokePoints.length >= 2 && !arrowPreviewRafId) {
          arrowPreviewRafId = requestAnimationFrame(() => {
            arrowPreviewRafId = null;
            if (!canvas || currentTool.value !== 'arrow' || !isMouseDown) return;
            const preview = createArrowFromPoints(pencilStrokePoints, activeColor.value, strokeWidth.value);
            if (preview) {
              if (liveArrowPreview && canvas.contains(liveArrowPreview)) {
                canvas.remove(liveArrowPreview);
              }
              preview.set({ selectable: false, evented: false });
              liveArrowPreview = preview;
              canvas.add(preview);
              canvas.requestRenderAll();
            }
          });
        }
      }
      return;
    }

    // Normal pencil drawing: track points for hold-to-straighten
    if (isDrawingMode.value && currentTool.value !== 'arrow' && lastPencilMovePos) {
      const scenePoint = canvas.getScenePoint(e);
      pencilStrokePoints.push(scenePoint);
      const moveDist = Math.hypot(scenePoint.x - lastPencilMovePos.x, scenePoint.y - lastPencilMovePos.y);
      if (moveDist > 5) {
        lastPencilMovePos = { x: scenePoint.x, y: scenePoint.y };
        if (pencilHoldTimer) clearTimeout(pencilHoldTimer);
        pencilHoldTimer = setTimeout(() => {
          onPencilHoldDetected();
        }, 650);
      }
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
    isMouseDown = false;

    if (pencilHoldTimer) {
      clearTimeout(pencilHoldTimer);
      pencilHoldTimer = null;
    }
    lastPencilMovePos = null;

    if (isDragging) {
      isDragging = false;
    }
    canvas.selection = currentTool.value === 'select';

    // Flush any deferred canvas resizing that arrived during drawing or dragging
    if (pendingResize) {
      performCanvasResize(pendingResize.w, pendingResize.h);
      pendingResize = null;
    }

    // Flush any deferred remote Firebase sync that arrived during drawing or dragging
    if (pendingRemoteState) {
      loadFromFirebase(pendingRemoteState);
      pendingRemoteState = null;
    }

    // Arrow brush: finish live preview, quickshape resizing, or create final arrow
    if (currentTool.value === 'arrow') {
      if (arrowPreviewRafId) {
        cancelAnimationFrame(arrowPreviewRafId);
        arrowPreviewRafId = null;
      }
      if (liveArrowPreview && canvas.contains(liveArrowPreview)) {
        canvas.remove(liveArrowPreview);
        liveArrowPreview = null;
      }

      if (isQuickShapeResizing && quickShapeActiveObj) {
        isQuickShapeResizing = false;
        isPencilHolding = false;
        hasFlattenedShapeInCurrentStroke = false;
        quickShapeActiveObj.setCoords();
        canvas.setActiveObject(quickShapeActiveObj);
        canvas.requestRenderAll();
        saveHistoryState();
        syncToFirebase();
        updateSelectionState();
        quickShapeActiveObj = null;
        pencilStrokePoints = [];
        return;
      }

      if (hasFlattenedShapeInCurrentStroke) {
        hasFlattenedShapeInCurrentStroke = false;
        isPencilHolding = false;
        const activeObj = canvas.getActiveObject();
        if (activeObj) activeObj.setCoords();
        canvas.requestRenderAll();
        saveHistoryState();
        syncToFirebase();
        updateSelectionState();
        pencilStrokePoints = [];
        return;
      }

      if (pencilStrokePoints.length >= 2) {
        const finalArrow = createArrowFromPoints(pencilStrokePoints, activeColor.value, strokeWidth.value);
        if (finalArrow) {
          finalArrow.set({
            selectable: true,
            evented: true,
            perPixelTargetFind: true
          });
          canvas.add(finalArrow);
          finalArrow.setCoords();
          canvas.requestRenderAll();
          saveHistoryState();
          syncToFirebase();
          updateSelectionState();
        }
      }
      pencilStrokePoints = [];
      return;
    }

    // Finish QuickShape continuous resize mode (for straight lines)
    if (isQuickShapeResizing && quickShapeActiveObj) {
      isQuickShapeResizing = false;
      isPencilHolding = false;
      hasFlattenedShapeInCurrentStroke = false;
      (canvas as any)._isCurrentlyDrawing = false;
      if (canvas.freeDrawingBrush) {
        (canvas.freeDrawingBrush as any)._points = [];
        (canvas.freeDrawingBrush as any).oldEnd = void 0;
      }
      canvas.clearContext(canvas.contextTop);

      // Clean up any stray path added by the brush during this gesture
      const allObjs = canvas?.getObjects() || [];
      allObjs.forEach((o: any) => {
        if (o.type === 'path' && o !== quickShapeActiveObj && !o._persisted) {
          canvas?.remove(o);
        }
      });

      quickShapeActiveObj.setCoords();
      canvas.setActiveObject(quickShapeActiveObj);
      canvas.requestRenderAll();
      saveHistoryState();
      syncToFirebase();
      updateSelectionState();
      quickShapeActiveObj = null;
      pencilStrokePoints = [];
      if (currentTool.value === 'draw') {
        canvas.isDrawingMode = true;
      }
      return;
    }

    // Finish flattened non-straight shapes (ellipses, rects, smoothed curves)
    if (hasFlattenedShapeInCurrentStroke && !isQuickShapeResizing) {
      hasFlattenedShapeInCurrentStroke = false;
      isPencilHolding = false;
      (canvas as any)._isCurrentlyDrawing = false;
      if (canvas.freeDrawingBrush) {
        (canvas.freeDrawingBrush as any)._points = [];
        (canvas.freeDrawingBrush as any).oldEnd = void 0;
      }
      canvas.clearContext(canvas.contextTop);
      const activeObj = canvas.getActiveObject();
      if (activeObj) activeObj.setCoords();
      canvas.requestRenderAll();
      saveHistoryState();
      syncToFirebase();
      updateSelectionState();
      pencilStrokePoints = [];
      if (currentTool.value === 'draw') {
        canvas.isDrawingMode = true;
      }
      return;
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

  // Double click for sticky notes inline editing, arrow node editing, or group isolation mode
  canvas.on('mouse:dblclick', (opt) => {
    const target = opt.target as any;
    if (!target) return;
    if (target.isStickyNote && target.enterEditing) {
      target.enterEditing();
      return;
    }
    if (target.isArrow) {
      enterArrowNodeEditing(target);
      return;
    }
    if (target.type === 'group' && !target.isStickyNote && !(target as any).isArrow && !isIsolationMode.value) {
      enterGroupIsolation(target as fabric.Group);
    }
  });

  // Record initial positions and set native minScaleLimit before transform to preserve anchor and prevent drifting
  canvas.on('before:transform', (opt: any) => {
    const target = opt.transform?.target;
    if (!target) return;
    target._dragStartLeft = target.left;
    target._dragStartTop = target.top;

    // Native minScaleLimit allows Fabric to enforce minimum size relative to the fixed anchor point,
    // eliminating drift and smoothly allowing reverse scaling when the mouse moves back outwards.
    const minDim = (target.isStickyNote || target.stickyColorConfig) ? 80 : 20;
    const baseW = target.width || minDim;
    const baseH = target.height || minDim;
    const minSide = Math.min(baseW, baseH);
    const curScale = Math.min(Math.abs(target.scaleX || 1), Math.abs(target.scaleY || 1));

    if (minSide > minDim) {
      // Normal object: allow scaling down until size reaches minDim
      target.minScaleLimit = Math.max(0.01, minDim / minSide);
    } else {
      // Micro object or dot (already <= minDim): never force minScaleLimit above current scale!
      target.minScaleLimit = Math.min(curScale, 0.05);
    }

    if (target.type === 'activeselection' || (target.type === 'group' && !target.isStickyNote)) {
      const children = target.getObjects ? target.getObjects() : target._objects || [];
      children.forEach((c: any) => {
        c._dragStartLeft = c.left;
        c._dragStartTop = c.top;
      });
    }
  });

  // Clamp moving objects strictly within workspace boundary and preserve locked child positions
  canvas.on('object:moving', (e: any) => {
    const obj = e.target;
    if (!obj) return;

    // 0. If in arrow node editing mode and dragging the arrow body itself, synchronize all node handles in real time
    if (isArrowNodeEditing.value && editingArrow.value && obj === editingArrow.value) {
      const prevL = obj._nodeDragLastLeft !== undefined ? obj._nodeDragLastLeft : obj.left;
      const prevT = obj._nodeDragLastTop !== undefined ? obj._nodeDragLastTop : obj.top;
      const dx = obj.left - prevL;
      const dy = obj.top - prevT;
      obj._nodeDragLastLeft = obj.left;
      obj._nodeDragLastTop = obj.top;
      if (dx !== 0 || dy !== 0) {
        editingArrowPoints.value = editingArrowPoints.value.map((pt: any) => ({
          x: pt.x + dx,
          y: pt.y + dy
        }));
        (editingArrow.value as any).arrowPoints = editingArrowPoints.value.map((p: any) => ({ ...p }));
      }
    }

    // 1. If group or activeSelection contains locked children, keep locked children strictly stationary in world coordinates
    if (obj.type === 'activeselection' || (obj.type === 'group' && !obj.isStickyNote)) {
      const targets = obj.getObjects ? obj.getObjects() : obj._objects || [];
      const lockedChildren = targets.filter((o: any) => o.isLocked);
      const unlockedChildren = targets.filter((o: any) => !o.isLocked);
      if (unlockedChildren.length === 0) {
        if (obj._dragStartLeft !== undefined) obj.left = obj._dragStartLeft;
        if (obj._dragStartTop !== undefined) obj.top = obj._dragStartTop;
        obj.setCoords();
        return;
      }
      if (lockedChildren.length > 0 && obj._dragStartLeft !== undefined && obj._dragStartTop !== undefined) {
        const deltaX = obj.left - obj._dragStartLeft;
        const deltaY = obj.top - obj._dragStartTop;
        lockedChildren.forEach((child: any) => {
          if (child._dragStartLeft !== undefined && child._dragStartTop !== undefined) {
            child.left = child._dragStartLeft - deltaX;
            child.top = child._dragStartTop - deltaY;
            child.setCoords();
          }
        });
        (obj as any).dirty = true;
      }
    }

    // 2. Strict boundary clamping: flush coordinates first to obtain true bounding box
    obj.setCoords();
    let bound = obj.getBoundingRect ? obj.getBoundingRect() : null;
    if (bound) {
      if (bound.width >= WORKSPACE_WIDTH) {
        obj.left = 0;
      } else {
        if (bound.left < 0) {
          obj.left += (0 - bound.left);
        } else if (bound.left + bound.width > WORKSPACE_WIDTH) {
          obj.left -= (bound.left + bound.width - WORKSPACE_WIDTH);
        }
      }

      obj.setCoords();
      bound = obj.getBoundingRect ? obj.getBoundingRect() : null;
      if (bound) {
        if (bound.height >= WORKSPACE_HEIGHT) {
          obj.top = 0;
        } else {
          if (bound.top < 0) {
            obj.top += (0 - bound.top);
          } else if (bound.top + bound.height > WORKSPACE_HEIGHT) {
            obj.top -= (bound.top + bound.height - WORKSPACE_HEIGHT);
          }
        }
      }
      obj.setCoords();
    }
    updateStickyToolbar();
    updateArrowToolbar();
  });
  canvas.on('object:scaling', (e: any) => {
    const obj = e?.target;
    if (obj) {
      if (obj.isStickyNote || obj.stickyColorConfig) {
        const s = Math.max(Math.abs(obj.scaleX || 1), Math.abs(obj.scaleY || 1));
        obj.scaleX = (obj.scaleX < 0 ? -1 : 1) * s;
        obj.scaleY = (obj.scaleY < 0 ? -1 : 1) * s;
      }
      obj.setCoords();
      if ((obj.type === 'activeselection' || obj.type === 'activeSelection') && obj.forEachObject) {
        obj.forEachObject((c: any) => c.setCoords());
      }
      canvas?.requestRenderAll();
    }
    updateStickyToolbar();
    updateArrowToolbar();
  });
  canvas.on('object:resizing', (e: any) => {
    const obj = e?.target;
    if (obj && (obj.isStickyNote || obj.stickyColorConfig)) {
      if (obj.width < 80) {
        obj.width = 80;
        obj.initDimensions();
        obj.setCoords();
      }
      updateStickyToolbar();
      updateArrowToolbar();
    }
  });
  canvas.on('object:rotating', () => {
    updateStickyToolbar();
    updateArrowToolbar();
  });

  // Handle resizing with rAF throttling and interaction-aware deferral to prevent clearing in-progress strokes
  let resizeRafId: number | null = null;
  let pendingResize: { w: number; h: number } | null = null;

  const performCanvasResize = (w: number, h: number) => {
    if (!canvas || !wrapperRef.value) return;
    if (Math.abs(canvas.getWidth() - w) < 2 && Math.abs(canvas.getHeight() - h) < 2) return;
    canvas.setDimensions({ width: w, height: h });
    canvas.renderAll();
  };

  const resizeObserver = new ResizeObserver(() => {
    if (resizeRafId) cancelAnimationFrame(resizeRafId);
    resizeRafId = requestAnimationFrame(() => {
      if (canvas && wrapperRef.value) {
        const w = wrapperRef.value.clientWidth;
        const h = wrapperRef.value.clientHeight;
        whiteboardContainerWidth.value = w;

        // If user is actively drawing, selecting, or dragging, DEFER canvas dimensions change until mouse:up!
        const isInteracting = (canvas as any)._isCurrentlyDrawing || (canvas as any)._groupSelector || isDragging || isQuickShapeResizing || pencilStrokePoints.length > 0;
        if (isInteracting) {
          pendingResize = { w, h };
          return;
        }
        performCanvasResize(w, h);
      }
    });
  });
  resizeObserver.observe(wrapperRef.value);

  // Load initial state or set up clean baseline
  if (props.initialJson) {
    historyStack.value = [];
    redoStack.value = [];
    loadFromFirebase(props.initialJson);
    hasUnsavedChanges.value = false;
  } else if (roomStore.currentRoom?.whiteboardActive && roomStore.currentRoom?.whiteboardState) {
    historyStack.value = [];
    redoStack.value = [];
    loadFromFirebase(roomStore.currentRoom.whiteboardState);
  } else {
    historyStack.value = [];
    redoStack.value = [];
    saveHistoryState(); // Initial baseline state only for brand-new whiteboard!
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

const changeStickyWidth = (eventData: any, transform: any, x: number, y: number) => {
  const { target, originX, originY } = transform;
  if (!target) return false;
  const constraint = target.getPositionByOrigin ? target.getPositionByOrigin(originX, originY) : null;
  const localPoint = fabric.controlsUtils.getLocalPoint(transform, originX, originY, x, y);
  const strokePadding = target.strokeWidth / (target.strokeUniform ? target.scaleX : 1);
  const multiplier = originX === 'center' ? 2 : 1;
  const newW = Math.max(125, Math.abs(localPoint.x * multiplier / (target.scaleX || 1)) - strokePadding);
  const oldW = target.width;
  target.set('width', newW);
  target.initDimensions();
  if (constraint && target.setPositionByOrigin) {
    target.setPositionByOrigin(constraint, originX, originY);
  }
  target.setCoords();
  target.fire('resizing');
  if (target.canvas) target.canvas.fire('object:resizing', { target });
  return oldW !== newW;
};

const changeStickyHeight = (eventData: any, transform: any, x: number, y: number) => {
  const { target, originX, originY } = transform;
  if (!target) return false;
  const constraint = target.getPositionByOrigin ? target.getPositionByOrigin(originX, originY) : null;
  const localPoint = fabric.controlsUtils.getLocalPoint(transform, originX, originY, x, y);
  const strokePadding = target.strokeWidth / (target.strokeUniform ? target.scaleY : 1);
  const multiplier = originY === 'center' ? 2 : 1;
  const minAllowedH = 60;
  const newH = Math.max(minAllowedH, Math.abs(localPoint.y * multiplier / (target.scaleY || 1)) - strokePadding);
  const oldH = (target as any).minHeight;
  (target as any).minHeight = newH;
  target.set('height', newH);
  target.initDimensions();
  if (constraint && target.setPositionByOrigin) {
    target.setPositionByOrigin(constraint, originX, originY);
  }
  target.setCoords();
  target.fire('resizing');
  if (target.canvas) target.canvas.fire('object:resizing', { target });
  return oldH !== newH;
};

const setupStickyControls = (note: any) => {
  const defaultControls = fabric.controlsUtils?.createObjectDefaultControls?.() || {};

  const makeStickyCornerControl = (baseControl: any) => {
    if (!baseControl) return baseControl;
    const origHandler = baseControl.actionHandler;
    return new (fabric as any).Control({
      ...baseControl,
      actionHandler: (eventData: any, transform: any, x: number, y: number) => {
        // Enforce proportional uniform scaling by forcing shiftKey / uniScaleKey on the event
        const forcedEvent = {
          ...eventData,
          shiftKey: true,
          [transform.target?.canvas?.uniScaleKey || 'shiftKey']: true
        };
        const res = origHandler ? origHandler(forcedEvent, transform, x, y) : false;
        if (transform.target) {
          const s = Math.max(Math.abs(transform.target.scaleX || 1), Math.abs(transform.target.scaleY || 1));
          transform.target.scaleX = (transform.target.scaleX < 0 ? -1 : 1) * s;
          transform.target.scaleY = (transform.target.scaleY < 0 ? -1 : 1) * s;
        }
        return res;
      }
    });
  };

  note.controls = {
    tl: makeStickyCornerControl(defaultControls.tl),
    tr: makeStickyCornerControl(defaultControls.tr),
    bl: makeStickyCornerControl(defaultControls.bl),
    br: makeStickyCornerControl(defaultControls.br)
  };
  note.setControlsVisibility({
    tl: true,
    tr: true,
    bl: true,
    br: true,
    ml: false,
    mr: false,
    mt: false,
    mb: false,
    mtr: false
  });
  note.hasRotatingPoint = false;
  note.lockUniScaling = true;
};

const applyStickyNoteMethods = (note: any) => {
  note.calcTextHeight = function() {
    const textH = fabric.Textbox.prototype.calcTextHeight.call(this);
    return Math.max(textH, (this as any).minHeight !== undefined ? (this as any).minHeight : 60);
  };
  (note as any)._getTopOffset = function() {
    const textH = fabric.Textbox.prototype.calcTextHeight.call(this);
    const h = (this as any).height || (this as any).minHeight || 60;
    const extraOffset = Math.max(0, (h - textH) / 2);
    return -h / 2 + extraOffset;
  };
  setupStickyControls(note);
};

// Rehydrate custom attributes, methods, and constraints after deserializing from JSON
const rehydrateCanvasObjects = () => {
  if (!canvas) return;
  canvas.getObjects().forEach((o: any) => {
    o.set({ perPixelTargetFind: true });

    // Clean up temporary group isolation mode styles if any were serialized
    if (o._origOpacity !== undefined) {
      o.set({ opacity: o._origOpacity });
      delete o._origOpacity;
    } else if (o.opacity === 0.2) {
      o.set({ opacity: 1 });
    }
    if (o._origSelectable !== undefined) {
      o.set({ selectable: o._origSelectable });
      delete o._origSelectable;
    }
    if (o._origEvented !== undefined) {
      o.set({ evented: o._origEvented });
      delete o._origEvented;
    }

    if (o.isStickyNote || (o.type === 'textbox' && (o.stickyColorConfig || o.backgroundColor))) {
      o.isStickyNote = true;
      o.minHeight = o.minHeight || 180;
      o.textAlign = 'center';
      o.splitByGrapheme = true;
      o.lockUniScaling = true;
      o.hasRotatingPoint = false;
      o.objectCaching = false;
      applyStickyNoteMethods(o);
      o.initDimensions();
    }

    if ((o as any).isArrow) {
      o.set({
        objectCaching: false,
        lockUniScaling: false,
        strokeUniform: true,
        perPixelTargetFind: true
      });
      (o as any).initialMatrix = o.calcTransformMatrix();

      if (Array.isArray((o as any).arrowPoints)) {
        (o as any).arrowPoints = (o as any).arrowPoints.map((pt: any) => ({ x: Number(pt.x), y: Number(pt.y) }));
      } else {
        const children = o.getObjects ? o.getObjects() : (o._objects || []);
        const shaft = children[0];
        if (shaft && shaft.type === 'line') {
          (o as any).arrowPoints = [
            { x: shaft.x1, y: shaft.y1 },
            { x: shaft.x2, y: shaft.y2 }
          ];
          (o as any).isStraightArrow = true;
        }
      }

      const children = o.getObjects ? o.getObjects() : (o._objects || []);
      children.forEach((c: any) => c.set({ objectCaching: false, strokeUniform: true }));
    }

    if ((o as any).isArrow || (o as any).isStraightLine || o.type === 'line' || o.type === 'path') {
      if (!o.isLocked) {
        o.set({
          selectable: true,
          evented: true,
          hasControls: true
        });
      }
    }

    if (o.isLocked) {
      o.set({
        lockMovementX: true,
        lockMovementY: true,
        lockRotation: true,
        lockScalingX: true,
        lockScalingY: true,
        hasControls: false
      });
    }
  });
};

const syncNodeEditingStateAfterReload = () => {
  if (!isArrowNodeEditing.value || !canvas) return;
  const currentEditingId = (editingArrow.value as any)?.arrowId;
  const allTargets = canvas.getObjects().filter((o: any) => (o as any).isArrow && (o as any).arrowPoints);
  const match = (currentEditingId ? allTargets.find((o: any) => (o as any).arrowId === currentEditingId) : null) || allTargets[0];
  if (match) {
    editingArrow.value = match;
    editingArrowPoints.value = (match as any).arrowPoints.map((p: any) => ({ x: p.x, y: p.y }));
    match.set({
      hasControls: false,
      selectable: true,
      evented: true
    });
    viewportVersion.value++;
  } else {
    exitArrowNodeEditing();
  }
};

const getSerializedCanvasJson = (): string => {
  if (!canvas) return '';
  return JSON.stringify((canvas as any).toObject(CUSTOM_PROPS));
};

const saveHistoryState = () => {
  if (!canvas || isInternalChange) return;
  const json = getSerializedCanvasJson();
  historyStack.value.push(json);
  if (historyStack.value.length > 50) {
    historyStack.value.shift();
  }
  if (historyStack.value.length > 1) {
    hasUnsavedChanges.value = true;
  }
  redoStack.value = [];
};

const syncToFirebase = () => {
  if (isInternalChange || !canvas || !roomStore.currentRoom?.whiteboardActive) return;
  const json = getSerializedCanvasJson();
  lastSyncedJson = json;
  roomStore.syncWhiteboardState(json);
};

const loadFromFirebase = async (json: string) => {
  if (!canvas || !json) return;
  isInternalChange = true;
  await canvas.loadFromJSON(json);
  rehydrateCanvasObjects();
  syncNodeEditingStateAfterReload();
  canvas.requestRenderAll();

  if (historyStack.value.length === 0) {
    historyStack.value = [json];
  } else if (historyStack.value[historyStack.value.length - 1] !== json) {
    historyStack.value.push(json);
    if (historyStack.value.length > 50) historyStack.value.shift();
  }
  redoStack.value = [];

  isInternalChange = false;
};

watch(() => roomStore.currentRoom?.whiteboardState, (newState, oldState) => {
  if (newState && newState !== oldState && roomStore.currentRoom?.whiteboardActive) {
    // Ignore echo of local changes
    if (newState === lastSyncedJson) return;

    // Defer loading if user is actively drawing, selecting, or dragging
    const isInteracting = isMouseDown || (canvas as any)?._groupSelector || isDragging || isQuickShapeResizing || pencilStrokePoints.length > 0;
    if (isInteracting) {
      pendingRemoteState = newState;
      return;
    }
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
    displayToast('Copied (Ctrl+C)');
  }
};

const cutSelection = async () => {
  await copySelection();
  deleteSelected();
  displayToast('Cut (Ctrl+X)');
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
  displayToast('Pasted (Ctrl+V)');
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
    textAlign: 'center',
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
    lockUniScaling: true,
    hasRotatingPoint: false,
    objectCaching: false
  });

  (note as any).isStickyNote = true;
  (note as any).stickyColorConfig = colorCfg;
  (note as any).minHeight = 180;
  (note as any).isLocked = false;
  applyStickyNoteMethods(note);
  note.initDimensions();

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
  if (!canvas || !note || note.isLocked) return;
  const wasEditing = !!note.isEditing;
  const selStart = note.selectionStart;
  const selEnd = note.selectionEnd;

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

  if (wasEditing) {
    note.enterEditing();
    if (typeof selStart === 'number' && typeof selEnd === 'number') {
      note.selectionStart = selStart;
      note.selectionEnd = selEnd;
    }
    note.hiddenTextarea?.focus();
  }
};

const duplicateStickyNote = async (note: any) => {
  if (!canvas || !note) return;
  const cloned = await note.clone();
  cloned.set({
    left: (note.left || 0) + 24,
    top: (note.top || 0) + 24,
    evented: true,
    perPixelTargetFind: true,
    lockUniScaling: true,
    hasRotatingPoint: false,
    objectCaching: false
  });
  (cloned as any).isStickyNote = true;
  (cloned as any).stickyColorConfig = (note as any).stickyColorConfig;
  (cloned as any).minHeight = (note as any).minHeight || 180;
  applyStickyNoteMethods(cloned);
  cloned.initDimensions();
  canvas.add(cloned);
  canvas.setActiveObject(cloned);
  canvas.requestRenderAll();
  saveHistoryState();
  syncToFirebase();
  updateSelectionState();
  displayToast('Duplicated');
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
    item.set({
      selectable: true,
      evented: true,
      perPixelTargetFind: true,
      lockMovementX: !!(item as any).isLocked,
      lockMovementY: !!(item as any).isLocked,
      lockRotation: !!(item as any).isLocked,
      lockScalingX: !!(item as any).isLocked,
      lockScalingY: !!(item as any).isLocked,
      hasControls: !(item as any).isLocked
    });
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
  const allLocked = isolatedItems.length > 0 && isolatedItems.every((o: any) => o.isLocked);
  const anyLocked = isolatedItems.some((o: any) => o.isLocked);
  (newGroup as any).hasLockedChildren = anyLocked;
  if (allLocked) {
    (newGroup as any).isLocked = true;
    newGroup.set({
      lockMovementX: true,
      lockMovementY: true,
      lockRotation: true,
      lockScalingX: true,
      lockScalingY: true,
      hasControls: false
    });
  }
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

// Object Lock Action (Supports single objects, groups, and multi-selection ActiveSelection)
const toggleLockSelected = () => {
  if (!canvas) return;
  const activeObj = canvas.getActiveObject() as any;
  if (!activeObj) return;

  const isMulti = activeObj.type?.toLowerCase() === 'activeselection' || !!activeObj._objects;
  const targets: any[] = isMulti && activeObj.getObjects ? activeObj.getObjects() : (activeObj._objects ? activeObj._objects : [activeObj]);

  const newLocked = !targets.every((o: any) => o.isLocked);

  targets.forEach((obj: any) => {
    obj.set({
      lockMovementX: newLocked,
      lockMovementY: newLocked,
      lockRotation: newLocked,
      lockScalingX: newLocked,
      lockScalingY: newLocked,
      hasControls: !newLocked,
      isLocked: newLocked
    });
  });

  if (isMulti) {
    activeObj.set({
      lockMovementX: newLocked,
      lockMovementY: newLocked,
      lockRotation: newLocked,
      lockScalingX: newLocked,
      lockScalingY: newLocked,
      hasControls: !newLocked,
      isLocked: newLocked
    });
  }

  isObjectLocked.value = newLocked;
  canvas.requestRenderAll();
  saveHistoryState();
  syncToFirebase();
  updateSelectionState();
  displayToast(newLocked ? 'Locked (Ctrl+L)' : 'Unlocked (Ctrl+L)');
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
  const activeObj = canvas.getActiveObject() as any;
  if (!activeObj) return;

  if (activeObj.type === 'activeselection') {
    const targets = activeObj.getObjects();
    const locked = targets.filter((obj: any) => obj.isLocked === true);
    const deletable = targets.filter((obj: any) => obj.isLocked !== true);

    if (locked.length > 0) {
      displayToast('Locked objects cannot be deleted (Unlock with Ctrl+Shift+L first)');
    }
    if (deletable.length) {
      canvas.discardActiveObject();
      deletable.forEach((obj: any) => {
        if (obj.isEditing && obj.exitEditing) obj.exitEditing();
        canvas?.remove(obj);
      });
      if (locked.length === 1) {
        canvas.setActiveObject(locked[0]);
      } else if (locked.length > 1) {
        const newSel = new fabric.ActiveSelection(locked, { canvas });
        canvas.setActiveObject(newSel);
      }
      canvas.requestRenderAll();
      saveHistoryState();
      syncToFirebase();
      updateSelectionState();
    }
    return;
  }

  if (activeObj.type === 'group' && !activeObj.isStickyNote) {
    const targets = activeObj.getObjects ? activeObj.getObjects() : activeObj._objects || [];
    const locked = targets.filter((obj: any) => obj.isLocked === true);
    const deletable = targets.filter((obj: any) => obj.isLocked !== true);

    if (locked.length > 0) {
      displayToast('Locked objects inside group preserved');
      canvas.remove(activeObj);
      canvas.discardActiveObject();
      locked.forEach((child: any) => {
        const matrix = activeObj.calcTransformMatrix();
        const pt = fabric.util.transformPoint({ x: child.left, y: child.top } as fabric.Point, matrix);
        child.left = pt.x;
        child.top = pt.y;
        child.set({
          selectable: true,
          evented: true,
          hasControls: false,
          lockMovementX: true,
          lockMovementY: true,
          lockRotation: true,
          lockScalingX: true,
          lockScalingY: true,
          isLocked: true
        });
        child.setCoords();
        canvas?.add(child);
      });
      canvas.requestRenderAll();
      saveHistoryState();
      syncToFirebase();
      updateSelectionState();
      return;
    }
    if (activeObj.isLocked) {
      displayToast('Locked group cannot be deleted (Unlock with Ctrl+Shift+L first)');
      return;
    }
    canvas.remove(activeObj);
    canvas.discardActiveObject();
    canvas.requestRenderAll();
    saveHistoryState();
    syncToFirebase();
    updateSelectionState();
    return;
  }

  if (activeObj.isLocked) {
    displayToast('Locked object cannot be deleted (Unlock with Ctrl+Shift+L first)');
    return;
  }

  canvas.remove(activeObj);
  canvas.discardActiveObject();
  canvas.requestRenderAll();
  saveHistoryState();
  syncToFirebase();
  updateSelectionState();
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
  const activeObj = canvas.getActiveObject() as any;
  if (!activeObj) return;

  const isMulti = activeObj.type?.toLowerCase() === 'activeselection' ||
                  activeObj instanceof fabric.ActiveSelection ||
                  (activeObj._objects && activeObj.type?.toLowerCase() !== 'group');

  if (isMulti) {
    const items = activeObj.getObjects ? activeObj.getObjects() : (activeObj._objects || []);
    if (!items.length) return;
    canvas.discardActiveObject();
    items.forEach((item: any) => canvas?.remove(item));
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
    displayToast('Objects grouped (Ctrl+G)');
  }
};

const ungroupObjects = () => {
  if (!canvas) return;
  const activeObj = canvas.getActiveObject() as any;
  if (!activeObj) return;

  const isGrp = activeObj.type?.toLowerCase() === 'group' || activeObj instanceof fabric.Group;
  if (isGrp && !activeObj.isStickyNote) {
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
    displayToast('Objects ungrouped (Ctrl+Shift+G)');
  }
};

const undo = async () => {
  if (!canvas || historyStack.value.length <= 1) return;

  // Clean up group isolation mode state safely if currently in isolation mode
  if (isIsolationMode.value) {
    isIsolationMode.value = false;
    isolatedGroup = null;
    isolatedItems = [];
  }

  isInternalChange = true;
  const currentState = historyStack.value.pop()!; // remove current state
  redoStack.value.push(currentState);
  const previousState = historyStack.value[historyStack.value.length - 1];
  await canvas.loadFromJSON(previousState);
  rehydrateCanvasObjects();
  syncNodeEditingStateAfterReload();
  canvas.requestRenderAll();
  syncToFirebase();
  updateSelectionState();
  isInternalChange = false;
  displayToast('Undo (Ctrl+Z)');
};

const redo = async () => {
  if (!canvas || redoStack.value.length === 0) return;

  if (isIsolationMode.value) {
    isIsolationMode.value = false;
    isolatedGroup = null;
    isolatedItems = [];
  }

  isInternalChange = true;
  const nextState = redoStack.value.pop()!;
  historyStack.value.push(nextState);
  await canvas.loadFromJSON(nextState);
  rehydrateCanvasObjects();
  syncNodeEditingStateAfterReload();
  canvas.requestRenderAll();
  syncToFirebase();
  updateSelectionState();
  isInternalChange = false;
  displayToast('Redo (Ctrl+Y)');
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
    if (drawing) {
      canvas.discardActiveObject();
    }
    isDrawingMode.value = drawing;
    canvas.isDrawingMode = drawing;
    canvas.selection = !drawing;
    canvas.requestRenderAll();
    updateSelectionState();
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
  isBrushMenuOpen.value = false;
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
    if ((activeObj as any).isLocked) return;
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

const handleCancelCloseModal = () => {
  showCloseConfirmModal.value = false;
};

const handleBroadcast = () => {
  if (!canvas) return;
  const json = getSerializedCanvasJson();
  roomStore.startWhiteboardSession(json);
};

const handleStopBroadcast = async () => {
  if (!canvas) return;
  const json = getSerializedCanvasJson();
  const dataUrl = getCanvasSnapshot(0.7);
  emit('save-state', json, dataUrl, currentAssetId.value);
  hasUnsavedChanges.value = false;
  await roomStore.endWhiteboardSession();
  displayToast('Broadcast stopped — Switched to Local Sketchpad');
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
  const json = getSerializedCanvasJson();
  const dataUrl = getCanvasSnapshot(0.7);
  emit('save-state', json, dataUrl, currentAssetId.value);
  hasUnsavedChanges.value = false;
  showCloseConfirmModal.value = false;
  emit('close');
};

// Keyboard Shortcuts
const handleKeydown = (e: KeyboardEvent) => {
  // 0. ESC inside Confirmation Modal: cancel modal and return to editing
  if (e.key === 'Escape' && showCloseConfirmModal.value) {
    e.preventDefault();
    handleCancelCloseModal();
    return;
  }

  const activeObj = canvas?.getActiveObject() as any;
  const targetTag = (e.target as HTMLElement)?.tagName?.toLowerCase();
  const isInputTarget = targetTag === 'input' || (targetTag === 'textarea' && !(e.target as HTMLElement)?.classList.contains('fabric-canvas-textarea'));

  // If focused in external app input elements (e.g. AI prompt), ignore canvas shortcuts
  if (isInputTarget) return;

  // 1. ESC: Exit sticky/text editing, Arrow Node Editing, or Group Isolation Mode
  if (e.key === 'Escape') {
    if (isArrowNodeEditing.value) {
      e.preventDefault();
      exitArrowNodeEditing();
      return;
    }
    if (activeObj?.isEditing) {
      e.preventDefault();
      activeObj.exitEditing();
      canvas?.requestRenderAll();
      updateSelectionState();
      return;
    }
    if (isIsolationMode.value) {
      e.preventDefault();
      exitGroupIsolation();
      return;
    }
    return;
  }

  // 1.1 Enter in Arrow Node Editing Mode finishes editing
  if (e.key === 'Enter' && isArrowNodeEditing.value) {
    e.preventDefault();
    exitArrowNodeEditing();
    return;
  }

  // 2. Ctrl+Enter: Confirm and exit sticky/text editing
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    if (activeObj?.isEditing) {
      e.preventDefault();
      activeObj.exitEditing();
      canvas?.requestRenderAll();
      updateSelectionState();
      return;
    }
  }

  // 3. Ctrl+S: Quick save whiteboard state anytime (even while typing)
  if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
    e.preventDefault();
    e.stopPropagation();
    handleQuickSave();
    return;
  }

  // 4. Ctrl+L: Lock / Unlock selected object (exit text editing first if active)
  const isLockKey = (e.ctrlKey || e.metaKey) && (e.key === 'l' || e.key === 'L') && !e.shiftKey && !e.altKey;
  if (isLockKey) {
    e.preventDefault();
    e.stopPropagation();
    if (activeObj?.isEditing) {
      activeObj.exitEditing();
    }
    toggleLockSelected();
    return;
  }

  // When actively editing text inside a sticky note or text object, allow typing/editing keys
  // (Backspace, Delete, Arrow keys, Ctrl+A, Ctrl+C, Ctrl+V, Ctrl+X, Ctrl+Z) to be handled naturally by Fabric's hidden textarea
  if (activeObj?.isEditing) return;

  // Whiteboard object-level shortcuts (when NOT editing text)
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (activeObj) {
      e.preventDefault();
      deleteSelected();
    }
  } else if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
    e.preventDefault();
    if (e.shiftKey) {
      redo();
    } else {
      undo();
    }
  } else if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || e.key === 'Y')) {
    e.preventDefault();
    redo();
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
    e.stopPropagation();
    if (e.shiftKey) {
      ungroupObjects();
    } else {
      groupObjects();
    }
  } else if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
    e.preventDefault();
    e.stopPropagation();
    handleQuickSave();
  }
};

const handleWindowClick = () => {
  if (contextMenu.value.visible) {
    contextMenu.value.visible = false;
  }
};

const triggerAutoSaveAsAsset = async () => {
  if (!canvas) return '';
  const json = getSerializedCanvasJson();
  const dataUrl = getCanvasSnapshot(0.7);
  emit('save-state', json, dataUrl, currentAssetId.value);
  hasUnsavedChanges.value = false;
  return json;
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
  handleCloseRequest,
  triggerAutoSaveAsAsset,
  handleStopBroadcast,
  getCanvasSnapshot,
  setCurrentAssetId: (id: string) => { currentAssetId.value = id; },
  getCanvasJson: () => getSerializedCanvasJson()
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
  const target = e.target as Node;
  if (rootRef.value && (rootRef.value === target || rootRef.value.contains(target))) {
    e.preventDefault();
    e.stopPropagation();
  } else if (wrapperRef.value && (wrapperRef.value === target || wrapperRef.value.contains(target))) {
    e.preventDefault();
    e.stopPropagation();
  }
};

// Centralized wheel event interceptor across the entire whiteboard hierarchy
const handleWhiteboardWheel = (e: WheelEvent) => {
  if (!canvas) return;
  const target = e.target as HTMLElement | null;
  if (!rootRef.value || (!rootRef.value.contains(target) && rootRef.value !== target)) {
    return;
  }

  const isDirectCanvas = !!target?.closest('.canvas-container');

  // Always prevent browser window zoom on Ctrl/Cmd + wheel anywhere inside whiteboard
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault();
  }

  // If directly over Fabric canvas, let Fabric's native mouse:wheel listener handle it
  if (isDirectCanvas) {
    return;
  }

  // Allow standard vertical scrolling inside scrollable dropdowns/textareas unless zooming with Ctrl
  const scrollable = target?.closest('.overflow-y-auto, textarea, input');
  if (scrollable && !e.ctrlKey && !e.metaKey) {
    return;
  }

  e.preventDefault();
  e.stopPropagation();

  // Forward wheel action to Fabric canvas
  const rect = canvas.upperCanvasEl?.getBoundingClientRect();
  let pointX = rect ? e.clientX - rect.left : canvas.getWidth() / 2;
  let pointY = rect ? e.clientY - rect.top : canvas.getHeight() / 2;
  pointX = Math.max(0, Math.min(canvas.getWidth(), pointX));
  pointY = Math.max(0, Math.min(canvas.getHeight(), pointY));

  if (e.ctrlKey || e.metaKey) {
    let zoom = canvas.getZoom();
    zoom *= 0.999 ** e.deltaY;
    if (zoom > 5) zoom = 5;
    if (zoom < 0.08) zoom = 0.08;
    canvas.zoomToPoint({ x: pointX, y: pointY } as fabric.Point, zoom);
    clampViewportPan();
    const activeObj = canvas.getActiveObject();
    if (activeObj) activeObj.setCoords();
    updateStickyToolbar();
    updateArrowToolbar();
    viewportVersion.value++;
  } else if (e.altKey) {
    const vpt = canvas.viewportTransform;
    if (vpt) {
      vpt[4] -= e.deltaY;
      clampViewportPan();
      canvas.setViewportTransform(vpt);
      const activeObj = canvas.getActiveObject();
      if (activeObj) activeObj.setCoords();
      updateStickyToolbar();
      updateArrowToolbar();
      viewportVersion.value++;
      canvas.requestRenderAll();
    }
  } else {
    const vpt = canvas.viewportTransform;
    if (vpt) {
      vpt[5] -= e.deltaY;
      clampViewportPan();
      canvas.setViewportTransform(vpt);
      const activeObj = canvas.getActiveObject();
      if (activeObj) activeObj.setCoords();
      updateStickyToolbar();
      updateArrowToolbar();
      viewportVersion.value++;
      canvas.requestRenderAll();
    }
  }
};

onMounted(() => {
  window.addEventListener('keydown', handleKeydown, { capture: true });
  window.addEventListener('click', handleWindowClick);
  window.addEventListener('paste', handleGlobalPaste);
  window.addEventListener('beforeunload', handleBeforeUnload);
  window.addEventListener('contextmenu', handleContextMenuCapture, { capture: true });
  window.addEventListener('wheel', handleWhiteboardWheel, { passive: false });
  if (rootRef.value) {
    rootRef.value.addEventListener('wheel', handleWhiteboardWheel, { passive: false });
  }
  if (wrapperRef.value) {
    wrapperRef.value.addEventListener('contextmenu', handleContextMenuCapture, { capture: true });
  }
  nextTick(() => {
    initFabric();
  });
});

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeydown, { capture: true });
  window.removeEventListener('click', handleWindowClick);
  window.removeEventListener('paste', handleGlobalPaste);
  window.removeEventListener('beforeunload', handleBeforeUnload);
  window.removeEventListener('contextmenu', handleContextMenuCapture, { capture: true });
  window.removeEventListener('wheel', handleWhiteboardWheel);
  if (rootRef.value) {
    rootRef.value.removeEventListener('wheel', handleWhiteboardWheel);
  }
  if (wrapperRef.value) {
    wrapperRef.value.removeEventListener('contextmenu', handleContextMenuCapture, { capture: true });
  }
  if (canvas) {
    canvas.dispose();
  }
});
</script>

<template>
  <div ref="rootRef" class="h-full w-full flex flex-col relative bg-slate-900 overflow-hidden" @contextmenu.prevent>
    <!-- Header -->
    <div
      class="absolute top-4 left-4 z-10 flex items-center gap-2 transition-opacity duration-200"
      :class="{ 'opacity-15': isHoveringSend }"
    >
      <div v-if="roomStore.currentRoom?.whiteboardActive" class="px-2.5 sm:px-3 py-1 sm:py-1.5 rounded-full bg-indigo-600/90 shadow-sm border border-indigo-400 flex items-center gap-1.5 sm:gap-2 text-xs font-semibold text-white animate-pulse">
        <Radio class="w-3.5 h-3.5" />
        <span v-if="whiteboardContainerWidth >= 640">{{ roomStore.currentRoom?.whiteboardHostName }} is Broadcasting</span>
        <span v-else>Live</span>
      </div>
      <div v-else class="px-2.5 sm:px-3 py-1 sm:py-1.5 rounded-full bg-white/90 shadow-sm border border-slate-200 flex items-center gap-1.5 sm:gap-2 text-xs font-semibold text-slate-700">
        <Sparkles class="w-3.5 h-3.5 text-sky-500" />
        <span v-if="whiteboardContainerWidth >= 640">Local Sketchpad</span>
        <span v-else-if="whiteboardContainerWidth >= 480">Local</span>
      </div>
    </div>

    <!-- Group Isolation Mode Top Floating Banner -->
    <div
      v-if="isIsolationMode"
      class="absolute left-1/2 -translate-x-1/2 z-30 flex items-center gap-2 sm:gap-3 px-3 sm:px-4 py-1.5 sm:py-2 bg-slate-900/95 border border-indigo-500/80 rounded-2xl shadow-2xl backdrop-blur-md animate-in fade-in zoom-in-95 whitespace-nowrap select-none shrink-0 pointer-events-auto transition-all"
      :class="whiteboardContainerWidth < 640 ? 'top-14' : 'top-4'"
    >
      <div class="flex items-center gap-1.5 sm:gap-2 text-indigo-300 font-semibold text-xs whitespace-nowrap shrink-0">
        <Group class="w-4 h-4 text-indigo-400 shrink-0" />
        <span v-if="whiteboardContainerWidth >= 640">Group Isolation Mode</span>
        <span v-else-if="whiteboardContainerWidth >= 480">Group Isolation</span>
        <span v-else>Isolation</span>
        <span v-if="whiteboardContainerWidth >= 768" class="text-slate-400 font-normal">(ESC to return)</span>
      </div>
      <button
        @click="exitGroupIsolation"
        class="px-2 sm:px-2.5 py-1 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs transition cursor-pointer whitespace-nowrap shrink-0 shadow-sm"
      >
        <span v-if="whiteboardContainerWidth >= 640">Exit Isolation</span>
        <span v-else>Exit</span>
      </button>
    </div>

    <!-- Arrow & Line Node Editing Mode Top Floating Banner -->
    <div
      v-if="isArrowNodeEditing"
      class="absolute left-1/2 -translate-x-1/2 z-30 flex items-center gap-2 sm:gap-3 px-3 sm:px-4 py-1.5 sm:py-2 bg-slate-900/95 border border-indigo-500/80 rounded-2xl shadow-2xl backdrop-blur-md animate-in fade-in zoom-in-95 whitespace-nowrap select-none shrink-0 pointer-events-auto transition-all"
      :class="whiteboardContainerWidth < 640 ? 'top-14' : 'top-4'"
    >
      <div class="flex items-center gap-1.5 sm:gap-2 text-indigo-300 font-semibold text-xs whitespace-nowrap shrink-0">
        <Waypoints class="w-4 h-4 text-indigo-400 shrink-0" />
        <span v-if="whiteboardContainerWidth >= 480" class="whitespace-nowrap font-medium">Node Edit Mode</span>
        <span v-else class="whitespace-nowrap font-medium">Node Edit</span>
        <span v-if="whiteboardContainerWidth >= 768" class="text-slate-400 font-normal whitespace-nowrap">(Drag nodes to sculpt curve, ESC to exit)</span>
      </div>
      <div class="flex items-center gap-1.5 shrink-0">
        <button
          @click="exitArrowNodeEditing"
          class="px-3 py-1 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs transition cursor-pointer whitespace-nowrap shrink-0 shadow-sm"
        >
          Done
        </button>
      </div>
    </div>
    
    <div
      class="absolute top-4 right-4 z-10 flex items-center gap-1 sm:gap-2 transition-opacity duration-200"
      :class="{ 'opacity-15': isHoveringSend }"
    >
      <button v-if="roomStore.currentRoom?.whiteboardActive && roomStore.currentRoom?.whiteboardHostUid === authStore.uid" @click="handleStopBroadcast()" class="px-2 sm:px-3 py-1 sm:py-1.5 rounded-xl bg-rose-500/90 hover:bg-rose-600 text-white shadow-sm transition text-xs font-semibold flex items-center gap-1 cursor-pointer">
        <X class="w-3.5 h-3.5" />
        <span v-if="whiteboardContainerWidth >= 640">Stop Broadcast</span>
      </button>
      <button v-if="!roomStore.currentRoom?.whiteboardActive" @click="handleBroadcast" class="px-2 sm:px-3 py-1 sm:py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white shadow-sm transition text-xs font-semibold flex items-center gap-1 cursor-pointer">
        <Radio class="w-3.5 h-3.5" />
        <span v-if="whiteboardContainerWidth >= 640">Broadcast</span>
      </button>
      <button @click="showShortcutsModal = true" class="p-1 sm:p-1.5 rounded-xl bg-white/90 hover:bg-white text-slate-600 hover:text-indigo-600 shadow-sm transition cursor-pointer" title="Shortcuts Cheatsheet (?)">
        <HelpCircle class="w-3.5 sm:w-4 h-3.5 sm:h-4" />
      </button>
      <button @click="handleCloseRequest" class="p-1 sm:p-1.5 rounded-xl bg-white/90 hover:bg-white text-slate-500 hover:text-slate-700 shadow-sm transition cursor-pointer" title="Close Panel">
        <X class="w-3.5 sm:w-4 h-3.5 sm:h-4" />
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
      class="flex-1 w-full h-full relative cursor-crosshair transition-[box-shadow] duration-200"
      :class="{ 'ring-4 ring-inset ring-sky-400/90 shadow-[inset_0_0_40px_rgba(56,189,248,0.35)]': isHoveringSend }"
      @contextmenu.prevent
    >
      <canvas ref="canvasRef" class="w-full h-full touch-none"></canvas>

      <!-- Send Viewport Capture Framing Guide / Viewfinder -->
      <div
        v-if="isHoveringSend"
        class="absolute inset-4 sm:inset-8 border-2 border-dashed border-sky-400 pointer-events-none rounded-2xl z-30 flex flex-col justify-start p-3 animate-in fade-in duration-200"
      >
        <div class="flex justify-between items-center w-full">
          <!-- Top Left -->
          <div class="text-[11px] font-mono font-medium text-sky-400 bg-sky-950/90 px-2.5 py-1 rounded-lg border border-sky-500/40 shadow-sm">
            <span>📷 Viewport Snapshot Area</span>
          </div>
          <!-- Top Right -->
          <div class="text-[10px] font-mono text-sky-300/90 bg-slate-900/90 px-2.5 py-1 rounded-lg border border-slate-700 shadow-sm">
            Full visible screen will be captured to chat
          </div>
        </div>
      </div>

      <!-- Floating Quick-Action Bar below Selected Sticky Note -->
      <div
        v-if="stickyToolbarPosition.visible && activeStickyNote"
        class="absolute z-30 flex items-center gap-1.5 p-1.5 bg-slate-900/95 backdrop-blur-md border border-slate-700 rounded-xl shadow-2xl transition-all animate-in fade-in zoom-in-95 pointer-events-auto"
        :class="{ 'opacity-15': isHoveringSend }"
        @mousedown.prevent
        :style="{
          left: `${stickyToolbarPosition.x}px`,
          top: `${stickyToolbarPosition.y}px`,
          transform: 'translate(-50%, 0)'
        }"
      >
        <div class="flex items-center gap-1 px-1">
          <button
            v-for="color in stickyColors"
            :key="color.name"
            @mousedown.prevent
            @click="!isObjectLocked && changeStickyNoteColor(activeStickyNote, color)"
            :disabled="isObjectLocked"
            class="w-4 h-4 rounded-full border border-black/20 hover:scale-125 transition transform cursor-pointer disabled:opacity-30 disabled:hover:scale-100 disabled:cursor-not-allowed"
            :style="{ backgroundColor: color.bg }"
            :title="isObjectLocked ? 'Note is locked' : color.name"
          ></button>
        </div>
        <div class="w-px h-4 bg-slate-700"></div>
        <button
          @mousedown.prevent
          @click="duplicateStickyNote(activeStickyNote)"
          class="p-1 hover:bg-slate-800 text-slate-300 hover:text-white rounded-lg transition cursor-pointer"
          title="Duplicate Note"
        >
          <Copy class="w-3.5 h-3.5" />
        </button>
        <button
          @mousedown.prevent
          @click="toggleLockSelected"
          class="p-1 hover:bg-slate-800 rounded-lg transition cursor-pointer"
          :class="isObjectLocked ? 'text-amber-400 hover:text-amber-300' : 'text-slate-300 hover:text-white'"
          :title="isObjectLocked ? 'Unlock Note (Ctrl+L)' : 'Lock Note (Ctrl+L)'"
        >
          <component :is="isObjectLocked ? Lock : Unlock" class="w-3.5 h-3.5" />
        </button>
        <button
          @mousedown.prevent
          @click="deleteSelected"
          class="p-1 hover:bg-rose-950/60 text-rose-400 hover:text-rose-300 rounded-lg transition cursor-pointer"
          title="Delete Note"
        >
          <Trash2 class="w-3.5 h-3.5" />
        </button>
      </div>

      <!-- Arrow Node Editing Handles Overlay -->
      <div
        v-if="isArrowNodeEditing && editingArrow"
        class="absolute inset-0 pointer-events-none z-30"
      >
        <!-- Connecting guide lines and live preview between nodes -->
        <svg class="w-full h-full absolute inset-0 pointer-events-none">
          <polyline
            :points="nodeScreenPolyline"
            fill="none"
            stroke="#6366f1"
            stroke-width="1.5"
            stroke-dasharray="4,4"
            class="opacity-70"
          />
          <!-- Live Arrow Shaft Preview during Node Drag -->
          <path
            v-if="isDraggingNode && liveNodeArrowSvg.pathD"
            :d="liveNodeArrowSvg.pathD"
            fill="none"
            :stroke="liveNodeArrowSvg.color"
            :stroke-width="liveNodeArrowSvg.strokeWidth"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
          <!-- Live Arrowhead Preview during Node Drag -->
          <polygon
            v-if="isDraggingNode && liveNodeArrowSvg.headPoints"
            :points="liveNodeArrowSvg.headPoints"
            :fill="liveNodeArrowSvg.color"
            :stroke="liveNodeArrowSvg.color"
            stroke-width="1"
            stroke-linejoin="round"
          />
        </svg>

        <!-- Interactive Node Handles -->
        <div
          v-for="(pt, idx) in editingArrowPoints"
          :key="idx"
          @pointerdown="onNodePointerDown(idx, $event)"
          class="absolute -translate-x-1/2 -translate-y-1/2 pointer-events-auto cursor-grab active:cursor-grabbing group transition-transform"
          :style="{
            left: `${getNodeScreenPos(pt).x}px`,
            top: `${getNodeScreenPos(pt).y}px`
          }"
          :title="idx === 0 ? 'Start Node' : idx === editingArrowPoints.length - 1 ? 'End Node' : `Node ${idx}`"
        >
          <div
            class="w-4 h-4 rounded-full border-2 shadow-lg flex items-center justify-center transition-all group-hover:scale-125"
            :class="[
              idx === 0 ? 'bg-emerald-500 border-white text-white ring-2 ring-emerald-400/40' :
              idx === editingArrowPoints.length - 1 ? 'bg-sky-500 border-white text-white ring-2 ring-sky-400/40' :
              'bg-white border-indigo-600 ring-2 ring-indigo-400/30'
            ]"
          >
            <div
              v-if="idx !== 0 && idx !== editingArrowPoints.length - 1"
              class="w-1.5 h-1.5 rounded-full bg-indigo-600"
            ></div>
          </div>
        </div>
      </div>

      <!-- Floating Quick-Action Bar below Selected Line / Arrow -->
      <div
        v-if="arrowToolbarPosition.visible && activeArrow && !isArrowNodeEditing"
        class="absolute z-30 flex items-center gap-1.5 p-1.5 bg-slate-900/95 backdrop-blur-md border border-slate-700 rounded-xl shadow-2xl transition-all animate-in fade-in zoom-in-95 pointer-events-auto whitespace-nowrap select-none"
        :class="{ 'opacity-15': isHoveringSend }"
        @mousedown.prevent
        :style="{
          left: `${arrowToolbarPosition.x}px`,
          top: `${arrowToolbarPosition.y}px`,
          transform: 'translate(-50%, 0)'
        }"
      >
        <button
          @mousedown.prevent
          @click="enterArrowNodeEditing(activeArrow)"
          class="px-2 py-1 bg-indigo-600/30 hover:bg-indigo-600/50 text-indigo-300 hover:text-white rounded-lg transition cursor-pointer flex items-center gap-1.5 text-xs font-medium whitespace-nowrap"
          title="Edit vector line nodes (or double-click to edit)"
        >
          <Waypoints class="w-3.5 h-3.5 text-indigo-400" />
          <span>Edit Nodes</span>
        </button>
        <div class="w-px h-4 bg-slate-700"></div>
        <button
          @mousedown.prevent
          @click="duplicateArrow(activeArrow)"
          class="p-1 hover:bg-slate-800 text-slate-300 hover:text-white rounded-lg transition cursor-pointer"
          title="Duplicate (Ctrl+D)"
        >
          <Copy class="w-3.5 h-3.5" />
        </button>
        <button
          @mousedown.prevent
          @click="toggleLockSelected"
          class="p-1 hover:bg-slate-800 rounded-lg transition cursor-pointer"
          :class="isObjectLocked ? 'text-amber-400 hover:text-amber-300' : 'text-slate-300 hover:text-white'"
          :title="isObjectLocked ? 'Unlock (Ctrl+L)' : 'Lock (Ctrl+L)'"
        >
          <component :is="isObjectLocked ? Lock : Unlock" class="w-3.5 h-3.5" />
        </button>
        <button
          @mousedown.prevent
          @click="deleteSelected"
          class="p-1 hover:bg-rose-950/60 text-rose-400 hover:text-rose-300 rounded-lg transition cursor-pointer"
          title="Delete (Del)"
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


    <div
      class="absolute bottom-4 sm:bottom-6 left-1/2 -translate-x-1/2 z-20 flex items-center gap-1.5 sm:gap-2 transition-all duration-300 w-max max-w-[96%]"
      :class="isStackedToolbar ? 'flex-col items-center' : 'flex-row'"
    >
      <!-- AI Input -->
      <div
        class="flex flex-col gap-1.5 transition-opacity duration-200"
        :class="[
          { 'opacity-15': isHoveringSend },
          isStackedToolbar ? 'w-[220px] max-w-[92vw]' : 'w-[150px] sm:w-[200px]'
        ]"
      >
        <div v-if="isGeneratingSvg" class="h-9 sm:h-10 px-3 bg-slate-900/95 text-sky-400 text-xs font-medium rounded-2xl flex items-center justify-between gap-2 border border-slate-700 shadow-xl">
          <span class="flex items-center gap-1.5 min-w-0 truncate">
            <Loader2 class="w-3.5 h-3.5 animate-spin text-sky-400 shrink-0" />
            <span class="truncate">Generating...</span>
          </span>
          <button
            @click="abortAiGeneration"
            class="px-2 py-0.5 rounded-xl bg-rose-600 hover:bg-rose-500 text-white text-[11px] font-semibold transition cursor-pointer shrink-0"
          >
            Stop
          </button>
        </div>
        <form v-else @submit.prevent="generateAIObject" class="flex items-center h-9 sm:h-10 bg-white/95 rounded-2xl shadow-xl border border-slate-200 p-1">
          <input v-model="aiPrompt" type="text" :placeholder="isStackedToolbar ? 'AI Vector icon, chart...' : 'AI Vector...'" class="flex-1 bg-transparent px-2 py-1 text-xs focus:outline-none text-slate-700 placeholder-slate-400 min-w-0" />
          <button type="submit" :disabled="!aiPrompt.trim()" class="p-1 sm:p-1.5 rounded-xl bg-indigo-100 text-indigo-600 hover:bg-indigo-200 transition disabled:opacity-50 disabled:cursor-not-allowed shrink-0 cursor-pointer">
            <Sparkles class="w-3.5 h-3.5" />
          </button>
        </form>
      </div>

      <!-- Main Tools Bar -->
      <div
        class="h-9 sm:h-10 rounded-2xl border flex items-center transition-all duration-200"
        :class="[
          isHoveringSend ? 'bg-white/10 border-white/10 shadow-none' : 'bg-white/95 border-slate-200 shadow-xl',
          isNarrowToolbar ? 'p-1 gap-0.5' : 'p-1 sm:p-1.5 gap-0.5 sm:gap-1'
        ]"
      >
        <!-- Tool items that dim when hovering send -->
        <div
          class="flex items-center transition-opacity duration-200"
          :class="[
            { 'opacity-15': isHoveringSend },
            isNarrowToolbar ? 'gap-0.5' : 'gap-0.5 sm:gap-1'
          ]"
        >
          <button @click="toggleMode(false)" class="rounded-xl transition cursor-pointer" :class="[currentTool === 'select' ? 'bg-indigo-100 text-indigo-600' : 'hover:bg-slate-100 text-slate-500', isNarrowToolbar ? 'p-1' : 'p-1.5']" title="Select / Move">
            <MousePointer2 class="w-3.5 h-3.5 sm:w-4 sm:h-4" />
          </button>
          
          <div class="relative">
            <button @click="toggleMode(true); isBrushMenuOpen = !isBrushMenuOpen" class="rounded-xl transition flex items-center gap-1 cursor-pointer" :class="[currentTool !== 'select' && currentTool !== 'text' && currentTool !== 'sticky' ? 'bg-indigo-100 text-indigo-600' : 'hover:bg-slate-100 text-slate-500', isNarrowToolbar ? 'p-1' : 'p-1.5']" title="Draw & Shapes">
              <Pencil class="w-3.5 h-3.5 sm:w-4 sm:h-4" />
            </button>
            
            <div v-if="isBrushMenuOpen && isDrawingMode" class="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 bg-white rounded-xl shadow-xl border border-slate-200 p-3 flex flex-col gap-3 min-w-[140px] z-30">
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
                <button @click="addShape('arrow')" class="p-1.5 hover:bg-slate-100 rounded text-slate-500 cursor-pointer" :class="{ 'bg-indigo-100 text-indigo-600': currentTool === 'arrow' }" title="Arrow Brush (箭頭畫筆)"><ArrowUpRight class="w-4 h-4" /></button>
              </div>
            </div>
          </div>
          
          <button @click="addText" class="rounded-xl transition cursor-pointer" :class="[currentTool === 'text' ? 'bg-indigo-100 text-indigo-600' : 'hover:bg-slate-100 text-slate-500', isNarrowToolbar ? 'p-1' : 'p-1.5']" title="Add Text">
            <Type class="w-3.5 h-3.5 sm:w-4 sm:h-4" />
          </button>

          <!-- Sticky Note Tool -->
          <div class="relative">
            <button
              @click="addSticky(); isStickyMenuOpen = !isStickyMenuOpen"
              class="rounded-xl transition flex items-center gap-1 cursor-pointer"
              :class="[currentTool === 'sticky' ? 'bg-indigo-100 text-indigo-600' : 'hover:bg-slate-100 text-slate-500', isNarrowToolbar ? 'p-1' : 'p-1.5']"
              title="Sticky Note (便條紙)"
            >
              <StickyNote class="w-3.5 h-3.5 sm:w-4 sm:h-4" />
            </button>
            <div
              v-if="isStickyMenuOpen"
              class="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 bg-white rounded-xl shadow-xl border border-slate-200 p-2 flex items-center gap-1.5 z-30 min-w-max"
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
          
          <div class="w-px h-4 bg-slate-200 mx-0.5 transition-opacity duration-200" :class="{ 'opacity-15': isHoveringSend }"></div>
          
          <!-- Colors: Full swatches when wide, single picker when compact -->
          <template v-if="isFullColorsVisible">
            <div class="flex items-center gap-1">
              <button v-for="color in colors" :key="color" @click="applyColorToSelected(color)" class="w-4 h-4 sm:w-5 sm:h-5 rounded-full border-2 transition transform hover:scale-110 cursor-pointer" :class="activeColor === color ? 'border-indigo-400 scale-110 shadow-sm' : 'border-transparent opacity-80 hover:opacity-100'" :style="{ backgroundColor: color }"></button>
            </div>
          </template>
          <template v-else>
            <div class="relative">
              <button
                @click="isColorPickerOpen = !isColorPickerOpen"
                class="rounded-xl hover:bg-slate-100 flex items-center gap-0.5 transition cursor-pointer"
                :class="isNarrowToolbar ? 'p-0.5' : 'p-1'"
                title="Change Color"
              >
                <span class="w-3.5 h-3.5 sm:w-4 sm:h-4 rounded-full border border-black/20 shadow-xs" :style="{ backgroundColor: activeColor }"></span>
                <ChevronUp v-if="isColorPickerOpen" class="w-3 h-3 text-slate-400" />
                <ChevronDown v-else class="w-3 h-3 text-slate-400" />
              </button>
              <div
                v-if="isColorPickerOpen"
                class="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 bg-white rounded-xl shadow-xl border border-slate-200 p-2 flex items-center gap-1.5 z-30 min-w-max animate-in fade-in zoom-in-95"
              >
                <button
                  v-for="color in colors"
                  :key="color"
                  @click="applyColorToSelected(color); isColorPickerOpen = false"
                  class="w-5 h-5 rounded-full border-2 transition transform hover:scale-110 cursor-pointer"
                  :class="activeColor === color ? 'border-indigo-400 scale-110 shadow-sm' : 'border-transparent opacity-80 hover:opacity-100'"
                  :style="{ backgroundColor: color }"
                ></button>
              </div>
            </div>
          </template>
          
          <div class="w-px h-4 bg-slate-200 mx-0.5 transition-opacity duration-200" :class="{ 'opacity-15': isHoveringSend }"></div>
          
          <div class="flex items-center" :class="isNarrowToolbar ? 'gap-0.5' : 'gap-0.5 sm:gap-1'">
            <input ref="fileInputRef" type="file" accept="image/*" class="hidden" @change="handleImageUpload" />
            <button @click="fileInputRef?.click()" class="rounded-xl hover:bg-slate-100 text-slate-500 transition cursor-pointer" :class="isNarrowToolbar ? 'p-1' : 'p-1.5'" title="Add Image"><ImageIcon class="w-3.5 h-3.5 sm:w-4 sm:h-4" /></button>
            <button @click="undo" class="rounded-xl hover:bg-slate-100 text-slate-500 transition cursor-pointer" :class="[{'opacity-50 cursor-not-allowed': historyStack.length <= 1}, isNarrowToolbar ? 'p-1' : 'p-1.5']" title="Undo (Ctrl+Z)" :disabled="historyStack.length <= 1"><Undo2 class="w-3.5 h-3.5 sm:w-4 sm:h-4" /></button>
            <button @click="redo" class="rounded-xl hover:bg-slate-100 text-slate-500 transition cursor-pointer" :class="[{'opacity-50 cursor-not-allowed': redoStack.length === 0}, isNarrowToolbar ? 'p-1' : 'p-1.5']" title="Redo (Ctrl+Y / Ctrl+Shift+Z)" :disabled="redoStack.length === 0"><Redo2 class="w-3.5 h-3.5 sm:w-4 sm:h-4" /></button>
            <button @click="deleteSelected" class="rounded-xl hover:bg-rose-100 text-rose-500 transition cursor-pointer" :class="isNarrowToolbar ? 'p-1' : 'p-1.5'" title="Delete Selected (Del)"><Trash2 class="w-3.5 h-3.5 sm:w-4 sm:h-4" /></button>
          </div>
        </div>
        
        <div class="w-px h-4 bg-slate-200 mx-0.5 transition-opacity duration-200" :class="{ 'opacity-15': isHoveringSend }"></div>
        
        <!-- Send Viewport Button: always fully interactive and bright -->
        <button
          @click="handleSendToChat"
          @mouseenter="isHoveringSend = true"
          @mouseleave="isHoveringSend = false"
          class="rounded-xl bg-sky-500 hover:bg-sky-600 active:bg-sky-700 text-white transition-all flex items-center gap-1.5 text-xs font-medium cursor-pointer shadow-lg shrink-0 select-none z-30 opacity-100"
          :class="[
            isSendTextVisible ? 'px-2.5 py-1 sm:py-1.5' : isNarrowToolbar ? 'p-1' : 'p-1.5 px-2',
            isHoveringSend ? 'ring-2 ring-sky-300 scale-105' : 'shadow-xs'
          ]"
          title="Send visible viewport area to chat"
        >
          <Send class="w-3.5 h-3.5" />
          <span v-if="isSendTextVisible">Send Viewport</span>
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
            <component :is="isObjectLocked ? Lock : Unlock" class="w-3.5 h-3.5" :class="isObjectLocked ? 'text-amber-400' : 'text-slate-400'" />
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
      <div class="bg-slate-900 border border-slate-800 rounded-2xl p-6 max-w-lg w-full shadow-2xl text-slate-100 space-y-4 animate-in fade-in zoom-in-95">
        <div class="flex items-center justify-between pb-2 border-b border-slate-800">
          <div class="flex items-center gap-2 font-bold text-sm text-slate-200">
            <HelpCircle class="w-4 h-4 text-indigo-400" />
            <span>Whiteboard Keyboard Shortcuts</span>
          </div>
          <button @click="showShortcutsModal = false" class="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition cursor-pointer">
            <X class="w-4 h-4" />
          </button>
        </div>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
          <!-- Quick Save -->
          <div class="flex items-center justify-between p-2.5 rounded-xl bg-slate-950/60 border border-slate-800/80">
            <span class="text-slate-300 font-medium">Quick Save</span>
            <div class="flex items-center gap-1">
              <kbd class="px-2 py-0.5 rounded-md bg-slate-800 border border-slate-700 border-b-2 border-b-slate-600 font-mono text-[10px] text-indigo-300 font-semibold shadow-xs">Ctrl</kbd>
              <span class="text-slate-500 text-[10px]">+</span>
              <kbd class="px-2 py-0.5 rounded-md bg-slate-800 border border-slate-700 border-b-2 border-b-slate-600 font-mono text-[10px] text-indigo-300 font-semibold shadow-xs">S</kbd>
            </div>
          </div>
          <!-- Lock / Unlock -->
          <div class="flex items-center justify-between p-2.5 rounded-xl bg-slate-950/60 border border-slate-800/80">
            <span class="text-slate-300 font-medium">Lock / Unlock</span>
            <div class="flex items-center gap-1">
              <kbd class="px-2 py-0.5 rounded-md bg-slate-800 border border-slate-700 border-b-2 border-b-slate-600 font-mono text-[10px] text-indigo-300 font-semibold shadow-xs">Ctrl</kbd>
              <span class="text-slate-500 text-[10px]">+</span>
              <kbd class="px-2 py-0.5 rounded-md bg-slate-800 border border-slate-700 border-b-2 border-b-slate-600 font-mono text-[10px] text-indigo-300 font-semibold shadow-xs">L</kbd>
            </div>
          </div>
          <!-- Group Objects -->
          <div class="flex items-center justify-between p-2.5 rounded-xl bg-slate-950/60 border border-slate-800/80">
            <span class="text-slate-300 font-medium">Group</span>
            <div class="flex items-center gap-1">
              <kbd class="px-2 py-0.5 rounded-md bg-slate-800 border border-slate-700 border-b-2 border-b-slate-600 font-mono text-[10px] text-indigo-300 font-semibold shadow-xs">Ctrl</kbd>
              <span class="text-slate-500 text-[10px]">+</span>
              <kbd class="px-2 py-0.5 rounded-md bg-slate-800 border border-slate-700 border-b-2 border-b-slate-600 font-mono text-[10px] text-indigo-300 font-semibold shadow-xs">G</kbd>
            </div>
          </div>
          <!-- Ungroup -->
          <div class="flex items-center justify-between p-2.5 rounded-xl bg-slate-950/60 border border-slate-800/80">
            <span class="text-slate-300 font-medium">Ungroup</span>
            <div class="flex items-center gap-1">
              <kbd class="px-1.5 py-0.5 rounded-md bg-slate-800 border border-slate-700 border-b-2 border-b-slate-600 font-mono text-[10px] text-indigo-300 font-semibold shadow-xs">Ctrl</kbd>
              <span class="text-slate-500 text-[10px]">+</span>
              <kbd class="px-1.5 py-0.5 rounded-md bg-slate-800 border border-slate-700 border-b-2 border-b-slate-600 font-mono text-[10px] text-indigo-300 font-semibold shadow-xs">Shift</kbd>
              <span class="text-slate-500 text-[10px]">+</span>
              <kbd class="px-1.5 py-0.5 rounded-md bg-slate-800 border border-slate-700 border-b-2 border-b-slate-600 font-mono text-[10px] text-indigo-300 font-semibold shadow-xs">G</kbd>
            </div>
          </div>
          <!-- Copy / Paste -->
          <div class="flex items-center justify-between p-2.5 rounded-xl bg-slate-950/60 border border-slate-800/80">
            <span class="text-slate-300 font-medium">Copy</span>
            <div class="flex items-center gap-1">
              <kbd class="px-2 py-0.5 rounded-md bg-slate-800 border border-slate-700 border-b-2 border-b-slate-600 font-mono text-[10px] text-indigo-300 font-semibold shadow-xs">Ctrl</kbd>
              <span class="text-slate-500 text-[10px]">+</span>
              <kbd class="px-2 py-0.5 rounded-md bg-slate-800 border border-slate-700 border-b-2 border-b-slate-600 font-mono text-[10px] text-indigo-300 font-semibold shadow-xs">C</kbd>
            </div>
          </div>
          <div class="flex items-center justify-between p-2.5 rounded-xl bg-slate-950/60 border border-slate-800/80">
            <span class="text-slate-300 font-medium">Paste</span>
            <div class="flex items-center gap-1">
              <kbd class="px-2 py-0.5 rounded-md bg-slate-800 border border-slate-700 border-b-2 border-b-slate-600 font-mono text-[10px] text-indigo-300 font-semibold shadow-xs">Ctrl</kbd>
              <span class="text-slate-500 text-[10px]">+</span>
              <kbd class="px-2 py-0.5 rounded-md bg-slate-800 border border-slate-700 border-b-2 border-b-slate-600 font-mono text-[10px] text-indigo-300 font-semibold shadow-xs">V</kbd>
            </div>
          </div>
          <!-- Cut / Delete -->
          <div class="flex items-center justify-between p-2.5 rounded-xl bg-slate-950/60 border border-slate-800/80">
            <span class="text-slate-300 font-medium">Cut</span>
            <div class="flex items-center gap-1">
              <kbd class="px-2 py-0.5 rounded-md bg-slate-800 border border-slate-700 border-b-2 border-b-slate-600 font-mono text-[10px] text-indigo-300 font-semibold shadow-xs">Ctrl</kbd>
              <span class="text-slate-500 text-[10px]">+</span>
              <kbd class="px-2 py-0.5 rounded-md bg-slate-800 border border-slate-700 border-b-2 border-b-slate-600 font-mono text-[10px] text-indigo-300 font-semibold shadow-xs">X</kbd>
            </div>
          </div>
          <div class="flex items-center justify-between p-2.5 rounded-xl bg-slate-950/60 border border-slate-800/80">
            <span class="text-slate-300 font-medium">Delete</span>
            <div class="flex items-center gap-1">
              <kbd class="px-2 py-0.5 rounded-md bg-slate-800 border border-slate-700 border-b-2 border-b-slate-600 font-mono text-[10px] text-rose-300 font-semibold shadow-xs">Del</kbd>
              <span class="text-slate-500 text-[10px]">/</span>
              <kbd class="px-1.5 py-0.5 rounded-md bg-slate-800 border border-slate-700 border-b-2 border-b-slate-600 font-mono text-[10px] text-rose-300 font-semibold shadow-xs">⌫</kbd>
            </div>
          </div>
          <!-- Undo -->
          <div class="flex items-center justify-between p-2.5 rounded-xl bg-slate-950/60 border border-slate-800/80">
            <span class="text-slate-300 font-medium">Undo</span>
            <div class="flex items-center gap-1">
              <kbd class="px-2 py-0.5 rounded-md bg-slate-800 border border-slate-700 border-b-2 border-b-slate-600 font-mono text-[10px] text-indigo-300 font-semibold shadow-xs">Ctrl</kbd>
              <span class="text-slate-500 text-[10px]">+</span>
              <kbd class="px-2 py-0.5 rounded-md bg-slate-800 border border-slate-700 border-b-2 border-b-slate-600 font-mono text-[10px] text-indigo-300 font-semibold shadow-xs">Z</kbd>
            </div>
          </div>
          <!-- Redo -->
          <div class="flex items-center justify-between p-2.5 rounded-xl bg-slate-950/60 border border-slate-800/80">
            <span class="text-slate-300 font-medium">Redo</span>
            <div class="flex items-center gap-1">
              <kbd class="px-2 py-0.5 rounded-md bg-slate-800 border border-slate-700 border-b-2 border-b-slate-600 font-mono text-[10px] text-indigo-300 font-semibold shadow-xs">Ctrl</kbd>
              <span class="text-slate-500 text-[10px]">+</span>
              <kbd class="px-2 py-0.5 rounded-md bg-slate-800 border border-slate-700 border-b-2 border-b-slate-600 font-mono text-[10px] text-indigo-300 font-semibold shadow-xs">Y</kbd>
            </div>
          </div>
          <!-- Select All -->
          <div class="flex items-center justify-between p-2.5 rounded-xl bg-slate-950/60 border border-slate-800/80">
            <span class="text-slate-300 font-medium">Select All</span>
            <div class="flex items-center gap-1">
              <kbd class="px-2 py-0.5 rounded-md bg-slate-800 border border-slate-700 border-b-2 border-b-slate-600 font-mono text-[10px] text-indigo-300 font-semibold shadow-xs">Ctrl</kbd>
              <span class="text-slate-500 text-[10px]">+</span>
              <kbd class="px-2 py-0.5 rounded-md bg-slate-800 border border-slate-700 border-b-2 border-b-slate-600 font-mono text-[10px] text-indigo-300 font-semibold shadow-xs">A</kbd>
            </div>
          </div>
          <!-- Zoom -->
          <div class="flex items-center justify-between p-2.5 rounded-xl bg-slate-950/60 border border-slate-800/80">
            <span class="text-slate-300 font-medium">Zoom Canvas</span>
            <div class="flex items-center gap-1">
              <kbd class="px-2 py-0.5 rounded-md bg-slate-800 border border-slate-700 border-b-2 border-b-slate-600 font-mono text-[10px] text-indigo-300 font-semibold shadow-xs">Ctrl</kbd>
              <span class="text-slate-500 text-[10px]">+</span>
              <kbd class="px-2 py-0.5 rounded-md bg-slate-800 border border-slate-700 border-b-2 border-b-slate-600 font-mono text-[10px] text-indigo-300 font-semibold shadow-xs">Wheel</kbd>
            </div>
          </div>
          <!-- Pan -->
          <div class="flex items-center justify-between p-2.5 rounded-xl bg-slate-950/60 border border-slate-800/80">
            <span class="text-slate-300 font-medium">Pan Canvas</span>
            <div class="flex items-center gap-1">
              <kbd class="px-1.5 py-0.5 rounded-md bg-slate-800 border border-slate-700 border-b-2 border-b-slate-600 font-mono text-[10px] text-indigo-300 font-semibold shadow-xs">Alt+Wheel</kbd>
              <span class="text-slate-500 text-[10px]">/</span>
              <kbd class="px-1.5 py-0.5 rounded-md bg-slate-800 border border-slate-700 border-b-2 border-b-slate-600 font-mono text-[10px] text-indigo-300 font-semibold shadow-xs">Mid Drag</kbd>
            </div>
          </div>
          <div class="col-span-1 sm:col-span-2 p-2.5 rounded-xl bg-slate-950/60 border border-slate-800/80 text-[11px] text-slate-300 flex items-center gap-2">
            <span class="text-indigo-400 font-bold shrink-0">💡 Note:</span>
            <span><strong class="text-indigo-300">Group Isolation:</strong> Double-click any group to edit individual elements. Press <kbd class="px-1.5 py-0.5 bg-slate-800 border border-slate-700 rounded-md font-mono text-[10px] text-slate-200">ESC</kbd> or click "Exit Isolation" to return.</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Unsaved Changes Confirmation Modal (English) -->
    <div
      v-if="showCloseConfirmModal"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4"
      @click.self="handleCancelCloseModal"
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
            @click="handleCancelCloseModal"
            class="px-3 py-2 rounded-xl text-xs font-semibold text-slate-400 hover:text-slate-200 hover:bg-slate-800 border border-slate-700 transition cursor-pointer"
          >
            Cancel
          </button>
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

<style scoped>
:deep(.canvas-container) {
  width: 100% !important;
  height: 100% !important;
  position: relative !important;
}
:deep(.lower-canvas) {
  position: absolute !important;
  top: 0 !important;
  left: 0 !important;
  z-index: 0 !important;
  pointer-events: none !important;
}
:deep(.upper-canvas) {
  position: absolute !important;
  top: 0 !important;
  left: 0 !important;
  z-index: 1 !important;
  pointer-events: auto !important;
}
</style>
