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
  X, Pencil, Image as ImageIcon, Undo2, Redo2, Trash2, Maximize, Minimize, Check, Loader2, Sparkles, Send, Radio, Settings2, MousePointer2, Type, Square, Circle, Triangle, Minus, ArrowUpRight, Group, Ungroup, BringToFront, SendToBack, MoveUp, MoveDown, Copy, Scissors, ClipboardPaste, AlertTriangle, AlertCircle, RefreshCw, ChevronDown, ChevronUp, StickyNote, MoreHorizontal, Lock, Unlock, HelpCircle, Waypoints, Globe, MicOff, Save, User, Users, Camera, CloudOff
} from 'lucide-vue-next';
import { db } from '../firebase/config';
import { doc, collection, onSnapshot, setDoc, deleteDoc, type Unsubscribe } from 'firebase/firestore';
import type { CursorData } from '../types';
import { generateSvgForWhiteboard } from '../services/ai';

const props = withDefaults(defineProps<{
  initialJson?: string;
  activeAssetId?: string | null;
  isSharedSession?: boolean;
}>(), {
  isSharedSession: true
});

const isCollabActive = computed(() => !!roomStore.currentRoom?.whiteboardActive && props.isSharedSession);

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'share', file: File): void;
  (e: 'save-state', json: string, previewDataUrl: string, assetId?: string | null, isPrivate?: boolean): void;
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
  'arrowCornerIndices',
  'lockMovementX',
  'lockMovementY',
  'lockRotation',
  'lockScalingX',
  'lockScalingY',
  'hasControls',
  'isClosedLoop',
  'padding',
  'authorUid',
  'id',
  'fontSize',
  '_origEndpointCorners'
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
const lockToolbarPosition = ref({ x: 0, y: 0, visible: false, hasLocked: false, allLocked: false });
const hasIsolationChanged = ref(false);

// Arrow Floating Toolbar & Node Editing State
const activeArrow = shallowRef<any>(null);
const arrowToolbarPosition = ref({ x: 0, y: 0, visible: false });
const isArrowNodeEditing = ref(false);
const editingArrow = shallowRef<any>(null);
const editingNodeIndex = ref<number | null>(null);
const editingArrowPoints = ref<Array<{ x: number; y: number }>>([]);
const editingArrowCorners = ref<Set<number>>(new Set());
const selectedNodeIndices = ref<Set<number>>(new Set());
const isNodeMarqueeActive = ref(false);
const nodeMarqueeRect = ref<{ x1: number; y1: number; x2: number; y2: number }>({ x1: 0, y1: 0, x2: 0, y2: 0 });
const isDraggingNode = ref(false);
const showNodeHelp = ref(false);
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

// User-scoped Undo/Redo tracking: strictly reverts local user's own actions
interface UserUndoItem {
  targetId: string;
  authorUid: string;
  objectJson?: any;
  beforeProps?: any;
  afterProps?: any;
}

interface UserUndoAction {
  type: 'add' | 'remove' | 'modify';
  items: UserUndoItem[];
}

const localUserUndoStack = ref<UserUndoAction[]>([]);
const localUserRedoStack = ref<UserUndoAction[]>([]);
const canUndo = computed(() => isCollabActive.value ? localUserUndoStack.value.length > 0 : historyStack.value.length > 1);
const canRedo = computed(() => isCollabActive.value ? localUserRedoStack.value.length > 0 : redoStack.value.length > 0);

// Selection & Context Menu state
let clipboard: any = null;
let contextMenuScenePoint: { x: number; y: number } | null = null;
const contextMenu = ref({ visible: false, x: 0, y: 0 });
const hasSelection = ref(false);
const isMultiSelection = ref(false);
const isGroupSelected = ref(false);
const isObjectLocked = ref(false);

// Group Isolation Mode (Illustrator style, supports nested stack)
interface IsolationLevel {
  group: any;
  items: any[];
  savedProps: Array<{ obj: any; opacity: number; selectable: boolean; evented: boolean }>;
}
const isIsolationMode = ref(false);
const isolationStack = ref<IsolationLevel[]>([]);
let isolatedGroup: any = null;
let isolatedItems: any[] = [];

// Hover highlight & toast & cheatsheet
const isHoveringSend = ref(false);
const toastMsg = ref('');
const showToast = ref(false);
let toastTimer: any = null;
const displayToast = (msg: string, duration = 2500) => {
  toastMsg.value = msg;
  showToast.value = true;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { showToast.value = false; }, duration);
};
const showShortcutsModal = ref(false);

const viewfinderBounds = computed(() => {
  if (!canvas || !wrapperRef.value) return null;
  void viewportVersion.value;
  const screenW = canvas.getWidth();
  const screenH = canvas.getHeight();
  const vpt = canvas.viewportTransform || [1, 0, 0, 1, 0, 0];
  const zoom = canvas.getZoom();

  // Workspace bounds in screen coordinates
  const wsScreenLeft = vpt[4];
  const wsScreenTop = vpt[5];
  const wsScreenRight = WORKSPACE_WIDTH * zoom + vpt[4];
  const wsScreenBottom = WORKSPACE_HEIGHT * zoom + vpt[5];

  // Intersection between visible container and editable workspace
  const l = Math.max(0, wsScreenLeft);
  const t = Math.max(0, wsScreenTop);
  const r = Math.min(screenW, wsScreenRight);
  const b = Math.min(screenH, wsScreenBottom);

  const w = r - l;
  const h = b - t;
  if (w <= 40 || h <= 40) return null;
  const pad = 14;
  return {
    left: Math.round(l + pad),
    top: Math.round(t + pad),
    width: Math.round(w - pad * 2),
    height: Math.round(h - pad * 2)
  };
});

const updateFloatingToolbars = () => {
  updateStickyToolbar();
  updateArrowToolbar();
  updateLockToolbar();
};

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

const getObjectSceneBoundingBox = (o: any) => {
  let m = o.calcTransformMatrix();
  if (o.group) {
    let currGroup = o.group;
    const groupM = currGroup.calcTransformMatrix();
    m = fabric.util.multiplyTransformMatrices(groupM, o.calcTransformMatrix());
  }
  const halfW = (o.width || 0) / 2;
  const halfH = (o.height || 0) / 2;
  const corners = [
    fabric.util.transformPoint({ x: -halfW, y: -halfH }, m),
    fabric.util.transformPoint({ x: halfW, y: -halfH }, m),
    fabric.util.transformPoint({ x: halfW, y: halfH }, m),
    fabric.util.transformPoint({ x: -halfW, y: halfH }, m)
  ];
  const minX = Math.min(...corners.map(c => c.x));
  const maxX = Math.max(...corners.map(c => c.x));
  const minY = Math.min(...corners.map(c => c.y));
  const maxY = Math.max(...corners.map(c => c.y));
  return {
    left: minX,
    top: minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY)
  };
};

const updateLockToolbar = () => {
  if (!canvas || isArrowNodeEditing.value) {
    lockToolbarPosition.value.visible = false;
    return;
  }
  const active = canvas.getActiveObject() as any;
  if (!active) {
    lockToolbarPosition.value.visible = false;
    return;
  }

  const isMulti = active.type?.toLowerCase() === 'activeselection' || !!active._objects;
  const targets: any[] = isMulti && active.getObjects ? active.getObjects() : (active._objects ? active._objects : [active]);
  const hasLocked = targets.some((o: any) => o.isLocked || (o as any).hasLockedChildren);
  const allLocked = targets.length > 0 && targets.every((o: any) => o.isLocked);

  if (!hasLocked) {
    lockToolbarPosition.value.visible = false;
    return;
  }

  active.setCoords();
  const vpt = canvas.viewportTransform || [1, 0, 0, 1, 0, 0];
  const coords = active.getCoords ? active.getCoords(true, true) : null;
  if (coords && coords.length >= 4) {
    const minSceneX = Math.min(coords[0].x, coords[1].x, coords[2].x, coords[3].x);
    const maxSceneX = Math.max(coords[0].x, coords[1].x, coords[2].x, coords[3].x);
    const maxSceneY = Math.max(coords[0].y, coords[1].y, coords[2].y, coords[3].y);
    const midSceneX = (minSceneX + maxSceneX) / 2;

    const screenPos = fabric.util.transformPoint({ x: midSceneX, y: maxSceneY }, vpt);

    lockToolbarPosition.value = {
      x: screenPos.x,
      y: screenPos.y + 16,
      visible: true,
      hasLocked,
      allLocked
    };
  } else {
    const bound = active.getBoundingRect(true);
    const screenPos = fabric.util.transformPoint({ x: bound.left + bound.width / 2, y: bound.top + bound.height }, vpt);
    lockToolbarPosition.value = {
      x: screenPos.x,
      y: screenPos.y + 16,
      visible: true,
      hasLocked,
      allLocked
    };
  }
};
let lockedGlowObjects: any[] = [];

const highlightLockedObjects = () => {
  if (!canvas) return;
  const active = canvas.getActiveObject() as any;
  if (!active) return;
  const targets: any[] = (active.type === 'activeselection' || active instanceof fabric.ActiveSelection || active.type === 'group') 
    ? (active.getObjects ? active.getObjects() : active._objects || []) 
    : [active];
  
  clearLockedHighlights();

  const applyGlow = (obj: any) => {
    if (obj._hasGlowHighlight) return;
    obj._hasGlowHighlight = true;
    obj._origShadow = obj.shadow !== undefined ? obj.shadow : null;
    obj.set({
      shadow: new fabric.Shadow({
        color: '#f59e0b',
        blur: 18,
        offsetX: 0,
        offsetY: 0
      })
    });
    lockedGlowObjects.push(obj);
  };

  targets.forEach((o: any) => {
    if (o.isLocked) {
      applyGlow(o);
      if (o.type === 'group' && o.getObjects) {
        o.getObjects().forEach((child: any) => applyGlow(child));
      }
    } else if (o.hasLockedChildren && o.getObjects) {
      o.getObjects().forEach((child: any) => {
        if (child.isLocked) applyGlow(child);
      });
    }
  });
  canvas.requestRenderAll();
};

const clearLockedHighlights = () => {
  if (!canvas || lockedGlowObjects.length === 0) return;
  lockedGlowObjects.forEach(obj => {
    if (obj._hasGlowHighlight) {
      obj.set({
        shadow: obj._origShadow
      });
      delete obj._hasGlowHighlight;
      delete obj._origShadow;
    }
  });
  lockedGlowObjects = [];
  canvas.requestRenderAll();
};
const unlockSelectedObjects = () => {
  if (!canvas) return;
  const active = canvas.getActiveObject() as any;
  if (!active) return;

  const unlockItem = (item: any) => {
    item.isLocked = false;
    item.set({
      lockMovementX: false,
      lockMovementY: false,
      lockRotation: false,
      lockScalingX: false,
      lockScalingY: false,
      hasControls: true,
      selectable: true,
      evented: true,
      isLocked: false
    });
    item.setControlsVisibility({
      tl: true, tr: true, bl: true, br: true,
      ml: true, mr: true, mt: true, mb: true, mtr: true
    });
    if (item.isStickyNote || item.stickyColorConfig) {
      setupStickyControls(item);
    }
    if (item.type === 'group' || item instanceof fabric.Group) {
      item.hasLockedChildren = false;
      const children = item.getObjects ? item.getObjects() : item._objects || [];
      children.forEach((c: any) => unlockItem(c));
    }
    item.setCoords();
  };

  if (active.type?.toLowerCase() === 'activeselection' || active instanceof fabric.ActiveSelection) {
    const targets = active.getObjects ? active.getObjects() : active._objects || [];
    targets.forEach((o: any) => unlockItem(o));
    active.isLocked = false;
    active.set({
      lockMovementX: false,
      lockMovementY: false,
      lockRotation: false,
      lockScalingX: false,
      lockScalingY: false,
      hasControls: true,
      selectable: true,
      evented: true,
      isLocked: false
    });
    active.setControlsVisibility({
      tl: true, tr: true, bl: true, br: true,
      ml: true, mr: true, mt: true, mb: true, mtr: true
    });
    active.setCoords();
  } else {
    unlockItem(active);
  }

  isObjectLocked.value = false;
  lockToolbarPosition.value.visible = false;
  lockToolbarPosition.value.hasLocked = false;
  clearLockedHighlights();
  updateSelectionState();
  updateFloatingToolbars();
  canvas.setActiveObject(active);
  canvas.requestRenderAll();
  saveHistoryState();
  syncToFirebase();
  displayToast('Unlocked');
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

  let totalScreenLen = 0;
  for (let i = 1; i < sPts.length; i++) {
    totalScreenLen += Math.hypot(sPts[i].x - sPts[i - 1].x, sPts[i].y - sPts[i - 1].y);
  }
  if (totalScreenLen < 6) return { pathD: '', headPoints: '', color, strokeWidth: screenWidth };

  // If endpoints are brought close together or arrow is closed loop, render as a smooth closed loop and hide arrowhead
  const isClosed = sPts.length >= 3 && (sDist < 25 || ((editingArrow.value as any)?.isClosedLoop && sDist < 35));
  if (isClosed) {
    const shaftSampled = [...sPts];
    shaftSampled[shaftSampled.length - 1] = { x: s0.x, y: s0.y };
    let pathD = `M ${s0.x.toFixed(1)} ${s0.y.toFixed(1)}`;
    const m = shaftSampled.length - 1;
    const effCorners = new Set(editingArrowCorners.value);
    const startSharp = effCorners.has(0);
    const endSharp = effCorners.has(m);
    if (startSharp !== endSharp) {
      effCorners.delete(0);
      effCorners.delete(m);
    }

    for (let i = 0; i < m; i++) {
      const isCurCorner = effCorners.has(i);
      const isNextCorner = effCorners.has(i + 1);

      if (isCurCorner || isNextCorner) {
        pathD += ` L ${shaftSampled[i + 1].x.toFixed(1)} ${shaftSampled[i + 1].y.toFixed(1)}`;
      } else {
        const pPrev = i === 0 ? shaftSampled[m - 1] : shaftSampled[i - 1];
        const pCur = shaftSampled[i];
        const pNext = shaftSampled[i + 1];
        const pAfter = i + 1 === m ? shaftSampled[1] : shaftSampled[i + 2];

        const cp1x = pCur.x + (pNext.x - pPrev.x) / 6;
        const cp1y = pCur.y + (pNext.y - pPrev.y) / 6;
        const cp2x = pNext.x - (pAfter.x - pCur.x) / 6;
        const cp2y = pNext.y - (pAfter.y - pCur.y) / 6;

        pathD += ` C ${cp1x.toFixed(1)} ${cp1y.toFixed(1)}, ${cp2x.toFixed(1)} ${cp2y.toFixed(1)}, ${pNext.x.toFixed(1)} ${pNext.y.toFixed(1)}`;
      }
    }
    pathD += ' Z';
    return {
      pathD,
      headPoints: '',
      color,
      strokeWidth: screenWidth
    };
  }

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
  let sCur = s0;
  if (sPts.length >= 2) {
    const m = sPts.length - 1;
    sCur = sPts[m - 1];
    const sPrev = sPts[Math.max(0, m - 2)];
    const isCorner = editingArrowCorners.value.has(m) || editingArrowCorners.value.has(m - 1);
    tangentAngle = Math.atan2(sn.y - sCur.y, sn.x - sCur.x);
    if (!isCorner && m >= 2) {
      const vx = 1.5 * (sn.x - sCur.x) - 0.5 * (sCur.x - sPrev.x);
      const vy = 1.5 * (sn.y - sCur.y) - 0.5 * (sCur.y - sPrev.y);
      if (Math.hypot(vx, vy) > 1e-4) {
        const curveAngle = Math.atan2(vy, vx);
        const angleDiff = Math.atan2(Math.sin(curveAngle - tangentAngle), Math.cos(curveAngle - tangentAngle));
        if (Math.abs(angleDiff) < Math.PI / 3) {
          tangentAngle = curveAngle;
        }
      }
    }
  }

  const sDistToCur = Math.hypot(sn.x - sCur.x, sn.y - sCur.y);
  const shaftCut = Math.min(Math.max(2, (rawWidth * zoom) * 0.4), headLen * 0.2, sDistToCur * 0.35);
  const shaftEndX = sn.x - shaftCut * Math.cos(tangentAngle);
  const shaftEndY = sn.y - shaftCut * Math.sin(tangentAngle);

  const w1x = sn.x - headLen * Math.cos(tangentAngle - headAngle);
  const w1y = sn.y - headLen * Math.sin(tangentAngle - headAngle);
  const w2x = sn.x - headLen * Math.cos(tangentAngle + headAngle);
  const w2y = sn.y - headLen * Math.sin(tangentAngle + headAngle);
  const headPoints = `${sn.x.toFixed(1)},${sn.y.toFixed(1)} ${w1x.toFixed(1)},${w1y.toFixed(1)} ${w2x.toFixed(1)},${w2y.toFixed(1)}`;

  let pathD = '';
  if (sPts.length < 3) {
    pathD = `M ${s0.x.toFixed(1)} ${s0.y.toFixed(1)} L ${shaftEndX.toFixed(1)} ${shaftEndY.toFixed(1)}`;
  } else {
    const shaftSampled = [...sPts];
    shaftSampled[shaftSampled.length - 1] = { x: shaftEndX, y: shaftEndY };
    pathD = `M ${shaftSampled[0].x.toFixed(1)} ${shaftSampled[0].y.toFixed(1)}`;
    const m = shaftSampled.length - 1;
    for (let i = 0; i < m; i++) {
      const isCurCorner = editingArrowCorners.value.has(i);
      const isNextCorner = editingArrowCorners.value.has(i + 1);

      if (isCurCorner || isNextCorner) {
        pathD += ` L ${shaftSampled[i + 1].x.toFixed(1)} ${shaftSampled[i + 1].y.toFixed(1)}`;
      } else {
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
  selectedNodeIndices.value.clear();

  if (Array.isArray(arrow.arrowPoints) && arrow.arrowPoints.length > 0) {
    const M0 = (arrow as any).initialMatrix || arrow.calcTransformMatrix();
    const M1 = arrow.calcTransformMatrix();
    let pts = arrow.arrowPoints.map((p: any) => ({ x: p.x, y: p.y }));

    let matrixChanged = false;
    for (let i = 0; i < 6; i++) {
      if (Math.abs(M1[i] - M0[i]) > 1e-4) {
        matrixChanged = true;
        break;
      }
    }
    if (matrixChanged) {
      try {
        const invM0 = fabric.util.invertTransform(M0);
        const M_delta = fabric.util.multiplyTransformMatrices(M1, invM0);
        pts = pts.map((pt: any) => fabric.util.transformPoint(pt, M_delta));

        // Recreate the arrow at scale=1, angle=0 with the transformed world points
        const updated = createArrowFromPoints(pts, (arrow as any).arrowColor, (arrow as any).arrowStrokeWidth, true, (arrow as any).arrowCornerIndices);
        if (updated && canvas) {
          (updated as any).arrowId = (arrow as any).arrowId;
          (updated as any).isLocked = (arrow as any).isLocked;
          (updated as any).authorUid = (arrow as any).authorUid;
          (updated as any).authorName = (arrow as any).authorName;
          const allObjs = canvas.getObjects();
          const idx = allObjs.indexOf(arrow);
          if (idx !== -1) {
            canvas.remove(arrow);
            canvas.insertAt(idx, updated);
            arrow = updated;
          }
        }
      } catch (err) {
        console.warn('Failed to transform arrow nodes:', err);
      }
    }

    editingArrow.value = arrow;
    editingArrowPoints.value = pts;
    const existingCorners = Array.isArray((arrow as any).arrowCornerIndices) ? (arrow as any).arrowCornerIndices : [];
    editingArrowCorners.value = new Set(existingCorners);
    (arrow as any).arrowPoints = pts.map((p: any) => ({ ...p }));
    (arrow as any).initialMatrix = arrow.calcTransformMatrix();
  } else {
    return;
  }

  arrow.set({
    hasControls: false,
    selectable: false,
    evented: false
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
  selectedNodeIndices.value.clear();
  isDraggingNode.value = false;
  isNodeMarqueeActive.value = false;
  showNodeHelp.value = false;

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

const commitEditingArrowPoints = () => {
  if (!editingArrow.value || !canvas) return;
  const color = (editingArrow.value as any).arrowColor || activeColor.value;
  const width = (editingArrow.value as any).arrowStrokeWidth || strokeWidth.value;
  const isLocked = !!(editingArrow.value as any).isLocked;
  const arrowId = (editingArrow.value as any).arrowId;
  const authorUid = (editingArrow.value as any).authorUid;
  const authorName = (editingArrow.value as any).authorName;

  const finalArrow = createArrowFromPoints(
    editingArrowPoints.value,
    color,
    width,
    true,
    editingArrowCorners.value,
    (editingArrow.value as any)?._origEndpointCorners
  );
  if (finalArrow) {
    finalArrow.set({
      hasControls: false,
      selectable: true,
      evented: true,
      visible: true
    });
    (finalArrow as any).isLocked = isLocked;
    (finalArrow as any).arrowId = arrowId;
    (finalArrow as any).authorUid = authorUid;
    (finalArrow as any).authorName = authorName;

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
    if (Array.isArray((finalArrow as any).arrowPoints)) {
      editingArrowPoints.value = (finalArrow as any).arrowPoints.map((p: any) => ({ x: p.x, y: p.y }));
    }
    finalArrow.setCoords();
  } else {
    editingArrow.value.visible = true;
  }
  canvas.requestRenderAll();
  saveHistoryState();
  syncToFirebase();
};

const toggleNodeCorner = (index: number) => {
  if (editingArrowCorners.value.has(index)) {
    editingArrowCorners.value.delete(index);
  } else {
    editingArrowCorners.value.add(index);
  }
  if ((editingArrow.value as any)?.isClosedLoop) {
    const lastIdx = editingArrowPoints.value.length - 1;
    if (index === 0 || index === lastIdx) {
      const isSharp = editingArrowCorners.value.has(index);
      if (isSharp) {
        editingArrowCorners.value.add(0);
        editingArrowCorners.value.add(lastIdx);
      } else {
        editingArrowCorners.value.delete(0);
        editingArrowCorners.value.delete(lastIdx);
      }
      (editingArrow.value as any)._origEndpointCorners = null;
    }
  }
  commitEditingArrowPoints();
};

const deleteSelectedArrowNodes = () => {
  if (!isArrowNodeEditing.value || !editingArrow.value) return;
  if (selectedNodeIndices.value.size === 0) return;

  const pts = [...editingArrowPoints.value];
  if (pts.length <= 2) {
    displayToast('Cannot delete: arrow requires at least 2 endpoints');
    return;
  }

  // Filter out selected nodes, but never allow deleting endpoints unless closed loop with >= 3 pts
  const indicesToDelete = new Set(selectedNodeIndices.value);
  // Keep start and end nodes if open curve
  const isClosed = !!(editingArrow.value as any)?.isClosedLoop;
  if (!isClosed) {
    indicesToDelete.delete(0);
    indicesToDelete.delete(pts.length - 1);
  }

  if (indicesToDelete.size === 0) {
    displayToast('Cannot delete start or end node of arrow');
    return;
  }

  if (pts.length - indicesToDelete.size < 2) {
    displayToast('Cannot delete: arrow requires at least 2 nodes');
    return;
  }

  const newPts: Array<{ x: number; y: number }> = [];
  const newCorners = new Set<number>();

  for (let i = 0; i < pts.length; i++) {
    if (!indicesToDelete.has(i)) {
      const newIdx = newPts.length;
      newPts.push(pts[i]);
      if (editingArrowCorners.value.has(i)) {
        newCorners.add(newIdx);
      }
    }
  }

  editingArrowPoints.value = newPts;
  editingArrowCorners.value = newCorners;
  selectedNodeIndices.value.clear();
  commitEditingArrowPoints();
  displayToast('Selected node(s) deleted');
};

const insertNodeOnArrowStroke = (e: MouseEvent) => {
  if (!isArrowNodeEditing.value || !editingArrow.value || !wrapperRef.value || !canvas) return;
  const rect = wrapperRef.value.getBoundingClientRect();
  const vpt = canvas.viewportTransform || [1, 0, 0, 1, 0, 0];
  const clickX = (e.clientX - rect.left - vpt[4]) / vpt[0];
  const clickY = (e.clientY - rect.top - vpt[5]) / vpt[3];

  const pts = editingArrowPoints.value;
  if (pts.length < 2) return;

  // Find the closest projection segment on the polyline
  let bestDistSq = Infinity;
  let bestInsertIndex = 1;
  let bestPoint = { x: clickX, y: clickY };

  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    if (lenSq < 1e-6) continue;

    const t = Math.max(0, Math.min(1, ((clickX - a.x) * dx + (clickY - a.y) * dy) / lenSq));
    const projX = a.x + t * dx;
    const projY = a.y + t * dy;
    const distSq = (clickX - projX) * (clickX - projX) + (clickY - projY) * (clickY - projY);

    if (distSq < bestDistSq) {
      bestDistSq = distSq;
      bestInsertIndex = i + 1;
      bestPoint = { x: projX, y: projY };
    }
  }

  // Insert the new node
  const newPts = [...pts];
  newPts.splice(bestInsertIndex, 0, bestPoint);

  // Shift existing corner indices >= bestInsertIndex
  const newCorners = new Set<number>();
  editingArrowCorners.value.forEach(idx => {
    if (idx >= bestInsertIndex) newCorners.add(idx + 1);
    else newCorners.add(idx);
  });

  editingArrowPoints.value = newPts;
  editingArrowCorners.value = newCorners;
  selectedNodeIndices.value = new Set([bestInsertIndex]);
  commitEditingArrowPoints();
  displayToast('Node added to stroke');
};

const onStrokePointerDown = (e: PointerEvent) => {
  if (e.button !== 0) return; // only primary left button
  if (!isArrowNodeEditing.value || !editingArrow.value || !canvas) return;

  const startClientX = e.clientX;
  const startClientY = e.clientY;
  const initPoints = editingArrowPoints.value.map(pt => ({ ...pt }));
  let hasMoved = false;

  const onPointerMove = (ev: PointerEvent) => {
    const dx = ev.clientX - startClientX;
    const dy = ev.clientY - startClientY;
    if (!hasMoved && Math.hypot(dx, dy) < 4) {
      return;
    }
    if (!hasMoved) {
      hasMoved = true;
      isDraggingNode.value = true;
      if (editingArrow.value) {
        editingArrow.value.visible = false;
        canvas?.requestRenderAll();
      }
    }

    const vpt = canvas?.viewportTransform || [1, 0, 0, 1, 0, 0];
    const sceneDx = dx / vpt[0];
    const sceneDy = dy / vpt[3];

    editingArrowPoints.value = initPoints.map(pt => ({
      x: pt.x + sceneDx,
      y: pt.y + sceneDy
    }));
  };

  const onPointerUp = () => {
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    if (hasMoved) {
      isDraggingNode.value = false;
      commitEditingArrowPoints();
    }
  };

  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
};

const onNodePointerDown = (index: number, e: PointerEvent) => {
  e.preventDefault();
  e.stopPropagation();

  // Multi-selection management with Shift key or regular click
  if (e.shiftKey) {
    if (selectedNodeIndices.value.has(index)) {
      selectedNodeIndices.value.delete(index);
    } else {
      selectedNodeIndices.value.add(index);
    }
  } else {
    if (!selectedNodeIndices.value.has(index)) {
      selectedNodeIndices.value.clear();
      selectedNodeIndices.value.add(index);
    }
  }

  editingNodeIndex.value = index;
  isDraggingNode.value = true;

  if (editingArrow.value) {
    editingArrow.value.visible = false;
    canvas?.requestRenderAll();
  }

  let animFrameId: number | null = null;
  const initialClientX = e.clientX;
  const initialClientY = e.clientY;
  const initialPointsMap = new Map<number, { x: number; y: number }>();
  selectedNodeIndices.value.forEach(idx => {
    if (editingArrowPoints.value[idx]) {
      initialPointsMap.set(idx, { ...editingArrowPoints.value[idx] });
    }
  });

  const onPointerMove = (ev: PointerEvent) => {
    if (!canvas || !wrapperRef.value || !editingArrow.value) return;
    const vpt = canvas.viewportTransform || [1, 0, 0, 1, 0, 0];
    const deltaSceneX = (ev.clientX - initialClientX) / vpt[0];
    const deltaSceneY = (ev.clientY - initialClientY) / vpt[3];

    if (!animFrameId) {
      animFrameId = requestAnimationFrame(() => {
        animFrameId = null;
        initialPointsMap.forEach((initPt, idx) => {
          editingArrowPoints.value[idx] = {
            x: initPt.x + deltaSceneX,
            y: initPt.y + deltaSceneY
          };
          if ((editingArrow.value as any)?.isClosedLoop && idx === 0) {
            editingArrowPoints.value[editingArrowPoints.value.length - 1] = {
              x: initPt.x + deltaSceneX,
              y: initPt.y + deltaSceneY
            };
          }
        });
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

    const pts = editingArrowPoints.value;
    if (pts.length >= 3 && editingArrow.value) {
      const p0 = pts[0];
      const pn = pts[pts.length - 1];
      const endpointDist = Math.hypot(pn.x - p0.x, pn.y - p0.y);
      let totalArcLen = 0;
      for (let i = 1; i < pts.length; i++) {
        totalArcLen += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
      }
      const isLoop = totalArcLen >= 30 && endpointDist < 30;
      const arrowObj = editingArrow.value as any;
      if (isLoop) {
        const startSharp = editingArrowCorners.value.has(0);
        const endSharp = editingArrowCorners.value.has(pts.length - 1);
        if (startSharp !== endSharp) {
          if (!arrowObj._origEndpointCorners) {
            arrowObj._origEndpointCorners = { start: startSharp, end: endSharp };
          }
          editingArrowCorners.value.delete(0);
          editingArrowCorners.value.delete(pts.length - 1);
        }
        arrowObj.isClosedLoop = true;
      } else {
        arrowObj.isClosedLoop = false;
        if (arrowObj._origEndpointCorners) {
          if (arrowObj._origEndpointCorners.start) editingArrowCorners.value.add(0);
          else editingArrowCorners.value.delete(0);
          if (arrowObj._origEndpointCorners.end) editingArrowCorners.value.add(pts.length - 1);
          else editingArrowCorners.value.delete(pts.length - 1);
          arrowObj._origEndpointCorners = null;
        }
      }
    }

    editingNodeIndex.value = null;
    isDraggingNode.value = false;
    commitEditingArrowPoints();
  };

  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
};

const startNodeMarquee = (e: MouseEvent) => {
  if (!isArrowNodeEditing.value || !wrapperRef.value) return;
  const rect = wrapperRef.value.getBoundingClientRect();
  const startX = e.clientX - rect.left;
  const startY = e.clientY - rect.top;

  isNodeMarqueeActive.value = true;
  nodeMarqueeRect.value = { x1: startX, y1: startY, x2: startX, y2: startY };

  if (!e.shiftKey) {
    selectedNodeIndices.value.clear();
  }

  const onMarqueeMove = (ev: MouseEvent) => {
    const curX = ev.clientX - rect.left;
    const curY = ev.clientY - rect.top;
    nodeMarqueeRect.value = {
      x1: Math.min(startX, curX),
      y1: Math.min(startY, curY),
      x2: Math.max(startX, curX),
      y2: Math.max(startY, curY)
    };

    // Calculate which node screen positions lie inside this marquee
    const r = nodeMarqueeRect.value;
    editingArrowPoints.value.forEach((pt, idx) => {
      const scr = getNodeScreenPos(pt);
      if (scr.x >= r.x1 && scr.x <= r.x2 && scr.y >= r.y1 && scr.y <= r.y2) {
        selectedNodeIndices.value.add(idx);
      } else if (!e.shiftKey) {
        selectedNodeIndices.value.delete(idx);
      }
    });
  };

  const onMarqueeUp = () => {
    window.removeEventListener('mousemove', onMarqueeMove);
    window.removeEventListener('mouseup', onMarqueeUp);
    isNodeMarqueeActive.value = false;
  };

  window.addEventListener('mousemove', onMarqueeMove);
  window.addEventListener('mouseup', onMarqueeUp);
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

  // Apply current transform delta so points match visual position before offset
  let transformedPts = pts;
  if (arrow.initialMatrix) {
    const invOldM = fabric.util.invertTransform(arrow.initialMatrix);
    const newM = arrow.calcTransformMatrix();
    const deltaM = fabric.util.multiplyTransformMatrices(newM, invOldM);
    transformedPts = pts.map((p: any) => {
      const tp = fabric.util.transformPoint(new fabric.Point(p.x, p.y), deltaM);
      return { x: tp.x, y: tp.y };
    });
  }

  const newPts = transformedPts.map((p: any) => ({ x: p.x + offset, y: p.y + offset }));
  let newObj: any;
  if (arrow.isArrow) {
    const color = (arrow as any).arrowColor || activeColor.value;
    const width = (arrow as any).arrowStrokeWidth || strokeWidth.value;
    const cornerIndices = (arrow as any).arrowCornerIndices;
    const origCorners = (arrow as any)._origEndpointCorners;
    newObj = createArrowFromPoints(newPts, color, width, true, cornerIndices, origCorners);
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
    lockToolbarPosition.value.visible = false;
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
    const hasSticky = targets.some((o: any) => o.isStickyNote || o.stickyColorConfig);
    isObjectLocked.value = anyLocked;
    active.set({
      lockMovementX: allLocked,
      lockMovementY: allLocked,
      lockRotation: allLocked,
      lockScalingX: allLocked,
      lockScalingY: allLocked,
      hasControls: !allLocked
    });
    // Multi-selection controls: ALWAYS enable single-axis scale handles (ml, mr, mt, mb) and rotation
    active.setControlsVisibility({
      tl: true, tr: true, bl: true, br: true,
      ml: true, mr: true, mt: true, mb: true, mtr: true
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
      hasControls: !shouldFreeze,
      lockUniScaling: false,
      lockScalingFlip: true
    });
    active.setControlsVisibility({
      tl: true, tr: true, bl: true, br: true,
      ml: true, mr: true, mt: true, mb: true, mtr: true
    });
  } else if (active && (active.isStickyNote || active.stickyColorConfig)) {
    active.set({ lockUniScaling: true, lockScalingFlip: true });
    isObjectLocked.value = !!(active && active.isLocked === true);
  } else {
    isObjectLocked.value = !!(active && active.isLocked === true);
  }
  updateFloatingToolbars();
  updateArrowToolbar();
  updateLockToolbar();
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

let isTakingSnapshot = false;

// Snapshot helper: clips strictly to workspace bounds (eliminating dark borders) and supports high-res exports
const getCanvasSnapshot = (quality = 0.7, highRes = false): string => {
  if (!canvas) return '';
  isTakingSnapshot = true;
  try {
    const screenW = canvas.getWidth();
    const screenH = canvas.getHeight();
    const vpt = canvas.viewportTransform || [1, 0, 0, 1, 0, 0];
    const zoom = canvas.getZoom();

    // Workspace bounds in screen coordinates
    const wsScreenLeft = vpt[4];
    const wsScreenTop = vpt[5];
    const wsScreenRight = WORKSPACE_WIDTH * zoom + vpt[4];
    const wsScreenBottom = WORKSPACE_HEIGHT * zoom + vpt[5];

    // Intersection between visible viewport and actual workspace
    const cropLeft = Math.max(0, wsScreenLeft);
    const cropTop = Math.max(0, wsScreenTop);
    const cropRight = Math.min(screenW, wsScreenRight);
    const cropBottom = Math.min(screenH, wsScreenBottom);

    const cropW = cropRight - cropLeft;
    const cropH = cropBottom - cropTop;

    // Fallback if user is panned completely away
    const isOutOfView = cropW <= 10 || cropH <= 10;
    const finalCropLeft = isOutOfView ? 0 : cropLeft;
    const finalCropTop = isOutOfView ? 0 : cropTop;
    const finalCropW = isOutOfView ? screenW : cropW;
    const finalCropH = isOutOfView ? screenH : cropH;

    // High-res output dimensions (min 1600px width for chat viewports)
    let outW = finalCropW;
    let outH = finalCropH;
    if (highRes || quality >= 0.8) {
      outW = Math.max(Math.round(finalCropW * 2), 1600);
      outH = Math.round(outW * (finalCropH / finalCropW));
    } else if (quality <= 0.4) {
      outW = Math.min(Math.round(finalCropW), 400);
      outH = Math.max(1, Math.round(outW * (finalCropH / finalCropW)));
    }

    const offscreen = document.createElement('canvas');
    offscreen.width = outW;
    offscreen.height = outH;
    const ctx = offscreen.getContext('2d');
    if (!ctx) {
      return canvas.toDataURL({ format: 'jpeg', quality, multiplier: 1 });
    }

    // 1. Fill clean light background (no dot grid per user requirement)
    ctx.fillStyle = '#f8fafc';
    ctx.fillRect(0, 0, outW, outH);

    // 2. Draw fabric elements clipped strictly to workspace intersection at true high resolution
    const scaleOut = outW / finalCropW;
    let renderedVector = false;
    if ((highRes || quality >= 0.8) && typeof (canvas as any).toCanvasElement === 'function') {
      try {
        const vectorEl = (canvas as any).toCanvasElement(scaleOut, {
          left: finalCropLeft,
          top: finalCropTop,
          width: finalCropW,
          height: finalCropH
        });
        if (vectorEl && vectorEl.width > 0 && vectorEl.height > 0) {
          ctx.drawImage(vectorEl, 0, 0, outW, outH);
          renderedVector = true;
        }
      } catch (err) {
        console.warn('Vector snapshot fallback to lowerCanvas:', err);
      }
    }

    if (!renderedVector) {
      const lowerCanvas = canvas.lowerCanvasEl;
      if (lowerCanvas) {
        const dpr = lowerCanvas.width / screenW;
        const sx = finalCropLeft * dpr;
        const sy = finalCropTop * dpr;
        const sw = finalCropW * dpr;
        const sh = finalCropH * dpr;
        ctx.drawImage(lowerCanvas, sx, sy, sw, sh, 0, 0, outW, outH);
      }
    }

    return offscreen.toDataURL('image/jpeg', quality);
  } finally {
    isTakingSnapshot = false;
  }
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

// Live Collaborative Cursors & Real-Time Smoothing (60fps RAF lerp)
interface SmoothCursor {
  uid: string;
  name: string;
  avatar: string;
  color: string;
  currentX: number;
  currentY: number;
  targetX: number;
  targetY: number;
  liveStroke?: { points: { x: number; y: number }[]; color: string; width: number; tool: string } | null;
  strokeCompletedAt?: number;
  liveShape?: {
    shapeType: 'rect' | 'circle' | 'triangle' | 'line';
    x: number;
    y: number;
    w: number;
    h: number;
    color: string;
    strokeWidth: number;
    fill?: string;
  } | null;
  shapeCompletedAt?: number;
}

const remoteCursors = ref<Record<string, CursorData>>({});
const smoothedCursors = ref<Record<string, SmoothCursor>>({});
let unsubCursors: Unsubscribe | null = null;
let lastCursorBroadcast = 0;
let lastCursorPos = { x: -9999, y: -9999 };
let cursorLerpRafId: number | null = null;

const currentLiveDrag = ref<{
  targetId: string;
  left: number;
  top: number;
  scaleX?: number;
  scaleY?: number;
  angle?: number;
} | null>(null);

const currentLiveShape = ref<{
  shapeType: 'rect' | 'circle' | 'triangle' | 'line';
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  strokeWidth: number;
  fill?: string;
} | null>(null);

const currentLiveText = ref<{
  targetId: string;
  text: string;
} | null>(null);

const sampleStrokePoints = (points: Array<{ x: number; y: number }>, maxPoints = 150) => {
  if (points.length <= maxPoints) return points.map(p => ({ x: Math.round(p.x), y: Math.round(p.y) }));
  const step = (points.length - 1) / (maxPoints - 1);
  const result: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < maxPoints - 1; i++) {
    const pt = points[Math.round(i * step)];
    result.push({ x: Math.round(pt.x), y: Math.round(pt.y) });
  }
  result.push({ x: Math.round(points[points.length - 1].x), y: Math.round(points[points.length - 1].y) });
  return result;
};

const getTriangleScreenPoints = (s: { x: number; y: number; w: number; h: number }) => {
  const p1 = getNodeScreenPos({ x: s.x + s.w / 2, y: s.y });
  const p2 = getNodeScreenPos({ x: s.x + s.w, y: s.y + s.h });
  const p3 = getNodeScreenPos({ x: s.x, y: s.y + s.h });
  return `${p1.x.toFixed(1)},${p1.y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)} ${p3.x.toFixed(1)},${p3.y.toFixed(1)}`;
};

const updateLiveDrag = (opt: any) => {
  const target = opt?.target as any;
  if (!target || target.isLocked || !canvas) return;
  const id = target.id || target.arrowId;
  if (!id) return;
  currentLiveDrag.value = {
    targetId: id,
    left: Math.round(target.left || 0),
    top: Math.round(target.top || 0),
    scaleX: Number((target.scaleX || 1).toFixed(3)),
    scaleY: Number((target.scaleY || 1).toFixed(3)),
    angle: Number((target.angle || 0).toFixed(1))
  };
  broadcastMyCursor(opt);
};

const CURSOR_COLORS = [
  '#6366f1', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6',
  '#06b6d4', '#f97316', '#14b8a6', '#3b82f6', '#e11d48'
];
const getCursorColor = (uid: string) => {
  let hash = 0;
  for (let i = 0; i < uid.length; i++) {
    hash = (hash << 5) - hash + uid.charCodeAt(i);
    hash |= 0;
  }
  return CURSOR_COLORS[Math.abs(hash) % CURSOR_COLORS.length];
};

const startCursorLerpLoop = () => {
  if (cursorLerpRafId) cancelAnimationFrame(cursorLerpRafId);
  const loop = () => {
    for (const uid in smoothedCursors.value) {
      const c = smoothedCursors.value[uid];
      if (typeof c.targetX !== 'number' || isNaN(c.targetX) || typeof c.targetY !== 'number' || isNaN(c.targetY)) {
        continue;
      }
      if (typeof c.currentX !== 'number' || isNaN(c.currentX)) c.currentX = c.targetX;
      if (typeof c.currentY !== 'number' || isNaN(c.currentY)) c.currentY = c.targetY;

      const dx = c.targetX - c.currentX;
      const dy = c.targetY - c.currentY;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist > 350) {
        c.currentX = c.targetX;
        c.currentY = c.targetY;
      } else if (dist > 0.1) {
        c.currentX += dx * 0.45;
        c.currentY += dy * 0.45;
      } else {
        c.currentX = c.targetX;
        c.currentY = c.targetY;
      }
    }
    cursorLerpRafId = requestAnimationFrame(loop);
  };
  cursorLerpRafId = requestAnimationFrame(loop);
};

const stopCursorLerpLoop = () => {
  if (cursorLerpRafId) {
    cancelAnimationFrame(cursorLerpRafId);
    cursorLerpRafId = null;
  }
};

const pointsToSvgPath = (points: { x: number; y: number }[]) => {
  if (!points || points.length < 2) return '';
  return points.map((p, idx) => {
    const sp = getNodeScreenPos(p);
    return `${idx === 0 ? 'M' : 'L'} ${sp.x.toFixed(1)} ${sp.y.toFixed(1)}`;
  }).join(' ');
};

const broadcastMyCursor = (opt: any) => {
  if (!isCollabActive.value || !db || !authStore.uid || !roomStore.currentRoom) return;
  const now = Date.now();
  if (now - lastCursorBroadcast < 35) return; // 35ms throttle (~30Hz update)

  if (!canvas) return;
  let rawPointer: any = null;
  try {
    if (opt && (opt.e || opt.x !== undefined)) {
      rawPointer = (canvas as any).getScenePoint ? (canvas as any).getScenePoint(opt.e || opt) : ((canvas as any).getPointer?.(opt.e || opt) || null);
    }
  } catch {}

  const pointerX = (rawPointer && Number.isFinite(rawPointer.x)) ? rawPointer.x : (Number.isFinite(lastCursorPos.x) && lastCursorPos.x !== -9999 ? lastCursorPos.x : 0);
  const pointerY = (rawPointer && Number.isFinite(rawPointer.y)) ? rawPointer.y : (Number.isFinite(lastCursorPos.y) && lastCursorPos.y !== -9999 ? lastCursorPos.y : 0);

  const dx = Math.abs(pointerX - lastCursorPos.x);
  const dy = Math.abs(pointerY - lastCursorPos.y);
  if (dx < 2 && dy < 2 && !isMouseDown && !currentLiveDrag.value && !currentLiveShape.value && !currentLiveText.value) return;

  lastCursorBroadcast = now;
  lastCursorPos = { x: pointerX, y: pointerY };

  const roomId = roomStore.currentRoom.roomId;
  const cursorRef = doc(db, 'rooms', roomId, 'cursors', authStore.uid);

  let liveStrokePayload = null;
  if (isMouseDown && (currentTool.value === 'draw' || currentTool.value === 'arrow') && pencilStrokePoints.length >= 2) {
    liveStrokePayload = {
      points: sampleStrokePoints(pencilStrokePoints, 150),
      color: activeColor.value,
      width: strokeWidth.value,
      tool: currentTool.value
    };
  }

  setDoc(cursorRef, {
    uid: authStore.uid,
    name: authStore.displayName || 'Guest',
    avatar: authStore.avatar || '🎨',
    color: getCursorColor(authStore.uid),
    x: Math.round(pointerX),
    y: Math.round(pointerY),
    updatedAt: now,
    liveStroke: liveStrokePayload,
    liveDrag: currentLiveDrag.value,
    liveShape: currentLiveShape.value,
    liveText: currentLiveText.value
  }).catch(() => {});
};

const removeMyCursor = () => {
  if (!db || !authStore.uid || !roomStore.currentRoom) return;
  const roomId = roomStore.currentRoom.roomId;
  const cursorRef = doc(db, 'rooms', roomId, 'cursors', authStore.uid);
  deleteDoc(cursorRef).catch(() => {});
};

const startCursorListener = () => {
  if (unsubCursors) {
    unsubCursors();
    unsubCursors = null;
  }
  if (!isCollabActive.value || !db || !roomStore.currentRoom) return;
  const roomId = roomStore.currentRoom.roomId;
  const cursorsCol = collection(db, 'rooms', roomId, 'cursors');
  unsubCursors = onSnapshot(cursorsCol, (snapshot) => {
    const map: Record<string, CursorData> = {};
    const now = Date.now();
    snapshot.forEach(docSnap => {
      const data = docSnap.data() as CursorData;
      if (data.uid !== authStore.uid && now - data.updatedAt < 10000) {
        map[data.uid] = data;
        if (smoothedCursors.value[data.uid]) {
          smoothedCursors.value[data.uid].targetX = data.x;
          smoothedCursors.value[data.uid].targetY = data.y;
          smoothedCursors.value[data.uid].name = data.name;
          smoothedCursors.value[data.uid].avatar = data.avatar;
          smoothedCursors.value[data.uid].color = data.color;
          if (data.liveStroke) {
            smoothedCursors.value[data.uid].liveStroke = data.liveStroke;
            smoothedCursors.value[data.uid].strokeCompletedAt = undefined;
          } else if (smoothedCursors.value[data.uid].liveStroke) {
            // Keep remote stroke temporarily so it doesn't flicker/vanish before Firestore state arrives
            if (!smoothedCursors.value[data.uid].strokeCompletedAt) {
              smoothedCursors.value[data.uid].strokeCompletedAt = Date.now();
            } else if (Date.now() - (smoothedCursors.value[data.uid].strokeCompletedAt || 0) > 4000) {
              smoothedCursors.value[data.uid].liveStroke = null;
              smoothedCursors.value[data.uid].strokeCompletedAt = undefined;
            }
          }

          if (data.liveShape) {
            smoothedCursors.value[data.uid].liveShape = data.liveShape;
            smoothedCursors.value[data.uid].shapeCompletedAt = undefined;
          } else if (smoothedCursors.value[data.uid].liveShape) {
            if (!smoothedCursors.value[data.uid].shapeCompletedAt) {
              smoothedCursors.value[data.uid].shapeCompletedAt = Date.now();
            } else if (Date.now() - (smoothedCursors.value[data.uid].shapeCompletedAt || 0) > 4000) {
              smoothedCursors.value[data.uid].liveShape = null;
              smoothedCursors.value[data.uid].shapeCompletedAt = undefined;
            }
          }
        } else {
          smoothedCursors.value[data.uid] = {
            uid: data.uid,
            name: data.name,
            avatar: data.avatar,
            color: data.color,
            currentX: data.x,
            currentY: data.y,
            targetX: data.x,
            targetY: data.y,
            liveStroke: data.liveStroke,
            liveShape: data.liveShape
          };
        }

        // Apply liveDrag smoothly from remote peer
        if (data.liveDrag && canvas) {
          const live = data.liveDrag;
          const targetObj = canvas.getObjects().find((o: any) => (o.id === live.targetId || o.arrowId === live.targetId));
          if (targetObj && canvas.getActiveObject() !== targetObj) {
            targetObj.set({
              left: live.left,
              top: live.top,
              ...(live.scaleX !== undefined ? { scaleX: live.scaleX } : {}),
              ...(live.scaleY !== undefined ? { scaleY: live.scaleY } : {}),
              ...(live.angle !== undefined ? { angle: live.angle } : {})
            });
            targetObj.setCoords();
            canvas.requestRenderAll();
          }
        }

        // Apply liveText character-by-character from remote peer in real time
        if (data.liveText && canvas) {
          const live = data.liveText;
          const targetObj = canvas.getObjects().find((o: any) => (o.id === live.targetId || o.arrowId === live.targetId)) as any;
          if (targetObj && canvas.getActiveObject() !== targetObj) {
            if (targetObj.text !== live.text) {
              targetObj.set({ text: live.text });
              if (targetObj.isStickyNote || targetObj.stickyColorConfig) {
                targetObj.initDimensions?.();
              }
              targetObj.setCoords?.();
              canvas.requestRenderAll();
            }
          }
        }
      }
    });
    // Clean stale cursors
    for (const uid in smoothedCursors.value) {
      if (!map[uid]) {
        delete smoothedCursors.value[uid];
      }
    }
    remoteCursors.value = map;
  }, (err) => {
    console.warn('[Cursors] listener error:', err);
  });

  startCursorLerpLoop();
};

// Muted Participant Canvas Lock
const isCurrentUserMuted = computed(() => {
  return !!roomStore.currentRoom?.participants?.[authStore.uid]?.isMuted;
});

// Whiteboard Publish / Private Dropdown & Modal
const showPublishMenu = ref(false);
const showPrivateConfirmModal = ref(false);
const isConvertingToPrivate = ref(false);

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

const createArrowFromPoints = (
  pts: Array<{ x: number; y: number }>,
  customColor?: string,
  customWidth?: number,
  isExactNodes = false,
  cornerIndices?: Set<number> | number[],
  origCorners?: { start: boolean; end: boolean } | null
) => {
  if (pts.length < 2) return null;
  const p0 = pts[0];
  const pn = pts[pts.length - 1];
  let totalArcLen = 0;
  for (let i = 1; i < pts.length; i++) {
    totalArcLen += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  }
  if (totalArcLen < 6) return null;

  const endpointDist = Math.hypot(pn.x - p0.x, pn.y - p0.y);
  const isClosedLoop = pts.length >= 3 && totalArcLen >= 30 && endpointDist < 30;
  const lineLen = endpointDist;

  const color = customColor || activeColor.value;
  const width = customWidth || strokeWidth.value;

  // 1. Straight line check: ONLY when creating fresh arrow with 2 points, never squash curved/multinode strokes
  const isStraight = !isClosedLoop && !isExactNodes && pts.length === 2;
  let finalPts: Array<{ x: number; y: number }>;

  const headLen = Math.max(14, width * 3.6);
  const headAngle = Math.PI / 6; // 30 degrees

  let shaft: any;
  let tangentAngle = Math.atan2(pn.y - p0.y, pn.x - p0.x);

  const cornersSet = cornerIndices instanceof Set ? new Set(cornerIndices) : new Set(cornerIndices || []);
  let origEndpointCorners: { start: boolean; end: boolean } | null = origCorners || null;

  if (isClosedLoop) {
    const startSharp = cornersSet.has(0);
    const endSharp = cornersSet.has(pts.length - 1);
    if (startSharp !== endSharp) {
      if (!origEndpointCorners) {
        origEndpointCorners = { start: startSharp, end: endSharp };
      }
      cornersSet.delete(0);
      cornersSet.delete(pts.length - 1);
    }
  } else if (origEndpointCorners) {
    if (origEndpointCorners.start) cornersSet.add(0);
    else cornersSet.delete(0);
    if (origEndpointCorners.end) cornersSet.add(pts.length - 1);
    else cornersSet.delete(pts.length - 1);
    origEndpointCorners = null;
  }

  if (isStraight) {
    // For straight 2-point line: tangent is chord angle
    tangentAngle = Math.atan2(pn.y - p0.y, pn.x - p0.x);
    const numSegments = Math.max(1, Math.round(lineLen / 50));
    finalPts = [];
    for (let i = 0; i <= numSegments; i++) {
      const t = i / numSegments;
      finalPts.push({ x: p0.x + t * (pn.x - p0.x), y: p0.y + t * (pn.y - p0.y) });
    }

    const shaftCut = Math.min(Math.max(2, width * 0.4), headLen * 0.2);
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
      // Illustrator-style incremental forward anchor placement (~50px per anchor)
      const step = 50;
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
      if (distToTip < 25 && sampled.length > 1) {
        sampled[sampled.length - 1] = { x: pn.x, y: pn.y };
      } else {
        sampled.push({ x: pn.x, y: pn.y });
      }
    }

    if (isClosedLoop) {
      sampled[sampled.length - 1] = { x: p0.x, y: p0.y };
    }
    finalPts = sampled.map(p => ({ x: p.x, y: p.y }));

    let tangentAngle = Math.atan2(pn.y - p0.y, pn.x - p0.x);
    let pCur = p0;
    if (sampled.length >= 2) {
      const m = sampled.length - 1;
      pCur = sampled[m - 1];
      const pPrev = sampled[Math.max(0, m - 2)];
      const isCorner = cornersSet.has(m) || cornersSet.has(m - 1);
      tangentAngle = Math.atan2(pn.y - pCur.y, pn.x - pCur.x);
      if (!isCorner && m >= 2) {
        // True instantaneous tangent vector at endpoint pn of the spline curve
        const vx = 1.5 * (pn.x - pCur.x) - 0.5 * (pCur.x - pPrev.x);
        const vy = 1.5 * (pn.y - pCur.y) - 0.5 * (pCur.y - pPrev.y);
        if (Math.hypot(vx, vy) > 1e-4) {
          const curveAngle = Math.atan2(vy, vx);
          const angleDiff = Math.atan2(Math.sin(curveAngle - tangentAngle), Math.cos(curveAngle - tangentAngle));
          if (Math.abs(angleDiff) < Math.PI / 3) {
            tangentAngle = curveAngle;
          }
        }
      }
    }

    const distToCur = Math.hypot(pn.x - pCur.x, pn.y - pCur.y);
    const shaftCut = Math.min(Math.max(2, width * 0.4), headLen * 0.2, distToCur * 0.35);
    const shaftEndX = pn.x - shaftCut * Math.cos(tangentAngle);
    const shaftEndY = pn.y - shaftCut * Math.sin(tangentAngle);

    const shaftSampled = [...sampled];
    if (!isClosedLoop) {
      shaftSampled[shaftSampled.length - 1] = { x: shaftEndX, y: shaftEndY };
    } else {
      shaftSampled[shaftSampled.length - 1] = { x: p0.x, y: p0.y };
    }

    if (!isClosedLoop && shaftSampled.length < 3) {
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
        const isCurCorner = cornersSet.has(i);
        const isNextCorner = cornersSet.has(i + 1);

        if (isCurCorner || isNextCorner) {
          pathD += ` L ${shaftSampled[i + 1].x.toFixed(1)} ${shaftSampled[i + 1].y.toFixed(1)}`;
        } else {
          const pPrev = (isClosedLoop && i === 0) ? shaftSampled[m - 1] : shaftSampled[Math.max(0, i - 1)];
          const pCur = shaftSampled[i];
          const pNext = shaftSampled[i + 1];
          const pAfter = (isClosedLoop && i + 1 === m) ? shaftSampled[1] : shaftSampled[Math.min(m, i + 2)];

          const cp1x = pCur.x + (pNext.x - pPrev.x) / 6;
          const cp1y = pCur.y + (pNext.y - pPrev.y) / 6;
          const cp2x = pNext.x - (pAfter.x - pCur.x) / 6;
          const cp2y = pNext.y - (pAfter.y - pCur.y) / 6;

          pathD += ` C ${cp1x.toFixed(1)} ${cp1y.toFixed(1)}, ${cp2x.toFixed(1)} ${cp2y.toFixed(1)}, ${pNext.x.toFixed(1)} ${pNext.y.toFixed(1)}`;
        }
      }
      if (isClosedLoop) {
        pathD += ' Z';
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

  let head: any = null;
  if (!isClosedLoop) {
    // 2. Arrowhead triangle oriented along tangentAngle
    const w1x = pn.x - headLen * Math.cos(tangentAngle - headAngle);
    const w1y = pn.y - headLen * Math.sin(tangentAngle - headAngle);
    const w2x = pn.x - headLen * Math.cos(tangentAngle + headAngle);
    const w2y = pn.y - headLen * Math.sin(tangentAngle + headAngle);

    head = new fabric.Polygon(
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
    head.set({
      objectCaching: false,
      strokeUniform: true
    });
  }

  shaft.set({
    objectCaching: false,
    strokeUniform: true
  });

  const arrow = new fabric.Group(head ? [shaft, head] : [shaft], {
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
  (arrow as any).isClosedLoop = isClosedLoop;
  (arrow as any).arrowP0 = { x: p0.x, y: p0.y };
  (arrow as any).arrowPn = isClosedLoop ? { x: p0.x, y: p0.y } : { x: pn.x, y: pn.y };
  (arrow as any).arrowId = Math.random().toString(36).substring(2, 9);
  (arrow as any).arrowCornerIndices = Array.from(cornersSet);
  (arrow as any).initialMatrix = arrow.calcTransformMatrix();
  (arrow as any)._origEndpointCorners = origEndpointCorners;
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

  (canvas as any).centeredKey = 'altKey';
  (canvas as any).uniScaleKey = 'shiftKey';
  (canvas as any).altActionKey = 'none';

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
    if (isTakingSnapshot || !canvas) return;
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
    if (isTakingSnapshot || !canvas) return;
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
  canvas.on('selection:cleared', () => {
    canvas?.getObjects().forEach((o: any) => {
      if (o.isStickyNote || o.stickyColorConfig) {
        if (o.flipX || o.flipY || (o.scaleX && o.scaleX < 0) || (o.scaleY && o.scaleY < 0)) {
          o.flipX = false;
          o.flipY = false;
          o.scaleX = Math.abs(o.scaleX || 1);
          o.scaleY = Math.abs(o.scaleY || 1);
          o.setCoords();
        }
      }
    });
    updateSelectionState();
  });

  // Ensure all objects added to canvas unconditionally disable bitmap caching for true vector rendering
  canvas.on('object:added', (e: any) => {
    const target = e.target;
    if (target) {
      target.objectCaching = false;
      if (typeof target.getObjects === 'function') {
        target.getObjects().forEach((o: any) => {
          o.objectCaching = false;
        });
      }

      // Guarantee unique ID and author for every object added to canvas
      if (!target.id && !target.arrowId) {
        target.id = 'obj_' + Date.now() + '_' + Math.random().toString(36).substring(2, 9);
      }
      if (!target.authorUid && authStore.uid) {
        target.authorUid = authStore.uid;
      }
      if (!target.authorName && authStore.displayName) {
        target.authorName = authStore.displayName;
      }

      // Tag author and push to user undo stack
      if (!isInternalChange) {
        if (isIsolationMode.value && target) {
          if (!isolatedItems.includes(target) && target !== isolatedGroup && target !== liveArrowPreview && target !== drawingObject && !target._isPreview) {
            isolatedItems.push(target);
            hasIsolationChanged.value = true;
          }
        }
        // Don't push temporary preview objects to undo stack
        if (target !== liveArrowPreview && !target._isPreview && target !== drawingObject) {
          localUserUndoStack.value.push({
            type: 'add',
            items: [{
              targetId: target.id,
              authorUid: authStore.uid,
              objectJson: target.toObject(CUSTOM_PROPS)
            }]
          });
          if (localUserUndoStack.value.length > 50) localUserUndoStack.value.shift();
          localUserRedoStack.value = [];
        }
      }
    }
  });

  // Track object transformation before modification for precise undo/redo
  let hasObjectTransformed = false;
  let objectTransformBefore: { targetId: string; props: any } | null = null;
  canvas.on('before:transform', (e: any) => {
    const target = e.transform?.target || canvas?.getActiveObject();
    if (target && !isInternalChange) {
      const id = target.id || target.arrowId;
      if (id) {
        objectTransformBefore = {
          targetId: id,
          props: {
            left: target.left,
            top: target.top,
            scaleX: target.scaleX,
            scaleY: target.scaleY,
            angle: target.angle,
            width: target.width,
            height: target.height,
            minHeight: (target as any).minHeight,
            fontSize: target.fontSize
          }
        };
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
      if (!e.path.id) {
        e.path.id = 'path_' + Date.now() + '_' + Math.random().toString(36).substring(2, 9);
      }
      e.path.authorUid = authStore.uid;
      e.path.set({ perPixelTargetFind: true });
      if (isIsolationMode.value) {
        if (!isolatedItems.includes(e.path)) {
          isolatedItems.push(e.path);
          hasIsolationChanged.value = true;
        }
      }
    }
    if (!isInternalChange) {
      saveHistoryState();
      syncToFirebase();
      updateSelectionState();
      triggerDebouncedAutoSave();
    }
  });

  canvas.on('object:modified', (e: any) => {
    hasObjectTransformed = false;
    if (isIsolationMode.value) {
      hasIsolationChanged.value = true;
    }
    const obj = e?.target;
    if (obj && (obj.isStickyNote || obj.stickyColorConfig)) {
      const sx = Math.abs(obj.scaleX || 1);
      const sy = Math.abs(obj.scaleY || 1);
      if (Math.abs(sx - 1) > 1e-4 || Math.abs(sy - 1) > 1e-4) {
        // Enforce uniform proportional scale factor in 2D
        const s = Math.max(sx, sy);
        const center = obj.getCenterPoint();
        const curW = obj.width || 180;
        const curMinH = (obj as any).minHeight !== undefined ? (obj as any).minHeight : (obj.height || 180);

        const targetW = Math.max(80, Math.min(360, Math.round(curW * s)));
        const targetH = Math.max(80, Math.min(360, Math.round(curMinH * s)));
        const curFontSize = obj.fontSize || 18;
        const newFontSize = Math.max(10, Math.min(120, Math.round(curFontSize * s)));

        (obj as any).minHeight = targetH;
        obj.set({
          width: targetW,
          height: targetH,
          fontSize: newFontSize,
          scaleX: 1,
          scaleY: 1
        });
        obj.initDimensions();
        if (obj.setPositionByOrigin) {
          obj.setPositionByOrigin(center, 'center', 'center');
        }
        obj.setCoords();
      }
    } else if (obj && (obj.type === 'activeselection' || obj.type === 'activeSelection' || obj.type === 'group')) {
      obj.setCoords();
      const targets = obj.getObjects ? obj.getObjects() : obj._objects || [];
      targets.forEach((c: any) => {
        if (c.isStickyNote || c.stickyColorConfig) {
          c.flipX = false;
          c.flipY = false;
          c.scaleX = Math.abs(c.scaleX || 1);
          c.scaleY = Math.abs(c.scaleY || 1);
          c.setCoords();
        }
      });
      if (typeof obj.forEachObject === 'function') {
        obj.forEachObject((c: any) => c.setCoords());
      }
    }

    // Reconstruct arrow with fixed pristine arrowhead size, preserved points, and vector crispness
    const syncArrowTransform = (arrowObj: any) => {
      if (isArrowNodeEditing.value) return;
      if (!arrowObj || !(arrowObj as any).isArrow || !Array.isArray((arrowObj as any).arrowPoints)) return;
      try {
        if (!canvas) return;
        const M0 = (arrowObj as any).initialMatrix || arrowObj.calcTransformMatrix();
        const M1 = arrowObj.calcTransformMatrix();
        let matrixChanged = false;
        for (let i = 0; i < 6; i++) {
          if (Math.abs(M1[i] - M0[i]) > 1e-4) {
            matrixChanged = true;
            break;
          }
        }
        if (!matrixChanged) return;

        const invM0 = fabric.util.invertTransform(M0);
        const M_delta = fabric.util.multiplyTransformMatrices(M1, invM0);
        const newPts = (arrowObj as any).arrowPoints.map((pt: any) => fabric.util.transformPoint(pt, M_delta));

        const isScaledOrRotated = (arrowObj.scaleX && Math.abs(arrowObj.scaleX - 1) > 1e-3) ||
                                 (arrowObj.scaleY && Math.abs(arrowObj.scaleY - 1) > 1e-3) ||
                                 (arrowObj.angle && Math.abs(arrowObj.angle % 360) > 1e-3);

        if (!isScaledOrRotated || arrowObj.group) {
          // Just translated or inside multi-selection/group: update arrowPoints and initialMatrix directly without recreating
          (arrowObj as any).arrowPoints = newPts;
          (arrowObj as any).initialMatrix = M1;
        } else {
          // Scaled or rotated: reconstruct to keep fixed pristine arrowhead
          const cornerIndices = (arrowObj as any).arrowCornerIndices;
          const origCorners = (arrowObj as any)._origEndpointCorners;
          const newArrow = createArrowFromPoints(newPts, (arrowObj as any).arrowColor, (arrowObj as any).arrowStrokeWidth, true, cornerIndices, origCorners);
          if (newArrow) {
            (newArrow as any).isLocked = (arrowObj as any).isLocked;
            (newArrow as any).arrowId = (arrowObj as any).arrowId || Math.random().toString(36).substring(2, 9);
            (newArrow as any).authorUid = (arrowObj as any).authorUid;
            (newArrow as any).authorName = (arrowObj as any).authorName;
            if ((arrowObj as any).isLocked) {
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
            const idx = allObjs.indexOf(arrowObj);
            if (idx !== -1) {
              canvas.remove(arrowObj);
              canvas.insertAt(idx, newArrow);
              newArrow.setCoords();
              if (canvas.getActiveObject() === arrowObj) {
                canvas.setActiveObject(newArrow);
              }
              canvas.requestRenderAll();
              updateSelectionState();
            }
          }
        }
      } catch (err) {
        console.warn('Failed to sync arrow transform:', err);
      }
    };

    if (obj) {
      if (obj.type === 'activeselection' || obj.type === 'activeSelection') {
        const targets = obj.getObjects ? obj.getObjects() : obj._objects || [];
        targets.forEach((child: any) => {
          if ((child as any).isArrow) syncArrowTransform(child);
        });
      } else if ((obj as any).isArrow) {
        syncArrowTransform(obj);
      }
    }

    if (isArrowNodeEditing.value && editingArrow.value && obj === editingArrow.value) {
      obj._nodeDragLastLeft = obj.left;
      obj._nodeDragLastTop = obj.top;
    }

    if (!isInternalChange) {
      if (objectTransformBefore && obj) {
        const id = obj.id || obj.arrowId;
        if (id === objectTransformBefore.targetId) {
          const afterProps = {
            left: obj.left,
            top: obj.top,
            scaleX: obj.scaleX,
            scaleY: obj.scaleY,
            angle: obj.angle,
            width: obj.width,
            height: obj.height,
            minHeight: (obj as any).minHeight,
            fontSize: obj.fontSize
          };
          if (afterProps.left !== objectTransformBefore.props.left ||
              afterProps.top !== objectTransformBefore.props.top ||
              afterProps.scaleX !== objectTransformBefore.props.scaleX ||
              afterProps.scaleY !== objectTransformBefore.props.scaleY ||
              afterProps.angle !== objectTransformBefore.props.angle ||
              afterProps.width !== objectTransformBefore.props.width ||
              afterProps.minHeight !== objectTransformBefore.props.minHeight) {
            localUserUndoStack.value.push({
              type: 'modify',
              items: [{
                targetId: id,
                authorUid: authStore.uid,
                beforeProps: objectTransformBefore.props,
                afterProps
              }]
            });
            if (localUserUndoStack.value.length > 50) localUserUndoStack.value.shift();
            localUserRedoStack.value = [];
          }
        }
        objectTransformBefore = null;
      }
      saveHistoryState();
      syncToFirebase();
      triggerDebouncedAutoSave();
    }
  });

  canvas.on('object:removed', (e: any) => {
    if (!canvas || isInternalChange) return;
    if (isIsolationMode.value && e?.target) {
      isolatedItems = isolatedItems.filter(item => item !== e.target);
    }
    triggerDebouncedAutoSave();
  });

  canvas.on('text:changed', (e: any) => {
    if (!canvas || isInternalChange) return;
    const target = e.target;
    if (target && (target.isStickyNote || target.stickyColorConfig)) {
      target.initDimensions?.();
      target.setCoords?.();
    }
    const targetId = target?.id || target?.arrowId;
    if (targetId && isCollabActive.value) {
      currentLiveText.value = {
        targetId,
        text: target.text || ''
      };
      broadcastMyCursor({});
    }
  });

  canvas.on('text:editing:exited', (e: any) => {
    if (!canvas) return;
    currentLiveText.value = null;
    broadcastMyCursor({});
    const textObj = e.target as any;
    if (!textObj) return;

    // Remove any empty text or empty sticky note if no content was entered
    if (!textObj.text?.trim() || textObj.text === 'Type here...' || textObj.text === 'Type note here...') {
      canvas.remove(textObj);
      canvas.requestRenderAll();
      saveHistoryState();
      syncToFirebase();
      updateSelectionState();
      triggerDebouncedAutoSave();
      return;
    }
    if (!isInternalChange) {
      saveHistoryState();
      syncToFirebase();
      updateSelectionState();
      triggerDebouncedAutoSave();
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
      updateFloatingToolbars();
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
        updateFloatingToolbars();
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
        updateFloatingToolbars();
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

  // Refine canvas.collectObjects to ensure groups are only collected if at least one actual child is touched or enclosed
  const origCollectObjects = (canvas as any).collectObjects.bind(canvas);
  (canvas as any).collectObjects = function(bbox: any, options?: any) {
    const collected = origCollectObjects(bbox, options);
    const boxLeft = bbox.left;
    const boxTop = bbox.top;
    const boxRight = bbox.left + bbox.width;
    const boxBottom = bbox.top + bbox.height;

    return collected.filter((obj: any) => {
      if ((obj.type === 'group' || obj instanceof fabric.Group) && !obj.isStickyNote && !(obj as any).isArrow) {
        const children = obj.getObjects ? obj.getObjects() : obj._objects || [];
        const gMatrix = obj.calcTransformMatrix();
        const hasChildInRect = children.some((child: any) => {
          const { tl: cTl, tr: cTr, br: cBr, bl: cBl } = child.calcACoords();
          const sceneCorners = [cTl, cTr, cBr, cBl].map(pt => fabric.util.transformPoint(pt, gMatrix));
          const childMinX = Math.min(...sceneCorners.map(p => p.x));
          const childMaxX = Math.max(...sceneCorners.map(p => p.x));
          const childMinY = Math.min(...sceneCorners.map(p => p.y));
          const childMaxY = Math.max(...sceneCorners.map(p => p.y));
          const centerX = (childMinX + childMaxX) / 2;
          const centerY = (childMinY + childMaxY) / 2;

          const isCenterInside = centerX >= boxLeft && centerX <= boxRight && centerY >= boxTop && centerY <= boxBottom;
          const isEnclosed = childMinX >= boxLeft && childMaxX <= boxRight && childMinY >= boxTop && childMaxY <= boxBottom;
          const isIntersecting = boxRight >= childMinX && boxLeft <= childMaxX && boxBottom >= childMinY && boxTop <= childMaxY;

          return isCenterInside || isEnclosed || isIntersecting;
        });
        return hasChildInRect;
      }
      return true;
    });
  };

  // Ctrl+Click & Ctrl+Marquee Group Sub-object Isolation State
  let isCtrlInteracting = false;
  let ctrlMouseDownPoint: { x: number; y: number } | null = null;
  let ctrlHitGroup: fabric.Group | null = null;
  let ctrlHitChild: any = null;
  let isCtrlMarqueeDragging = false;

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

    const scenePoint = canvas.getScenePoint(e);

    // Ctrl+Click / Ctrl+Marquee on group sub-object: directly enter group isolation mode (supports nested groups)
    if ((e.ctrlKey || e.metaKey) && currentTool.value === 'select') {
      const hitTarget = opt.target || (canvas.findTarget(e) as any)?.target || null;
      let group: fabric.Group | null = null;
      let hitChild: any = null;

      const isEligibleGroup = (obj: any) => {
        if (!obj || (obj.type !== 'group' && !(obj instanceof fabric.Group)) || obj.isStickyNote || (obj as any).isArrow) return false;
        if (isIsolationMode.value) {
          return isolatedItems.includes(obj);
        }
        return true;
      };

      if (isEligibleGroup(hitTarget)) {
        group = hitTarget as fabric.Group;
        const children = group.getObjects ? group.getObjects() : (group as any)._objects || [];
        const invGroup = fabric.util.invertTransform(group.calcTransformMatrix());
        const localPoint = fabric.util.transformPoint(scenePoint, invGroup);

        for (let i = children.length - 1; i >= 0; i--) {
          const child = children[i];
          const cMatrix = child.calcTransformMatrix();
          const invChild = fabric.util.invertTransform(cMatrix);
          const ptInChild = fabric.util.transformPoint(localPoint, invChild);
          const w2 = ((child.width || 0) * (child.scaleX || 1)) / 2 + 6;
          const h2 = ((child.height || 0) * (child.scaleY || 1)) / 2 + 6;
          if (Math.abs(ptInChild.x) <= w2 && Math.abs(ptInChild.y) <= h2) {
            hitChild = child;
            break;
          }
        }

        // If clicked on empty space of group bounding box without hitting any child, don't treat as group click
        if (!hitChild) {
          group = null;
        }
      }

      isCtrlInteracting = true;
      ctrlMouseDownPoint = { x: scenePoint.x, y: scenePoint.y };
      ctrlHitGroup = group;
      ctrlHitChild = hitChild;
      isCtrlMarqueeDragging = false;

      // Prevent Fabric from dragging the whole group during potential marquee drag
      if (group) {
        (canvas as any)._currentTransform = null;
      }
    }

    if (isArrowNodeEditing.value) {
      const hitTarget = opt.target || (canvas.findTarget(e) as any)?.target || null;
      if (!hitTarget || (hitTarget.type === 'image' && hitTarget.selectable === false)) {
        // Start node marquee box when clicking empty canvas
        startNodeMarquee(e);
        return;
      } else if (hitTarget !== editingArrow.value && !editingArrow.value?.contains?.(hitTarget)) {
        // Clicked another object, exit node edit mode
        exitArrowNodeEditing();
      }
    }

    isMouseDown = true;
    hasFlattenedShapeInCurrentStroke = false;
    canvas.getObjects().forEach((o: any) => {
      o._persisted = true;
    });

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
        originY: 'top',
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
    broadcastMyCursor(opt);
    const e = opt.e as MouseEvent;

    // Alt modifier mid-drag dynamic center scaling
    const curTransform = (canvas as any)._currentTransform;
    if (curTransform && curTransform.target) {
      if (e.altKey) {
        if (!curTransform._origOriginX) {
          curTransform._origOriginX = curTransform.originX;
          curTransform._origOriginY = curTransform.originY;
        }
        curTransform.originX = 'center';
        curTransform.originY = 'center';
        curTransform.target.centeredScaling = true;
      } else if (curTransform._origOriginX) {
        curTransform.originX = curTransform._origOriginX;
        curTransform.originY = curTransform._origOriginY;
        curTransform._origOriginX = null;
        curTransform._origOriginY = null;
        curTransform.target.centeredScaling = false;
      }
    }

    // Ctrl+Marquee Dragging state tracking (Fabric's native selection marquee renders the visual box cleanly)
    if (isCtrlInteracting && ctrlMouseDownPoint) {
      const curScene = canvas.getScenePoint(e);
      const dist = Math.hypot(curScene.x - ctrlMouseDownPoint.x, curScene.y - ctrlMouseDownPoint.y);
      if (dist > 5) {
        isCtrlMarqueeDragging = true;
      }
    }

    if (isDragging) {
      const vpt = canvas.viewportTransform;
      if (vpt) {
        vpt[4] += e.clientX - lastPosX;
        vpt[5] += e.clientY - lastPosY;
        clampViewportPan();
        canvas.setViewportTransform(vpt);
        const activeObj = canvas.getActiveObject();
        if (activeObj) activeObj.setCoords();
        updateFloatingToolbars();
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
      let scenePoint = canvas.getScenePoint(e);
      if (e.shiftKey && pencilStrokePoints.length >= 1) {
        const p0 = pencilStrokePoints[0];
        const angle = Math.atan2(scenePoint.y - p0.y, scenePoint.x - p0.x);
        const snapped = Math.round(angle / (Math.PI / 4)) * (Math.PI / 4);
        const dist = Math.hypot(scenePoint.x - p0.x, scenePoint.y - p0.y);
        scenePoint = new fabric.Point(p0.x + dist * Math.cos(snapped), p0.y + dist * Math.sin(snapped));
      }
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
    const isShift = e.shiftKey;
    const isAlt = e.altKey;

    const dx = scenePoint.x - drawingStartPoint.x;
    const dy = scenePoint.y - drawingStartPoint.y;

    if (currentTool.value === 'rect' || currentTool.value === 'triangle') {
      let w = Math.abs(dx);
      let h = Math.abs(dy);

      if (isShift) {
        const size = Math.max(w, h);
        w = size;
        h = size;
      }

      let l: number, t: number;
      if (isAlt) {
        l = drawingStartPoint.x - w;
        t = drawingStartPoint.y - h;
        w *= 2;
        h *= 2;
      } else {
        l = dx >= 0 ? drawingStartPoint.x : drawingStartPoint.x - w;
        t = dy >= 0 ? drawingStartPoint.y : drawingStartPoint.y - h;
      }

      drawingObject.set({ left: l, top: t, width: w, height: h });
      if (isCollabActive.value) {
        currentLiveShape.value = {
          shapeType: currentTool.value as 'rect' | 'triangle',
          x: Math.round(l),
          y: Math.round(t),
          w: Math.round(w),
          h: Math.round(h),
          color: activeColor.value,
          strokeWidth: strokeWidth.value
        };
      }
    } else if (currentTool.value === 'circle') {
      let rx = Math.abs(dx) / 2;
      let ry = Math.abs(dy) / 2;

      if (isShift) {
        const r = Math.max(rx, ry);
        rx = r;
        ry = r;
      }

      let cx: number, cy: number;
      if (isAlt) {
        cx = drawingStartPoint.x;
        cy = drawingStartPoint.y;
        rx = isShift ? Math.max(Math.abs(dx), Math.abs(dy)) : Math.abs(dx);
        ry = isShift ? rx : Math.abs(dy);
      } else {
        cx = dx >= 0 ? drawingStartPoint.x + rx : drawingStartPoint.x - rx;
        cy = dy >= 0 ? drawingStartPoint.y + ry : drawingStartPoint.y - ry;
      }

      drawingObject.set({
        left: cx,
        top: cy,
        originX: 'center',
        originY: 'center',
        rx,
        ry
      });
      if (isCollabActive.value) {
        currentLiveShape.value = {
          shapeType: 'circle',
          x: Math.round(cx),
          y: Math.round(cy),
          w: Math.round(rx),
          h: Math.round(ry),
          color: activeColor.value,
          strokeWidth: strokeWidth.value
        };
      }
    } else if (currentTool.value === 'line') {
      let startX = drawingStartPoint.x;
      let startY = drawingStartPoint.y;
      let endX = scenePoint.x;
      let endY = scenePoint.y;

      if (isShift) {
        const angle = Math.atan2(endY - startY, endX - startX);
        const snapped = Math.round(angle / (Math.PI / 4)) * (Math.PI / 4);
        const dist = Math.hypot(endX - startX, endY - startY);
        endX = startX + dist * Math.cos(snapped);
        endY = startY + dist * Math.sin(snapped);
      }

      if (isAlt) {
        const diffX = endX - startX;
        const diffY = endY - startY;
        startX = drawingStartPoint.x - diffX;
        startY = drawingStartPoint.y - diffY;
      }

      drawingObject.set({ x1: startX, y1: startY, x2: endX, y2: endY });
      if (isCollabActive.value) {
        currentLiveShape.value = {
          shapeType: 'line',
          x: Math.round(startX),
          y: Math.round(startY),
          w: Math.round(endX),
          h: Math.round(endY),
          color: activeColor.value,
          strokeWidth: strokeWidth.value
        };
      }
    }
    canvas.requestRenderAll();
  });

  // Unified Mouse Up
  canvas.on('mouse:up', (opt) => {
    if (!canvas) return;
    const e = opt.e as MouseEvent;
    isMouseDown = false;

    if (isCtrlInteracting) {
      const startPt = ctrlMouseDownPoint;
      const wasMarquee = isCtrlMarqueeDragging && startPt;
      const targetGroup = ctrlHitGroup;
      const singleChild = ctrlHitChild;

      isCtrlInteracting = false;
      ctrlMouseDownPoint = null;
      ctrlHitGroup = null;
      ctrlHitChild = null;
      isCtrlMarqueeDragging = false;

      if (wasMarquee && startPt) {
        const endPt = canvas.getScenePoint(opt.e);
        const boxLeft = Math.min(startPt.x, endPt.x);
        const boxTop = Math.min(startPt.y, endPt.y);
        const boxRight = Math.max(startPt.x, endPt.x);
        const boxBottom = Math.max(startPt.y, endPt.y);

        let groupToIsolate = targetGroup;
        if (!groupToIsolate) {
          const availableObjects = isIsolationMode.value ? isolatedItems : canvas.getObjects();
          const groups = availableObjects.filter((o: any) => 
            (o.type === 'group' || o instanceof fabric.Group) && !o.isStickyNote && !(o as any).isArrow
          ) as fabric.Group[];
          for (let i = groups.length - 1; i >= 0; i--) {
            const g = groups[i];
            const children = g.getObjects ? g.getObjects() : (g as any)._objects || [];
            const gMatrix = g.calcTransformMatrix();
            const hasChild = children.some((child: any) => {
              const childMatrix = fabric.util.multiplyTransformMatrices(gMatrix, child.calcTransformMatrix());
              const w2 = (child.width || 0) / 2;
              const h2 = (child.height || 0) / 2;
              const sceneCorners = [
                fabric.util.transformPoint({ x: -w2, y: -h2 } as any, childMatrix),
                fabric.util.transformPoint({ x: w2, y: -h2 } as any, childMatrix),
                fabric.util.transformPoint({ x: w2, y: h2 } as any, childMatrix),
                fabric.util.transformPoint({ x: -w2, y: h2 } as any, childMatrix)
              ];
              const childMinX = Math.min(...sceneCorners.map((p: any) => p.x));
              const childMaxX = Math.max(...sceneCorners.map((p: any) => p.x));
              const childMinY = Math.min(...sceneCorners.map((p: any) => p.y));
              const childMaxY = Math.max(...sceneCorners.map((p: any) => p.y));
              // Intersects if marquee box touches even a single corner or edge of the child's bounding box
              return (childMaxX >= boxLeft && childMinX <= boxRight && childMaxY >= boxTop && childMinY <= boxBottom);
            });
            if (hasChild) {
              groupToIsolate = g;
              break;
            }
          }
        }

        if (groupToIsolate) {
          const children = groupToIsolate.getObjects ? groupToIsolate.getObjects() : (groupToIsolate as any)._objects || [];
          const gMatrix = groupToIsolate.calcTransformMatrix();
          const matchedChildren: any[] = [];

          children.forEach((child: any) => {
            const childMatrix = fabric.util.multiplyTransformMatrices(gMatrix, child.calcTransformMatrix());
            const w2 = (child.width || 0) / 2;
            const h2 = (child.height || 0) / 2;
            const sceneCorners = [
              fabric.util.transformPoint({ x: -w2, y: -h2 } as any, childMatrix),
              fabric.util.transformPoint({ x: w2, y: -h2 } as any, childMatrix),
              fabric.util.transformPoint({ x: w2, y: h2 } as any, childMatrix),
              fabric.util.transformPoint({ x: -w2, y: h2 } as any, childMatrix)
            ];
            const childMinX = Math.min(...sceneCorners.map((p: any) => p.x));
            const childMaxX = Math.max(...sceneCorners.map((p: any) => p.x));
            const childMinY = Math.min(...sceneCorners.map((p: any) => p.y));
            const childMaxY = Math.max(...sceneCorners.map((p: any) => p.y));

            // Select if marquee box touches any part (even corner) of the child's bounding box
            const intersects = (childMaxX >= boxLeft && childMinX <= boxRight && childMaxY >= boxTop && childMinY <= boxBottom);
            if (intersects) {
              matchedChildren.push(child);
            }
          });

          if (matchedChildren.length > 0) {
            enterGroupIsolation(groupToIsolate, matchedChildren);
            return;
          }
        }
      } else {
        if (targetGroup && singleChild) {
          enterGroupIsolation(targetGroup, singleChild);
          return;
        }
      }
    }

    if (hasObjectTransformed) {
      hasObjectTransformed = false;
      saveHistoryState();
      syncToFirebase();
      triggerDebouncedAutoSave();
    }

    if (pencilHoldTimer) {
      clearTimeout(pencilHoldTimer);
      pencilHoldTimer = null;
    }
    lastPencilMovePos = null;

    if (isDragging) {
      isDragging = false;
    }
    canvas.selection = currentTool.value === 'select';

    // Broadcast cursor without liveStroke and clear liveDrag for other participants
    if (currentLiveDrag.value) {
      currentLiveDrag.value = null;
    }
    broadcastMyCursor(opt);

    // Flush any deferred canvas resizing that arrived during drawing or dragging
    if (pendingResize) {
      performCanvasResize(pendingResize.w, pendingResize.h);
      pendingResize = null;
    }

    // Flush any deferred remote Firebase sync (defer to next tick so Fabric completes mouseup cleanly)
    if (pendingRemoteState) {
      const stateToLoad = pendingRemoteState;
      pendingRemoteState = null;
      setTimeout(() => {
        loadFromFirebase(stateToLoad);
      }, 0);
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
        drawingObject.authorUid = authStore.uid;
        if (!drawingObject.id) drawingObject.id = 'obj_' + Date.now() + '_' + Math.random().toString(36).substring(2, 9);
        localUserUndoStack.value.push({
          type: 'add',
          items: [{
            targetId: drawingObject.id,
            authorUid: authStore.uid,
            objectJson: drawingObject.toObject(CUSTOM_PROPS)
          }]
        });
        if (localUserUndoStack.value.length > 50) localUserUndoStack.value.shift();
        localUserRedoStack.value = [];
        drawingObject.setCoords();
        canvas.setActiveObject(drawingObject);
        canvas.requestRenderAll();
        saveHistoryState();
        syncToFirebase();
        updateSelectionState();
        triggerDebouncedAutoSave();
      }

      currentLiveShape.value = null;
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
    if (target.type === 'group' && !target.isStickyNote && !(target as any).isArrow) {
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
    const majorDim = Math.max(baseW, baseH);
    const curScale = Math.min(Math.abs(target.scaleX || 1), Math.abs(target.scaleY || 1));

    if (majorDim > minDim) {
      // Normal object: allow scaling down until major dimension reaches minDim
      target.minScaleLimit = Math.max(0.01, minDim / majorDim);
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

    // 1. If group or activeSelection contains locked items:
    // Only freeze if ALL targets are locked. If mixed, allow moving unlocked items while keeping locked items stationary.
    if (obj.type === 'activeselection' || (obj.type === 'group' && !obj.isStickyNote)) {
      const targets = obj.getObjects ? obj.getObjects() : obj._objects || [];
      const allLocked = targets.length > 0 && targets.every((o: any) => o.isLocked);
      if (allLocked) {
        if (obj._dragStartLeft !== undefined) obj.left = obj._dragStartLeft;
        if (obj._dragStartTop !== undefined) obj.top = obj._dragStartTop;
        obj.setCoords();
        return;
      }
      const dx = obj.left - (obj._dragStartLeft !== undefined ? obj._dragStartLeft : obj.left);
      const dy = obj.top - (obj._dragStartTop !== undefined ? obj._dragStartTop : obj.top);
      targets.forEach((c: any) => {
        if (c.isLocked && c._dragStartLocalLeft !== undefined && c._dragStartLocalTop !== undefined) {
          c.left = c._dragStartLocalLeft - dx;
          c.top = c._dragStartLocalTop - dy;
          c.setCoords();
        }
      });
    }

    // 2. Strict boundary clamping: flush coordinates first to obtain true scene bounding box
    obj.setCoords();
    let bound = obj.getBoundingRect ? obj.getBoundingRect(true) : null;
    if (bound) {
      if (bound.left < 0) {
        obj.left += (0 - bound.left);
      } else if (bound.left + bound.width > WORKSPACE_WIDTH) {
        obj.left -= (bound.left + bound.width - WORKSPACE_WIDTH);
      }

      obj.setCoords();
      bound = obj.getBoundingRect ? obj.getBoundingRect(true) : null;
      if (bound) {
        if (bound.top < 0) {
          obj.top += (0 - bound.top);
        } else if (bound.top + bound.height > WORKSPACE_HEIGHT) {
          obj.top -= (bound.top + bound.height - WORKSPACE_HEIGHT);
        }
      }
      obj.setCoords();
    }
    hasObjectTransformed = true;
    updateLiveDrag(e);
    updateFloatingToolbars();
    updateArrowToolbar();
    updateLockToolbar();
    if (lockedGlowObjects.length > 0) {
      clearLockedHighlights();
      highlightLockedObjects();
    }
  });
  canvas.on('before:transform', (e: any) => {
    const transform = e?.transform;
    const obj = transform?.target;
    if (obj) {
      // Alt modifier: scale from center
      obj.centeredScaling = !!(e.e?.altKey);
      obj._dragStartLeft = obj.left;
      obj._dragStartTop = obj.top;
      
      const targets = obj.type === 'activeselection' || obj.type === 'activeSelection' || obj.type === 'group' 
        ? (obj.getObjects ? obj.getObjects() : obj._objects || []) 
        : [obj];
        
      targets.forEach((c: any) => {
        c._dragStartLocalLeft = c.left;
        c._dragStartLocalTop = c.top;
        c._origScaleX = c.scaleX || 1;
        c._origScaleY = c.scaleY || 1;
        c._origAngle = c.angle || 0;
        if (c.isStickyNote || c.stickyColorConfig) {
           c._origBaseScale = Math.max(Math.abs(c.scaleX || 1), Math.abs(c.scaleY || 1));
        }
      });
    }
  });

  canvas.on('object:scaling', (e: any) => {
    hasObjectTransformed = true;
    const obj = e?.target;
    if (obj) {
      // 1. Single sticky note: enforce strict 1:1 aspect ratio and min (80px) / max (600px) clamp in real-time
      if (obj.isStickyNote || obj.stickyColorConfig) {
        const baseW = obj.width || 120;
        const uniformScale = Math.max(Math.abs(obj.scaleX || 1), Math.abs(obj.scaleY || 1));
        const minScale = 80 / baseW;
        const maxScale = 360 / baseW;
        const clampedScale = Math.max(minScale, Math.min(maxScale, uniformScale));
        const transform = (canvas as any)._currentTransform;
        const originX = transform?.originX || 'center';
        const originY = transform?.originY || 'center';
        const anchorPoint = obj.getPointByOrigin(originX, originY);
        obj.set({
          scaleX: clampedScale,
          scaleY: clampedScale,
          flipX: false,
          flipY: false
        });
        obj.setPositionByOrigin(anchorPoint, originX, originY);
      } else if (obj.type === 'activeselection' || obj.type === 'activeSelection' || obj.type === 'group') {
        const targets = obj.getObjects ? obj.getObjects() : obj._objects || [];
        const rawScaleX = obj.scaleX || 1;
        const rawScaleY = obj.scaleY || 1;
        const selScaleX = Math.max(0.05, Math.abs(rawScaleX));
        const selScaleY = Math.max(0.05, Math.abs(rawScaleY));

        const transform = (canvas as any)._currentTransform || (e as any).transform;
        const corner = transform?.corner;

        let activeScaleFactor = 1;
        if (corner === 'ml' || corner === 'mr') {
          // Dragging horizontal handle: drive uniform scale by width change
          activeScaleFactor = selScaleX;
        } else if (corner === 'mt' || corner === 'mb') {
          // Dragging vertical handle: drive uniform scale by height change
          activeScaleFactor = selScaleY;
        } else {
          // Corner scaling: drive by min scale to shrink with dragging handle
          activeScaleFactor = Math.min(selScaleX, selScaleY);
        }

        const signX = rawScaleX < 0 ? -1 : 1;
        const signY = rawScaleY < 0 ? -1 : 1;

        targets.forEach((c: any) => {
          if (c.isStickyNote || c.stickyColorConfig) {
            const baseW = c.width || 120;
            const minScale = 80 / baseW;
            const maxScale = 360 / baseW;
            const origBaseScale = Math.abs(c._origBaseScale || 1);
            const childVisualScale = Math.max(minScale, Math.min(maxScale, activeScaleFactor * origBaseScale));

            // Counteract selection negative flip so sticky note stays upright and never mirrored while moving across
            c.scaleX = signX * (childVisualScale / selScaleX);
            c.scaleY = signY * (childVisualScale / selScaleY);
            c.flipX = false;
            c.flipY = false;
          } else if (c.isLocked) {
            // Locked objects in multi-selection should not scale or mirror
            const origSx = Math.abs(c._origScaleX || 1);
            const origSy = Math.abs(c._origScaleY || 1);
            c.scaleX = signX * (origSx / selScaleX);
            c.scaleY = signY * (origSy / selScaleY);
            c.flipX = false;
            c.flipY = false;
          }
        });
      }

      obj.setCoords();
      if ((obj.type === 'activeselection' || obj.type === 'activeSelection') && obj.forEachObject) {
        obj.forEachObject((c: any) => c.setCoords());
      }
      canvas?.requestRenderAll();
    }
    // Scaling frames are not broadcast live to peers; sync on mouseup (user requirement)
    updateFloatingToolbars();
    updateArrowToolbar();
  });
  canvas.on('object:modified', (e: any) => {
    updateFloatingToolbars();
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
      updateFloatingToolbars();
    }
  });
  canvas.on('object:rotating', (e: any) => {
    hasObjectTransformed = true;
    const obj = e?.target;
    if (obj && (obj.type === 'activeselection' || obj.type === 'activeSelection' || obj.type === 'group')) {
      const targets = obj.getObjects ? obj.getObjects() : obj._objects || [];
      targets.forEach((c: any) => {
        if (c.isStickyNote || c.stickyColorConfig || c.isLocked) {
          c.angle = (c._origAngle || 0) - (obj.angle || 0);
        }
      });
      canvas?.requestRenderAll();
    }
    updateLiveDrag(e);
    updateFloatingToolbars();
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
        const isInteracting = isMouseDown || isDragging || isQuickShapeResizing || pencilStrokePoints.length > 0 || isDraggingNode.value || !!(canvas as any)._currentTransform;
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
  } else if (isCollabActive.value && roomStore.currentRoom?.whiteboardState) {
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

  note.controls = {
    tl: defaultControls.tl,
    tr: defaultControls.tr,
    bl: defaultControls.bl,
    br: defaultControls.br
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
  note.padding = 0;
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

  // Pure visual canvas placeholder render that disappears on typing and never serializes
  const origRender = note._render;
  note._render = function(ctx: CanvasRenderingContext2D) {
    origRender.call(this, ctx);
    if (!this.text && !this.isEditing) {
      ctx.save();
      ctx.font = `${Math.round((this.fontSize || 15) * 0.95)}px ${this.fontFamily || 'Inter, sans-serif'}`;
      ctx.fillStyle = this.stickyColorConfig?.text === '#f8fafc' ? 'rgba(255, 255, 255, 0.45)' : 'rgba(0, 0, 0, 0.35)';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Type note here...', 0, 0);
      ctx.restore();
    }
  };

  setupStickyControls(note);
};

// Rehydrate custom attributes, methods, and constraints after deserializing from JSON
const rehydrateCanvasObjects = () => {
  if (!canvas) return;

  const processObject = (o: any) => {
    o.set({ perPixelTargetFind: true });

    if (!o.id) {
      o.id = (o.isArrow || o.arrowId ? (o.arrowId || 'arrow_' + Date.now()) : (o.isStickyNote ? 'note_' : 'obj_') + Date.now() + '_' + Math.random().toString(36).substring(2, 9));
    }

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
      if (o.text === 'Type note here...' || o.text === 'Type here...') {
        o.text = '';
      }
      o.minHeight = o.minHeight || 180;
      o.textAlign = 'center';
      o.splitByGrapheme = true;
      o.lockUniScaling = true;
      o.hasRotatingPoint = false;
      o.objectCaching = false;
      o.perPixelTargetFind = false;
      applyStickyNoteMethods(o);
      o.initDimensions?.();
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

    // Recursively process group children (so nested sticky notes inside groups receive methods and dimensions)
    if (o.type === 'group' || o instanceof fabric.Group) {
      const groupChildren = o.getObjects ? o.getObjects() : (o._objects || []);
      groupChildren.forEach((child: any) => processObject(child));
    }
  };

  canvas.getObjects().forEach(processObject);
};

const syncNodeEditingStateAfterReload = () => {
  if (!isArrowNodeEditing.value || !canvas) return;
  const currentEditingId = (editingArrow.value as any)?.arrowId;
  const allTargets = canvas.getObjects().filter((o: any) => (o as any).isArrow && (o as any).arrowPoints);
  const match = (currentEditingId ? allTargets.find((o: any) => (o as any).arrowId === currentEditingId) : null) || allTargets[0];
  if (match) {
    match.visible = true;
    editingArrow.value = match;
    editingArrowPoints.value = (match as any).arrowPoints.map((p: any) => ({ x: p.x, y: p.y }));
    const existingCorners = Array.isArray((match as any).arrowCornerIndices) ? (match as any).arrowCornerIndices : [];
    editingArrowCorners.value = new Set(existingCorners);
    match.set({
      hasControls: false,
      selectable: true,
      evented: true,
      visible: true
    });
    match.setCoords();
    canvas.requestRenderAll();
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
  // If in isolation mode, do not record intermediate unbundled states in the global history stack!
  if (isIsolationMode.value) return;
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
  if (isInternalChange || !canvas || !isCollabActive.value) return;
  const json = getSerializedCanvasJson();
  lastSyncedJson = json;
  roomStore.syncWhiteboardState(json);
};

const loadFromFirebase = async (json: string) => {
  if (!canvas || !json) return;
  isInternalChange = true;

  // Preserve user's local viewport transform
  const savedVpt = canvas.viewportTransform ? [...canvas.viewportTransform] : null;

  try {
    const existingObjects = canvas.getObjects();

    // If canvas is currently empty, load baseline state directly
    if (existingObjects.length === 0) {
      await canvas.loadFromJSON(json);
      if (savedVpt) {
        canvas.setViewportTransform(savedVpt as [number, number, number, number, number, number]);
      }
      rehydrateCanvasObjects();
      syncNodeEditingStateAfterReload();
      canvas.calcViewportBoundaries();
      canvas.getObjects().forEach(o => o.setCoords());
      canvas.requestRenderAll();
      viewportVersion.value++;
      for (const uid in smoothedCursors.value) {
        smoothedCursors.value[uid].liveStroke = null;
        smoothedCursors.value[uid].strokeCompletedAt = undefined;
        smoothedCursors.value[uid].liveShape = null;
        smoothedCursors.value[uid].shapeCompletedAt = undefined;
      }
      if (historyStack.value.length === 0) {
        historyStack.value = [json];
      } else if (historyStack.value[historyStack.value.length - 1] !== json) {
        historyStack.value.push(json);
        if (historyStack.value.length > 50) historyStack.value.shift();
      }
      isInternalChange = false;
      return;
    }

    // Smart Entity Reconciliation: Diff by ID to eliminate stroke flickering & canvas reload lag
    const parsed = JSON.parse(json);
    const incomingObjects = parsed.objects || [];
    const existingMap = new Map<string, any>();

    existingObjects.forEach((o: any) => {
      const id = o.id || o.arrowId;
      if (id) existingMap.set(id, o);
    });

    const incomingIds = new Set<string>();
    const newObjectsJson: any[] = [];
    const activeObj = canvas.getActiveObject();

    for (const objJson of incomingObjects) {
      const id = objJson.id || objJson.arrowId;
      if (id) incomingIds.add(id);

      const localObj = id ? existingMap.get(id) : null;
      if (!localObj) {
        newObjectsJson.push(objJson);
      } else {
        // Do not clobber an object if local user is actively transforming or editing text right now
        const isLocallyInteracting = localObj === activeObj && (isMouseDown || localObj.isEditing);
        if (!isLocallyInteracting) {
          if (localObj.isStickyNote || (localObj.type === 'textbox' && localObj.stickyColorConfig)) {
            if (objJson.text !== undefined && localObj.text !== objJson.text) {
              localObj.set({ text: objJson.text });
              localObj.initDimensions?.();
            }
            if (objJson.minHeight !== undefined && localObj.minHeight !== objJson.minHeight) {
              localObj.minHeight = objJson.minHeight;
              localObj.initDimensions?.();
            }
            if (objJson.fontSize !== undefined && localObj.fontSize !== objJson.fontSize) {
              localObj.set({ fontSize: objJson.fontSize });
              localObj.initDimensions?.();
            }
          }

          if (localObj.isArrow && objJson.arrowPoints) {
            const oldPts = JSON.stringify(localObj.arrowPoints || []);
            const newPts = JSON.stringify(objJson.arrowPoints || []);
            if (oldPts !== newPts) {
              const color = objJson.arrowColor || (localObj as any).arrowColor || activeColor.value;
              const width = objJson.arrowStrokeWidth || (localObj as any).arrowStrokeWidth || strokeWidth.value;
              const newArrow = createArrowFromPoints(objJson.arrowPoints, color, width, true);
              if (newArrow) {
                (newArrow as any).id = localObj.id;
                (newArrow as any).arrowId = localObj.arrowId;
                (newArrow as any).authorUid = localObj.authorUid;
                (newArrow as any).isLocked = objJson.isLocked ?? localObj.isLocked;
                (newArrow as any).initialMatrix = objJson.initialMatrix;
                const idx = canvas.getObjects().indexOf(localObj);
                if (idx !== -1) {
                  canvas.remove(localObj);
                  canvas.insertAt(idx, newArrow);
                  newArrow.setCoords();
                  continue;
                }
              }
            }
            localObj.arrowPoints = objJson.arrowPoints;
            if (objJson.initialMatrix) localObj.initialMatrix = objJson.initialMatrix;
          }

          localObj.set({
            left: objJson.left,
            top: objJson.top,
            scaleX: objJson.scaleX,
            scaleY: objJson.scaleY,
            angle: objJson.angle,
            width: objJson.width,
            height: objJson.height,
            fill: objJson.fill,
            stroke: objJson.stroke,
            strokeWidth: objJson.strokeWidth,
            fontSize: objJson.fontSize !== undefined ? objJson.fontSize : localObj.fontSize,
            opacity: objJson.opacity ?? 1,
            isLocked: objJson.isLocked
          });
          localObj.setCoords();
        }
      }
    }

    // Remove deleted objects (excluding temporary preview items)
    const toRemove = existingObjects.filter((o: any) => {
      if (o === liveArrowPreview || o === drawingObject || o._isPreview) return false;
      const id = o.id || o.arrowId;
      return id && !incomingIds.has(id);
    });
    toRemove.forEach((o: any) => canvas?.remove(o));

    // Enliven brand-new objects and add them to canvas
    if (newObjectsJson.length > 0) {
      let enlivened: any[] = [];
      try {
        const enlivenPromise = (fabric.util as any).enlivenObjects(newObjectsJson);
        enlivened = Array.isArray(enlivenPromise) ? enlivenPromise : (typeof enlivenPromise?.then === 'function' ? await enlivenPromise : []);
      } catch (err) {
        console.warn('Failed to enliven new objects:', err);
      }

      for (let i = 0; i < enlivened.length; i++) {
        const o = enlivened[i];
        const data = newObjectsJson[i];
        if (data) {
          if (data.id) o.id = data.id;
          if (data.arrowId) o.arrowId = data.arrowId;
          if (data.authorUid) o.authorUid = data.authorUid;
          if (data.authorName) o.authorName = data.authorName;
          if (data.isStickyNote) o.isStickyNote = true;
          if (data.stickyColorConfig) o.stickyColorConfig = data.stickyColorConfig;
          if (data.minHeight) o.minHeight = data.minHeight;
          if (data.isArrow) o.isArrow = true;
          if (data.arrowPoints) o.arrowPoints = data.arrowPoints;
          if (data.arrowColor) o.arrowColor = data.arrowColor;
          if (data.arrowStrokeWidth) o.arrowStrokeWidth = data.arrowStrokeWidth;
          if (data.isStraightArrow) o.isStraightArrow = data.isStraightArrow;
          if (data.isStraightLine) o.isStraightLine = data.isStraightLine;
          if (data.isLocked) o.isLocked = data.isLocked;
        }
        canvas.add(o);
      }
    }

    if (savedVpt) {
      canvas.setViewportTransform(savedVpt as [number, number, number, number, number, number]);
    }

    rehydrateCanvasObjects();
    syncNodeEditingStateAfterReload();

    canvas.calcViewportBoundaries();
    canvas.getObjects().forEach(o => o.setCoords());
    canvas.requestRenderAll();
    viewportVersion.value++;

    // Seamless stroke handover: clear live preview only after the real Fabric object is added
    for (const uid in smoothedCursors.value) {
      smoothedCursors.value[uid].liveStroke = null;
      smoothedCursors.value[uid].strokeCompletedAt = undefined;
      smoothedCursors.value[uid].liveShape = null;
      smoothedCursors.value[uid].shapeCompletedAt = undefined;
    }

    if (historyStack.value.length === 0) {
      historyStack.value = [json];
    } else if (historyStack.value[historyStack.value.length - 1] !== json) {
      historyStack.value.push(json);
      if (historyStack.value.length > 50) historyStack.value.shift();
    }
  } catch (err) {
    console.error('Entity reconciliation fallback:', err);
    await canvas.loadFromJSON(json);
    if (savedVpt) {
      canvas.setViewportTransform(savedVpt as [number, number, number, number, number, number]);
    }
    rehydrateCanvasObjects();
    syncNodeEditingStateAfterReload();
    canvas.calcViewportBoundaries();
    canvas.getObjects().forEach(o => o.setCoords());
    canvas.requestRenderAll();
    viewportVersion.value++;
  } finally {
    isInternalChange = false;
  }
};

watch(() => roomStore.currentRoom?.whiteboardState, (newState, oldState) => {
  if (newState && newState !== oldState && isCollabActive.value) {
    // Ignore echo of local changes
    if (newState === lastSyncedJson) return;

    // Defer loading only if local user is actively drawing a freehand pencil stroke right now
    const isInteracting = isDrawingMode.value && pencilStrokePoints.length > 0;
    if (isInteracting) {
      pendingRemoteState = newState;
      return;
    }
    loadFromFirebase(newState);
  }
});

watch(isCurrentUserMuted, (muted) => {
  if (!canvas) return;
  if (muted) {
    currentTool.value = 'select';
    canvas.isDrawingMode = false;
    canvas.selection = false;
    canvas.discardActiveObject();
    canvas.forEachObject(o => {
      (o as any)._origSelectable = o.selectable;
      (o as any)._origEvented = o.evented;
      o.selectable = false;
      o.evented = false;
    });
    exitArrowNodeEditing();
    canvas.renderAll();
    displayToast('View-Only: You have been muted by the host and cannot edit the whiteboard.', 4000);
  } else {
    canvas.selection = true;
    canvas.forEachObject(o => {
      if ((o as any)._origSelectable !== undefined) {
        o.selectable = (o as any)._origSelectable;
        delete (o as any)._origSelectable;
      } else {
        o.selectable = true;
      }
      if ((o as any)._origEvented !== undefined) {
        o.evented = (o as any)._origEvented;
        delete (o as any)._origEvented;
      } else {
        o.evented = true;
      }
    });
    canvas.renderAll();
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
    clipboard = await activeObj.clone(CUSTOM_PROPS);
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

  const clonedObj = await clipboard.clone(CUSTOM_PROPS);
  canvas.discardActiveObject();

  const pastedItemsForUndo: UserUndoItem[] = [];

  const preparePastedObject = (obj: any) => {
    // Generate fresh unique ID so undo/redo and tracking never collides with original copied object!
    const newId = 'obj_' + Math.random().toString(36).substring(2, 11);
    obj.id = newId;
    if (obj.arrowId) {
      obj.arrowId = newId;
    }
    obj.authorUid = authStore.uid;

    obj.set({
      selectable: true,
      evented: true,
      perPixelTargetFind: true,
      objectCaching: false
    });

    if (obj.isStickyNote || (obj.type === 'textbox' && (obj.stickyColorConfig || obj.backgroundColor))) {
      obj.isStickyNote = true;
      obj.minHeight = obj.minHeight || 180;
      obj.textAlign = 'center';
      obj.splitByGrapheme = true;
      obj.lockUniScaling = true;
      obj.hasRotatingPoint = false;
      obj.set({
        perPixelTargetFind: false,
        selectable: true,
        evented: true
      });
      applyStickyNoteMethods(obj);
      obj.initDimensions?.();
      obj.setCoords();
    }

    if (obj.isArrow) {
      obj.set({
        lockUniScaling: false,
        strokeUniform: true
      });
      const oldM = (obj as any).initialMatrix || obj.calcTransformMatrix();
      const newM = obj.calcTransformMatrix();
      try {
        const invOldM = fabric.util.invertTransform(oldM);
        const deltaM = fabric.util.multiplyTransformMatrices(newM, invOldM);
        if (Array.isArray(obj.arrowPoints)) {
          obj.arrowPoints = obj.arrowPoints.map((pt: any) => fabric.util.transformPoint(pt, deltaM));
        }
      } catch (err) {
        console.warn('Failed to offset arrowPoints on paste:', err);
      }
      obj.initialMatrix = newM;
      obj.setCoords();
    }

    pastedItemsForUndo.push({
      targetId: newId,
      authorUid: authStore.uid,
      objectJson: obj.toObject(CUSTOM_PROPS)
    });
  };

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
      preparePastedObject(obj);
      canvas?.add(obj);
    });
    clonedObj.setCoords();
  } else {
    preparePastedObject(clonedObj);
    canvas.add(clonedObj);
  }

  if (pastedItemsForUndo.length > 0) {
    localUserUndoStack.value.push({
      type: 'add',
      items: pastedItemsForUndo
    });
    if (localUserUndoStack.value.length > 50) localUserUndoStack.value.shift();
    localUserRedoStack.value = [];
  }

  canvas.setActiveObject(clonedObj);
  canvas.requestRenderAll();
  saveHistoryState();
  syncToFirebase();
  updateSelectionState();
  triggerDebouncedAutoSave();
  displayToast('Pasted (Ctrl+V)');
};

// Sticky Note Actions (Native unified fabric.Textbox with instant typing mode)
const spawnStickyNote = (x: number, y: number, colorCfg = selectedStickyColor.value) => {
  if (!canvas) return;
  const size = 180;
  const note = new fabric.Textbox('', {
    left: x - size / 2,
    top: y - size / 2,
    width: size,
    fontSize: 15,
    fontFamily: 'Inter, sans-serif',
    backgroundColor: colorCfg.bg,
    fill: colorCfg.text,
    textAlign: 'center',
    splitByGrapheme: true,
    padding: 0,
    rx: 0,
    ry: 0,
    strokeWidth: 0,
    shadow: new fabric.Shadow({
      color: 'rgba(0, 0, 0, 0.25)',
      blur: 4,
      offsetX: 3,
      offsetY: 4
    }),
    perPixelTargetFind: false,
    lockUniScaling: true,
    hasRotatingPoint: false,
    objectCaching: false
  });

  (note as any).isStickyNote = true;
  (note as any).stickyColorConfig = colorCfg;
  (note as any).minHeight = 180;
  (note as any).isLocked = false;
  (note as any).id = 'note_' + Date.now() + '_' + Math.random().toString(36).substring(2, 9);
  (note as any).authorUid = authStore.uid;
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
  updateFloatingToolbars();

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
  const cloned = await note.clone(CUSTOM_PROPS);
  const newId = 'note_' + Date.now() + '_' + Math.random().toString(36).substring(2, 9);
  cloned.id = newId;
  cloned.authorUid = authStore.uid;
  cloned.set({
    left: (note.left || 0) + 24,
    top: (note.top || 0) + 24,
    selectable: true,
    evented: true,
    perPixelTargetFind: false,
    lockUniScaling: true,
    hasRotatingPoint: false,
    objectCaching: false
  });
  (cloned as any).isStickyNote = true;
  (cloned as any).stickyColorConfig = (note as any).stickyColorConfig;
  (cloned as any).minHeight = (note as any).minHeight || 180;
  applyStickyNoteMethods(cloned);
  cloned.initDimensions();
  cloned.setCoords();
  canvas.add(cloned);
  canvas.setActiveObject(cloned);
  canvas.requestRenderAll();
  saveHistoryState();
  syncToFirebase();
  updateSelectionState();
  displayToast('Duplicated');
};

// Group Isolation Mode Actions (supports nested group isolation stack)
const enterGroupIsolation = (group: fabric.Group, targetChild?: any) => {
  if (!canvas) return;

  isInternalChange = true;
  try {
    // Snapshot the current canvas state for this isolation level
    const savedProps: Array<{ obj: any; opacity: number; selectable: boolean; evented: boolean }> = [];
    canvas.getObjects().forEach((o: any) => {
      savedProps.push({
        obj: o,
        opacity: o.opacity ?? 1,
        selectable: o.selectable ?? true,
        evented: o.evented ?? true
      });
    });

    const isEnteringRoot = !isIsolationMode.value;
    if (isEnteringRoot) {
      isIsolationMode.value = true;
      isolationStack.value = [];
      hasIsolationChanged.value = false;
      // Record true root interaction and opacity properties for ALL canvas objects
      canvas.getObjects().forEach((o: any) => {
        o._rootOrigOpacity = o.opacity ?? 1;
        o._rootOrigSelectable = o.selectable ?? true;
        o._rootOrigEvented = o.evented ?? true;
      });
    } else if (isolatedGroup) {
      // Nested group isolation: push current level onto stack
      isolationStack.value.push({
        group: isolatedGroup,
        items: isolatedItems,
        savedProps
      });
    }

    isolatedGroup = group;

    // Dim all other canvas objects except this group
    canvas.getObjects().forEach((o: any) => {
      if (o !== group) {
        o.set({ opacity: 0.2, selectable: false, evented: false });
      }
    });

    // Extract items from group onto canvas
    isolatedItems = group.removeAll();
    canvas.remove(group);
    isolatedItems.forEach(item => {
      item.set({
        opacity: 1,
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

    if (Array.isArray(targetChild) && targetChild.length > 0) {
      const validTargets = targetChild.filter(c => isolatedItems.includes(c));
      if (validTargets.length === 1) {
        canvas.setActiveObject(validTargets[0]);
      } else if (validTargets.length > 1) {
        const activeSel = new fabric.ActiveSelection(validTargets, { canvas });
        canvas.setActiveObject(activeSel);
      }
    } else if (targetChild && isolatedItems.includes(targetChild)) {
      canvas.setActiveObject(targetChild);
    }
    canvas.requestRenderAll();
    updateSelectionState();
  } finally {
    isInternalChange = false;
  }
};

const exitGroupIsolation = () => {
  if (!canvas || !isIsolationMode.value) return;

  let localHasChanged = hasIsolationChanged.value;
  isInternalChange = true;
  try {
    // Re-bundle ONLY remaining isolated items back into group (ignoring deleted items!)
    const remainingItems = isolatedItems.filter(item => canvas?.getObjects().includes(item));
    remainingItems.forEach(item => canvas?.remove(item));

    let bundledGroup: any = null;
    if (remainingItems.length > 1) {
      const newGroup = new fabric.Group(remainingItems, {
        canvas,
        subTargetCheck: false,
        perPixelTargetFind: true
      });
      const allLocked = remainingItems.length > 0 && remainingItems.every((o: any) => o.isLocked);
      const anyLocked = remainingItems.some((o: any) => o.isLocked);
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
      bundledGroup = newGroup;
    } else if (remainingItems.length === 1) {
      // Only 1 item left, leave it as an ungrouped object
      canvas.add(remainingItems[0]);
      canvas.setActiveObject(remainingItems[0]);
      bundledGroup = remainingItems[0];
    }

    // If there are parent levels on the stack, step back to the previous level!
    if (isolationStack.value.length > 0) {
      const parentLevel = isolationStack.value.pop()!;
      isolatedGroup = parentLevel.group;
      // Keep items from parent level that are still on canvas, and include the newly bundled group
      isolatedItems = parentLevel.items.filter(item => canvas?.getObjects().includes(item));
      if (bundledGroup && !isolatedItems.includes(bundledGroup)) {
        isolatedItems.push(bundledGroup);
      }

      // Restore interaction / opacity for parent level's objects
      parentLevel.savedProps.forEach(sp => {
        if (canvas?.getObjects().includes(sp.obj)) {
          sp.obj.set({
            opacity: sp.opacity,
            selectable: sp.selectable,
            evented: sp.evented
          });
        }
      });

      // Ensure all items belonging to this restored level are interactive and opaque
      isolatedItems.forEach(item => {
        item.set({
          opacity: 1,
          selectable: true,
          evented: true,
          hasControls: !(item as any).isLocked
        });
      });

      canvas.requestRenderAll();
      updateSelectionState();
      return;
    }

    // Fully exit all isolation levels
    canvas.getObjects().forEach((o: any) => {
      o.set({
        opacity: o._rootOrigOpacity !== undefined ? o._rootOrigOpacity : (o.opacity !== undefined ? o.opacity : 1),
        selectable: o._rootOrigSelectable !== undefined ? o._rootOrigSelectable : true,
        evented: o._rootOrigEvented !== undefined ? o._rootOrigEvented : true
      });
      delete o._rootOrigOpacity;
      delete o._rootOrigSelectable;
      delete o._rootOrigEvented;
      delete o._origOpacity;
      delete o._origSelectable;
      delete o._origEvented;
    });

    isIsolationMode.value = false;
    isolatedGroup = null;
    isolatedItems = [];
    isolationStack.value = [];
    canvas.requestRenderAll();
    updateSelectionState();
  } finally {
    isInternalChange = false;
  }
  
  if (localHasChanged) {
    hasIsolationChanged.value = false;
    saveHistoryState();
    syncToFirebase();
  }
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
const isRecentlySaved = ref(false);
let saveFeedbackTimeout: any = null;
const handleQuickSave = async () => {
  if (autoSaveDebounceTimer) clearTimeout(autoSaveDebounceTimer);
  saveStatus.value = 'saving';
  isRecentlySaved.value = true;
  try {
    await triggerAutoSaveAsAsset();
    if (!navigator.onLine) {
      saveStatus.value = 'offline';
    } else {
      saveStatus.value = 'saved';
    }
    if (saveFeedbackTimeout) clearTimeout(saveFeedbackTimeout);
    saveFeedbackTimeout = setTimeout(() => {
      isRecentlySaved.value = false;
      if (saveStatus.value === 'saved') {
        saveStatus.value = 'idle';
      }
    }, 2500);
    displayToast(isCollabActive.value ? 'Whiteboard saved to Assets Library' : 'Saved to Personal Drafts');
  } catch (e) {
    saveStatus.value = 'offline';
    displayToast('Saved offline');
  }
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
    originY: 'top',
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

  // 1. If the selected object is locked, reject deletion immediately
  if (activeObj.isLocked) {
    displayToast('Locked object cannot be deleted (Unlock with Ctrl+L first)');
    return;
  }

  // 2. ActiveSelection (multiple objects selected together)
  if (activeObj.type === 'activeselection') {
    const targets = activeObj.getObjects();
    const locked = targets.filter((obj: any) => obj.isLocked === true);
    const deletable = targets.filter((obj: any) => obj.isLocked !== true);

    if (locked.length > 0) {
      displayToast('Locked objects cannot be deleted (Unlock with Ctrl+L first)');
    }
    if (deletable.length) {
      canvas.discardActiveObject();
      const removedItems: UserUndoItem[] = [];
      deletable.forEach((obj: any) => {
        if (obj.isEditing && obj.exitEditing) obj.exitEditing();
        if (obj.authorUid === authStore.uid || !isCollabActive.value) {
          removedItems.push({
            targetId: obj.id || obj.arrowId || '',
            authorUid: obj.authorUid || authStore.uid,
            objectJson: obj.toObject(CUSTOM_PROPS)
          });
        }
        canvas?.remove(obj);
      });
      if (removedItems.length > 0) {
        localUserUndoStack.value.push({ type: 'remove', items: removedItems });
        if (localUserUndoStack.value.length > 50) localUserUndoStack.value.shift();
        localUserRedoStack.value = [];
      }
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

  // 3. User Group (fabric.Group, but NOT a sticky note, and NOT an arrow!)
  if (activeObj.type === 'group' && !activeObj.isStickyNote && !(activeObj as any).isArrow) {
    const targets = activeObj.getObjects ? activeObj.getObjects() : activeObj._objects || [];
    const hasLocked = targets.some((obj: any) => obj.isLocked === true);
    if (activeObj.isLocked || hasLocked) {
      displayToast('Locked group or object inside cannot be deleted (Unlock with Ctrl+L first)');
      return;
    }
    if (activeObj.authorUid === authStore.uid || !isCollabActive.value) {
      localUserUndoStack.value.push({
        type: 'remove',
        items: [{
          targetId: activeObj.id || activeObj.arrowId || '',
          authorUid: activeObj.authorUid || authStore.uid,
          objectJson: activeObj.toObject(CUSTOM_PROPS)
        }]
      });
      if (localUserUndoStack.value.length > 50) localUserUndoStack.value.shift();
      localUserRedoStack.value = [];
    }
    canvas.remove(activeObj);
    canvas.discardActiveObject();
    canvas.requestRenderAll();
    saveHistoryState();
    syncToFirebase();
    updateSelectionState();
    return;
  }

  // 4. Single objects (arrow, sticky note, path, shape, etc.)
  if (activeObj.authorUid === authStore.uid || !isCollabActive.value) {
    localUserUndoStack.value.push({
      type: 'remove',
      items: [{
        targetId: activeObj.id || activeObj.arrowId || '',
        authorUid: activeObj.authorUid || authStore.uid,
        objectJson: activeObj.toObject(CUSTOM_PROPS)
      }]
    });
    if (localUserUndoStack.value.length > 50) localUserUndoStack.value.shift();
    localUserRedoStack.value = [];
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
  if (isGrp && !activeObj.isStickyNote && !(activeObj as any).isArrow) {
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
  if (!canvas) return;

  if (isIsolationMode.value) {
    // Fully exit isolation before performing undo to prevent state corruption
    while (isIsolationMode.value) {
      exitGroupIsolation();
    }
  }

  // 1. Personal mode: Deterministic chronological snapshot undo
  if (!isCollabActive.value) {
    if (historyStack.value.length > 1) {
      isInternalChange = true;
      try {
        const currentState = historyStack.value.pop()!;
        redoStack.value.push(currentState);
        const previousState = historyStack.value[historyStack.value.length - 1];
        await canvas.loadFromJSON(previousState);
        rehydrateCanvasObjects();
        syncNodeEditingStateAfterReload();

        if (isIsolationMode.value) {
          const allObjs = canvas.getObjects();
          if (isolatedGroup && allObjs.includes(isolatedGroup)) {
            isIsolationMode.value = false;
            isolatedGroup = null;
            isolatedItems = [];
            isolationStack.value = [];
          } else {
            isolatedItems = isolatedItems.filter(item => allObjs.includes(item));
          }
        }

        canvas.requestRenderAll();
        updateSelectionState();
        displayToast('Undo (Ctrl+Z)');
      } finally {
        isInternalChange = false;
      }
    } else {
      displayToast('Nothing to undo');
    }
    return;
  }

  // 2. Collaborative mode: User-scoped action undo (add, remove, modify)
  if (localUserUndoStack.value.length > 0) {
    const action = localUserUndoStack.value.pop()!;
    isInternalChange = true;
    try {
      if (action.type === 'add') {
        const redoItems: UserUndoItem[] = [];
        for (const item of action.items) {
          const found = canvas.getObjects().find((o: any) => (o.id && o.id === item.targetId) || (o.arrowId && o.arrowId === item.targetId));
          if (found) {
            redoItems.push({
              targetId: item.targetId,
              authorUid: item.authorUid,
              objectJson: found.toObject(CUSTOM_PROPS)
            });
            canvas.remove(found);
          }
        }
        if (redoItems.length > 0) {
          localUserRedoStack.value.push({ type: 'remove', items: redoItems });
        }
      } else if (action.type === 'remove') {
        const redoItems: UserUndoItem[] = [];
        for (const item of action.items) {
          if (item.objectJson) {
            const enlivened = await fabric.util.enlivenObjects([item.objectJson]);
            if (enlivened && enlivened[0]) {
              const obj = enlivened[0] as any;
              obj.authorUid = item.authorUid;
              obj.id = item.targetId;
              canvas.add(obj);
              obj.setCoords();
              redoItems.push(item);
            }
          }
        }
        if (redoItems.length > 0) {
          localUserRedoStack.value.push({ type: 'add', items: redoItems });
        }
        rehydrateCanvasObjects();
      } else if (action.type === 'modify') {
        const redoItems: UserUndoItem[] = [];
        for (const item of action.items) {
          const found = canvas.getObjects().find((o: any) => (o.id && o.id === item.targetId) || (o.arrowId && o.arrowId === item.targetId));
          if (found && item.beforeProps) {
            redoItems.push({
              targetId: item.targetId,
              authorUid: item.authorUid,
              beforeProps: item.afterProps,
              afterProps: item.beforeProps
            });
            found.set(item.beforeProps);
            if ((found as any).isStickyNote || (found as any).stickyColorConfig) {
              if (item.beforeProps.minHeight !== undefined) {
                (found as any).minHeight = item.beforeProps.minHeight;
              }
              (found as any).initDimensions?.();
            }
            found.setCoords();
          }
        }
        if (redoItems.length > 0) {
          localUserRedoStack.value.push({ type: 'modify', items: redoItems });
        }
      }
      canvas.requestRenderAll();
      syncToFirebase();
      updateSelectionState();
      displayToast('Undo: reverted your change (Ctrl+Z)');
      return;
    } finally {
      isInternalChange = false;
    }
  }

  displayToast('Nothing to undo');
};

const redo = async () => {
  if (!canvas) return;

  if (isIsolationMode.value) {
    while (isIsolationMode.value) {
      exitGroupIsolation();
    }
  }

  // 1. Personal mode: Deterministic chronological snapshot redo
  if (!isCollabActive.value) {
    if (redoStack.value.length > 0) {
      isInternalChange = true;
      try {
        const nextState = redoStack.value.pop()!;
        historyStack.value.push(nextState);
        await canvas.loadFromJSON(nextState);
        rehydrateCanvasObjects();
        syncNodeEditingStateAfterReload();

        if (isIsolationMode.value) {
          const allObjs = canvas.getObjects();
          if (isolatedGroup && allObjs.includes(isolatedGroup)) {
            isIsolationMode.value = false;
            isolatedGroup = null;
            isolatedItems = [];
            isolationStack.value = [];
          } else {
            isolatedItems = isolatedItems.filter(item => allObjs.includes(item));
          }
        }

        canvas.requestRenderAll();
        updateSelectionState();
        displayToast('Redo (Ctrl+Y)');
      } finally {
        isInternalChange = false;
      }
    } else {
      displayToast('Nothing to redo');
    }
    return;
  }

  // 2. Collaborative mode: User-scoped action redo (remove, add, modify)
  if (localUserRedoStack.value.length > 0) {
    const action = localUserRedoStack.value.pop()!;
    isInternalChange = true;
    try {
      if (action.type === 'remove') {
        // Redo is re-applying an action that was undone by removing.
        // Undo undid an 'add' by removing the object and pushed type: 'remove'.
        // Redo must re-add the object back to the canvas.
        const undoItems: UserUndoItem[] = [];
        for (const item of action.items) {
          if (item.objectJson) {
            const enlivened = await fabric.util.enlivenObjects([item.objectJson]);
            if (enlivened && enlivened[0]) {
              const obj = enlivened[0] as any;
              obj.authorUid = item.authorUid;
              obj.id = item.targetId;
              canvas.add(obj);
              obj.setCoords();
              undoItems.push(item);
            }
          }
        }
        if (undoItems.length > 0) {
          localUserUndoStack.value.push({ type: 'add', items: undoItems });
        }
        rehydrateCanvasObjects();
      } else if (action.type === 'add') {
        // Undo undid a 'remove' by restoring the object and pushed type: 'add'.
        // Redo must delete the object again.
        const undoItems: UserUndoItem[] = [];
        for (const item of action.items) {
          const found = canvas.getObjects().find((o: any) => (o.id && o.id === item.targetId) || (o.arrowId && o.arrowId === item.targetId));
          if (found) {
            undoItems.push({
              targetId: item.targetId,
              authorUid: item.authorUid,
              objectJson: found.toObject(CUSTOM_PROPS)
            });
            canvas.remove(found);
          }
        }
        if (undoItems.length > 0) {
          localUserUndoStack.value.push({ type: 'remove', items: undoItems });
        }
      } else if (action.type === 'modify') {
        const undoItems: UserUndoItem[] = [];
        for (const item of action.items) {
          const found = canvas.getObjects().find((o: any) => (o.id && o.id === item.targetId) || (o.arrowId && o.arrowId === item.targetId));
          if (found && item.beforeProps) {
            undoItems.push({
              targetId: item.targetId,
              authorUid: item.authorUid,
              beforeProps: item.afterProps,
              afterProps: item.beforeProps
            });
            found.set(item.beforeProps);
            if ((found as any).isStickyNote || (found as any).stickyColorConfig) {
              if (item.beforeProps.minHeight !== undefined) {
                (found as any).minHeight = item.beforeProps.minHeight;
              }
              (found as any).initDimensions?.();
            }
            found.setCoords();
          }
        }
        if (undoItems.length > 0) {
          localUserUndoStack.value.push({ type: 'modify', items: undoItems });
        }
      }
      canvas.requestRenderAll();
      syncToFirebase();
      updateSelectionState();
      displayToast('Redo: reapplied your change (Ctrl+Y)');
      return;
    } finally {
      isInternalChange = false;
    }
  }

  displayToast('Nothing to redo');
};

const compressImage = (file: File, maxDim = 1200, quality = 0.8): Promise<string> => {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (event) => {
      const src = event.target?.result as string;
      const img = new Image();
      img.onload = () => {
        let w = img.width;
        let h = img.height;
        if (w > maxDim || h > maxDim) {
          if (w > h) {
            h = Math.round((h * maxDim) / w);
            w = maxDim;
          } else {
            w = Math.round((w * maxDim) / h);
            h = maxDim;
          }
        }
        const cvs = document.createElement('canvas');
        cvs.width = w;
        cvs.height = h;
        const ctx = cvs.getContext('2d');
        if (!ctx) {
          resolve(src);
          return;
        }
        ctx.drawImage(img, 0, 0, w, h);
        resolve(cvs.toDataURL('image/jpeg', quality));
      };
      img.onerror = () => resolve(src);
      img.src = src;
    };
    reader.onerror = () => resolve('');
    reader.readAsDataURL(file);
  });
};

const handleImageUpload = async (e: Event) => {
  const target = e.target as HTMLInputElement;
  const file = target.files?.[0];
  if (!file || !canvas) return;

  const compressedDataUrl = await compressImage(file);
  if (!compressedDataUrl) return;

  fabric.Image.fromURL(compressedDataUrl).then(img => {
    if (img.width && img.width > 800) {
      img.scaleToWidth(800);
    }
    if (canvas && wrapperRef.value) {
      const center = canvas.getVpCenter();
      const objId = 'img_' + Date.now() + '_' + Math.random().toString(36).substring(2, 9);
      img.set({
        left: center.x,
        top: center.y,
        originX: 'center',
        originY: 'center',
        perPixelTargetFind: true
      });
      (img as any).id = objId;
      (img as any).authorUid = authStore.uid;
      (img as any).authorName = authStore.displayName || 'Participant';

      canvas.add(img);
      canvas.setActiveObject(img);
      saveHistoryState();
      syncToFirebase();
      updateSelectionState();
      toggleMode(false);
    }
  });
  target.value = '';
};

const toggleMode = (drawing: boolean) => {
  if (drawing && isArrowNodeEditing.value) return;
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
  if (isArrowNodeEditing.value) return;
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
  if (isArrowNodeEditing.value) return;
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
  const dataUrl = getCanvasSnapshot(0.9, true);
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

const handlePublish = () => {
  if (!canvas) return;
  const json = getSerializedCanvasJson();
  const thumbnail = getCanvasSnapshot(0.3);
  roomStore.startWhiteboardSession(json, thumbnail, currentAssetId.value);
  displayToast('Whiteboard published for team collaboration');
};

const handleConfirmMakePrivate = async () => {
  if (!canvas) return;
  // Optimistically close modal immediately without waiting for Firebase latency
  showPrivateConfirmModal.value = false;
  showPublishMenu.value = false;
  displayToast('Board converted to private. Team session ended.');

  isConvertingToPrivate.value = true;
  try {
    await roomStore.makeWhiteboardPrivate();
  } catch (e) {
    console.error('Failed to make private:', e);
  } finally {
    isConvertingToPrivate.value = false;
  }
};

const handleCloseRequest = async () => {
  try {
    await triggerAutoSaveAsAsset();
  } catch (e) {
    console.warn('Auto-save on close error:', e);
  }
  emit('close');
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
  // Prevent Windows browser menu activation and enable center-scaling dynamically mid-drag
  if (e.key === 'Alt') {
    e.preventDefault();
    if (canvas) {
      const transform = (canvas as any)._currentTransform;
      if (transform) {
        if (!transform._origOriginX) {
          transform._origOriginX = transform.originX;
          transform._origOriginY = transform.originY;
        }
        transform.originX = 'center';
        transform.originY = 'center';
      }
      const target = transform?.target || canvas.getActiveObject();
      if (target) {
        target.centeredScaling = true;
      }
    }
  }

  // 0. ESC inside Confirmation Modal: cancel modal and return to editing
  if (e.key === 'Escape' && showCloseConfirmModal.value) {
    e.preventDefault();
    handleCancelCloseModal();
    return;
  }

  // Check if keystroke target is an external input outside the whiteboard container (e.g. Chat input, external search)
  const activeEl = document.activeElement as HTMLElement | null;
  const isExternalInput = activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA') && !rootRef.value?.contains(activeEl);
  if (isExternalInput) return;

  const targetEl = e.target as HTMLElement | null;
  const targetTag = targetEl?.tagName?.toLowerCase();
  const isInputTarget = (targetTag === 'input' || targetTag === 'textarea') && !targetEl?.classList?.contains('fabric-canvas-textarea') && !rootRef.value?.contains(targetEl);
  if (isInputTarget) return;

  // If user has highlighted text on screen outside the whiteboard (e.g. In chat), let system copy naturally
  const selection = window.getSelection();
  if (selection && selection.toString().trim() && !rootRef.value?.contains(selection.anchorNode)) {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C')) {
      return;
    }
  }

  const activeObj = canvas?.getActiveObject() as any;

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
    if (isArrowNodeEditing.value) {
      e.preventDefault();
      deleteSelectedArrowNodes();
      return;
    }
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
  } else if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key) && activeObj) {
    if ((activeObj as any).isLocked) return;
    e.preventDefault();
    let step = 1;
    if (e.shiftKey) {
      step = 10;
    } else if (e.ctrlKey || e.metaKey || e.altKey) {
      step = 20;
    }

    let dx = 0;
    let dy = 0;
    if (e.key === 'ArrowUp') dy = -step;
    if (e.key === 'ArrowDown') dy = step;
    if (e.key === 'ArrowLeft') dx = -step;
    if (e.key === 'ArrowRight') dx = step;

    activeObj.set({
      left: (activeObj.left || 0) + dx,
      top: (activeObj.top || 0) + dy
    });
    activeObj.setCoords();
    if ((activeObj.type === 'activeselection' || activeObj.type === 'activeSelection') && activeObj.forEachObject) {
      activeObj.forEachObject((c: any) => {
        c.setCoords();
      });
    }
    canvas?.requestRenderAll();
    updateFloatingToolbars();
    updateArrowToolbar();
    saveHistoryState();
    syncToFirebase();
    triggerDebouncedAutoSave();
  }
};

const handleWindowClick = () => {
  if (contextMenu.value.visible) {
    contextMenu.value.visible = false;
  }
};

type SaveStatus = 'idle' | 'saving' | 'saved' | 'offline';
const saveStatus = ref<SaveStatus>('idle');
let autoSaveDebounceTimer: any = null;
let saveStatusResetTimer: any = null;

const isBlankCanvasWithoutHistory = (): boolean => {
  if (!canvas) return true;
  const nonSystemObjects = canvas.getObjects().filter((o: any) => o !== (canvas as any).clipPath && !o.excludeFromExport);
  return nonSystemObjects.length === 0 && historyStack.value.length <= 1 && !props.initialJson;
};

async function triggerAutoSaveAsAsset() {
  if (!canvas || isBlankCanvasWithoutHistory()) return '';
  const json = getSerializedCanvasJson();
  const dataUrl = getCanvasSnapshot(0.7);
  emit('save-state', json, dataUrl, currentAssetId.value, !isCollabActive.value);
  hasUnsavedChanges.value = false;
  return json;
}

function triggerDebouncedAutoSave(delay = 800) {
  if (!canvas || isBlankCanvasWithoutHistory()) {
    saveStatus.value = 'idle';
    hasUnsavedChanges.value = false;
    return;
  }
  const activeObj = canvas.getActiveObject() as any;
  if (activeObj?.isEditing) {
    // Defer auto-save while typing/editing in a note or textbox
    return;
  }
  hasUnsavedChanges.value = true;
  saveStatus.value = 'saving';
  if (autoSaveDebounceTimer) clearTimeout(autoSaveDebounceTimer);
  autoSaveDebounceTimer = setTimeout(async () => {
    try {
      if (!navigator.onLine) {
        saveStatus.value = 'offline';
        await triggerAutoSaveAsAsset();
        return;
      }
      await triggerAutoSaveAsAsset();
      saveStatus.value = 'saved';
      if (saveStatusResetTimer) clearTimeout(saveStatusResetTimer);
      saveStatusResetTimer = setTimeout(() => {
        if (saveStatus.value === 'saved') {
          saveStatus.value = 'idle';
        }
      }, 2500);
    } catch (e) {
      console.warn('Auto-save error:', e);
      saveStatus.value = 'offline';
    }
  }, delay);
}

const handleBeforeUnload = (e: BeforeUnloadEvent) => {
  if (isBlankCanvasWithoutHistory()) return;
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
  handlePublish,
  handleConfirmMakePrivate,
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
    const objW = (bound.width || 200) * targetScale;
    const objH = (bound.height || 200) * targetScale;
    const margin = 50;

    let targetX = center.x;
    let targetY = center.y;

    // Strict clamping within the 3200x2000 workspace boundary
    const minX = objW / 2 + margin;
    const maxX = Math.max(minX, WORKSPACE_WIDTH - objW / 2 - margin);
    const minY = objH / 2 + margin;
    const maxY = Math.max(minY, WORKSPACE_HEIGHT - objH / 2 - margin);

    targetX = Math.max(minX, Math.min(maxX, targetX));
    targetY = Math.max(minY, Math.min(maxY, targetY));

    obj.set({
      left: targetX,
      top: targetY,
      originX: 'center',
      originY: 'center',
      scaleX: targetScale,
      scaleY: targetScale,
      perPixelTargetFind: true
    });
    canvas.add(obj);
    canvas.setActiveObject(obj);

    // If center was outside workspace or object is offscreen, re-center viewport cleanly
    if (center.x < minX || center.x > maxX || center.y < minY || center.y > maxY) {
      const vpt = canvas.viewportTransform;
      if (vpt && wrapperRef.value) {
        const zoom = canvas.getZoom();
        vpt[4] = (wrapperRef.value.clientWidth / 2) - (targetX * zoom);
        vpt[5] = (wrapperRef.value.clientHeight / 2) - (targetY * zoom);
        clampViewportPan();
      }
    }
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
    updateFloatingToolbars();
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
      updateFloatingToolbars();
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
      updateFloatingToolbars();
      viewportVersion.value++;
      canvas.requestRenderAll();
    }
  }
};

const handleKeyup = (e: KeyboardEvent) => {
  if (e.key === 'Alt') {
    e.preventDefault();
    if (canvas) {
      const transform = (canvas as any)._currentTransform;
      if (transform && transform._origOriginX) {
        transform.originX = transform._origOriginX;
        transform.originY = transform._origOriginY;
        transform._origOriginX = null;
        transform._origOriginY = null;
      }
      const target = transform?.target || canvas.getActiveObject();
      if (target) {
        target.centeredScaling = false;
      }
    }
  }
};

const onWindowPointerUp = () => {
  isMouseDown = false;
  isDragging = false;
};

onMounted(() => {
  window.addEventListener('pointerup', onWindowPointerUp);
  window.addEventListener('keydown', handleKeydown, { capture: true });
  window.addEventListener('keyup', handleKeyup, { capture: true });
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
  if (isCollabActive.value) {
    startCursorListener();
  }
  nextTick(() => {
    initFabric();
  });
});

watch(() => roomStore.currentRoom?.roomId, (newRoomId) => {
  if (newRoomId && isCollabActive.value) {
    startCursorListener();
  }
});

watch(isCollabActive, (active) => {
  if (active) {
    startCursorListener();
  } else {
    if (unsubCursors) {
      unsubCursors();
      unsubCursors = null;
    }
    stopCursorLerpLoop();
    removeMyCursor();
    smoothedCursors.value = {};
    remoteCursors.value = {};
  }
});

onUnmounted(() => {
  stopCursorLerpLoop();
  removeMyCursor();
  if (unsubCursors) {
    unsubCursors();
    unsubCursors = null;
  }
  window.removeEventListener('pointerup', onWindowPointerUp);
  window.removeEventListener('keydown', handleKeydown, { capture: true });
  window.removeEventListener('keyup', handleKeyup, { capture: true });
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
    <!-- Unified Top Header Container (Guarantees center banners never overlap right buttons) -->
    <div class="absolute top-4 left-4 right-4 z-30 flex items-center justify-between gap-2 pointer-events-none select-none">
      <!-- Top Left: Status Badge -->
      <div
        class="flex items-center gap-2 transition-opacity duration-200 pointer-events-auto shrink-0"
        :class="{ 'opacity-15': isHoveringSend }"
      >
        <!-- Shared Canvas Badge -->
        <div
          v-if="isCollabActive"
          class="h-8 px-2.5 rounded-xl bg-emerald-600/90 shadow-sm border border-emerald-400 flex items-center gap-1.5 sm:gap-2 text-xs font-semibold text-white shrink-0"
          title="Shared Canvas (Team Collaboration Active)"
        >
          <Users class="w-3.5 h-3.5 text-emerald-200 shrink-0" />
          <span class="w-2 h-2 rounded-full bg-emerald-300 animate-pulse shrink-0"></span>
          <span v-if="whiteboardContainerWidth >= 640" class="truncate max-w-[140px]">{{ roomStore.currentRoom?.whiteboardHostName }} Shared Canvas</span>
        </div>

        <!-- Personal Badge -->
        <div
          v-else
          class="h-8 px-2.5 rounded-xl bg-white/95 shadow-sm border border-slate-200 flex items-center gap-1.5 sm:gap-2 text-xs font-semibold text-slate-700 shrink-0"
          title="Personal (Private Draft)"
        >
          <User class="w-3.5 h-3.5 text-sky-500 shrink-0" />
          <span v-if="whiteboardContainerWidth >= 640">Personal</span>
        </div>
      </div>

      <!-- Top Center: Floating Banners (Isolation / Node Edit / View-Only) -->
      <div class="flex-1 min-w-0 flex items-center justify-center px-1 sm:px-2 pointer-events-none">
        <!-- View-Only Banner for Muted Users -->
        <div
          v-if="isCurrentUserMuted"
          class="pointer-events-auto px-3.5 py-1.5 rounded-2xl bg-rose-950/90 border border-rose-500/50 text-rose-300 text-xs font-semibold shadow-2xl backdrop-blur-md flex items-center gap-2 truncate"
        >
          <MicOff class="w-4 h-4 text-rose-400 shrink-0" />
          <span class="truncate">View-Only: Muted by host</span>
        </div>

        <!-- Group Isolation Mode Top Floating Banner (hidden while in arrow node edit mode) -->
        <div
          v-else-if="isIsolationMode && !isArrowNodeEditing"
          class="pointer-events-auto flex items-center gap-1.5 sm:gap-2 px-2 sm:px-3 py-1 bg-slate-900/95 border border-indigo-500/80 rounded-2xl shadow-2xl backdrop-blur-md animate-in fade-in zoom-in-95 whitespace-nowrap select-none shrink-0"
        >
          <div v-if="whiteboardContainerWidth >= 560" class="flex items-center gap-1 sm:gap-1.5 text-indigo-300 font-medium text-xs whitespace-nowrap shrink-0">
            <Group class="w-3.5 h-3.5 sm:w-4 sm:h-4 text-indigo-400 shrink-0" />
            <span>{{ isolationStack.length > 0 ? `Isolation (L${isolationStack.length + 1})` : 'Isolation' }}</span>
            <span v-if="whiteboardContainerWidth >= 768" class="text-slate-400 font-normal text-[11px]">(ESC to exit)</span>
          </div>
          <button
            @click="exitGroupIsolation"
            class="px-2 py-0.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium text-[11px] sm:text-xs transition cursor-pointer whitespace-nowrap shrink-0 shadow-sm flex items-center gap-1"
            :title="isolationStack.length > 0 ? 'Back (ESC)' : 'Exit Isolation (ESC)'"
          >
            <Group v-if="whiteboardContainerWidth < 560" class="w-3.5 h-3.5 text-indigo-200" />
            <span>{{ isolationStack.length > 0 ? 'Back' : 'Exit' }}</span>
          </button>
        </div>

        <!-- Arrow & Line Node Editing Mode Top Floating Banner -->
        <div
          v-else-if="isArrowNodeEditing"
          class="pointer-events-auto flex items-center gap-1.5 sm:gap-2 px-2 sm:px-3 py-1 bg-slate-900/95 border border-indigo-500/80 rounded-2xl shadow-2xl backdrop-blur-md animate-in fade-in zoom-in-95 whitespace-nowrap select-none shrink-0"
        >
          <div v-if="whiteboardContainerWidth >= 560" class="flex items-center gap-1.5 sm:gap-2 text-indigo-300 font-medium text-xs whitespace-nowrap shrink-0">
            <Waypoints class="w-3.5 h-3.5 sm:w-4 sm:h-4 text-indigo-400 shrink-0" />
            <span>Node Edit</span>

            <!-- Compact ? Help Button with concise card tooltip (vanishes immediately on mouse leave) -->
            <div
              class="relative inline-flex items-center"
              @mouseenter="showNodeHelp = true"
              @mouseleave="showNodeHelp = false"
            >
              <button
                type="button"
                @click.stop="showNodeHelp = !showNodeHelp"
                class="w-4 h-4 rounded-full bg-indigo-500/20 hover:bg-indigo-500/40 text-indigo-300 text-[10px] font-bold flex items-center justify-center transition cursor-pointer border border-indigo-400/40"
                aria-label="Node editing guide"
              >
                ?
              </button>
              <div
                v-if="showNodeHelp"
                class="absolute top-full left-1/2 -translate-x-1/2 mt-2 z-50 w-72 sm:w-80 p-3 bg-slate-950/95 border border-indigo-500/60 rounded-xl text-slate-200 text-xs shadow-2xl backdrop-blur-md transition select-none"
              >
                <div class="text-[11px] text-slate-300 leading-relaxed space-y-1.5">
                  <p><span class="text-indigo-300 font-semibold">Double-click line:</span> Add new vector node</p>
                  <p><span class="text-indigo-300 font-semibold">Double-click node:</span> Toggle sharp corner / smooth curve</p>
                  <p><span class="text-indigo-300 font-semibold">Drag stroke line:</span> Move whole arrow or curve</p>
                  <p><span class="text-indigo-300 font-semibold">Drag background:</span> Marquee box select multiple nodes</p>
                  <p><span class="text-indigo-300 font-semibold">Del / Backspace:</span> Delete selected nodes</p>
                </div>
              </div>
            </div>
          </div>

          <div class="flex items-center gap-1 shrink-0">
            <button
              v-if="selectedNodeIndices.size > 0"
              @click="deleteSelectedArrowNodes"
              class="px-1.5 sm:px-2 py-0.5 rounded-lg bg-rose-600/80 hover:bg-rose-500 text-white font-medium text-[11px] sm:text-xs transition cursor-pointer whitespace-nowrap shrink-0"
              title="Delete selected nodes (Del/Backspace)"
            >
              <Trash2 v-if="whiteboardContainerWidth < 560" class="w-3.5 h-3.5" />
              <span v-else>Delete ({{ selectedNodeIndices.size }})</span>
            </button>
            <button
              @click="exitArrowNodeEditing"
              class="px-2 sm:px-2.5 py-0.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium text-[11px] sm:text-xs transition cursor-pointer whitespace-nowrap shrink-0 shadow-sm flex items-center gap-1"
              title="Done editing nodes (ESC)"
            >
              <Waypoints v-if="whiteboardContainerWidth < 560" class="w-3.5 h-3.5 text-indigo-200" />
              <span>Done</span>
            </button>
          </div>
        </div>
      </div>

      <!-- Top Right: Action Buttons -->
      <div
        class="flex items-center gap-1 sm:gap-2 transition-opacity duration-200 pointer-events-auto shrink-0"
        :class="{ 'opacity-15': isHoveringSend }"
      >
        <!-- Explicit Save Button with Animated Auto-Save Status (Saving, Saved, Offline, Save) -->
        <button
          @click="handleQuickSave"
          class="h-8 px-2.5 sm:px-3 rounded-xl transition-all duration-200 text-xs font-semibold flex items-center gap-1.5 cursor-pointer shadow-sm border"
          :class="[
            saveStatus === 'saved' || isRecentlySaved
              ? 'bg-emerald-50 text-emerald-700 border-emerald-400'
              : saveStatus === 'saving'
                ? 'bg-indigo-50 text-indigo-700 border-indigo-300'
                : saveStatus === 'offline'
                  ? 'bg-amber-50 text-amber-700 border-amber-300'
                  : 'bg-white/95 hover:bg-white text-slate-700 hover:text-indigo-600 border-slate-200'
          ]"
          title="Save whiteboard to Room Album (Ctrl+S)"
        >
          <Loader2 v-if="saveStatus === 'saving'" class="w-3.5 h-3.5 text-indigo-600 animate-spin shrink-0" />
          <Check v-else-if="saveStatus === 'saved' || isRecentlySaved" class="w-3.5 h-3.5 text-emerald-600 shrink-0" />
          <CloudOff v-else-if="saveStatus === 'offline'" class="w-3.5 h-3.5 text-amber-600 shrink-0" />
          <Save v-else class="w-3.5 h-3.5 text-indigo-500 shrink-0" />
          <span v-if="whiteboardContainerWidth >= 680" class="w-14 text-center inline-block truncate">
            {{
              saveStatus === 'saving'
                ? 'Saving...'
                : saveStatus === 'saved' || isRecentlySaved
                  ? 'Saved'
                  : saveStatus === 'offline'
                    ? 'Offline'
                    : 'Save'
            }}
          </span>
        </button>

        <!-- Toggle: Make Private (if Shared & Host) OR Share (if Personal) directly next to Save -->
        <button
          v-if="isCollabActive && roomStore.currentRoom?.whiteboardHostUid === authStore.uid"
          @click="showPrivateConfirmModal = true"
          class="h-8 px-2.5 sm:px-3 rounded-xl bg-rose-600 hover:bg-rose-500 text-white shadow-sm border border-rose-500 transition text-xs font-semibold flex items-center gap-1.5 cursor-pointer shrink-0"
          title="Convert to Private Board (Stop Team Collaboration)"
        >
          <Lock class="w-3.5 h-3.5 shrink-0" />
          <span v-if="whiteboardContainerWidth >= 680">Make Private</span>
        </button>

        <button
          v-else-if="!isCollabActive"
          @click="handlePublish"
          :disabled="isCurrentUserMuted"
          class="h-8 px-2.5 sm:px-3 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white shadow-sm border border-indigo-500 transition text-xs font-semibold flex items-center gap-1.5 cursor-pointer disabled:opacity-50 shrink-0"
          title="Publish as shared canvas for team collaboration"
        >
          <Globe class="w-3.5 h-3.5 shrink-0" />
          <span v-if="whiteboardContainerWidth >= 680">Share</span>
        </button>

        <!-- Shortcuts Cheatsheet -->
        <button @click="showShortcutsModal = true" class="h-8 w-8 rounded-xl bg-white/95 hover:bg-white text-slate-600 hover:text-indigo-600 shadow-sm border border-slate-200 transition cursor-pointer flex items-center justify-center shrink-0" title="Shortcuts Cheatsheet (?)">
          <HelpCircle class="w-3.5 h-3.5" />
        </button>

        <!-- Close Panel -->
        <button @click="handleCloseRequest" class="h-8 w-8 rounded-xl bg-white/95 hover:bg-white text-slate-500 hover:text-rose-600 shadow-sm border border-slate-200 transition cursor-pointer flex items-center justify-center shrink-0" title="Close Panel">
          <X class="w-3.5 h-3.5" />
        </button>
      </div>
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
      @mouseleave="removeMyCursor"
    >
      <canvas ref="canvasRef" class="w-full h-full touch-none"></canvas>

      <!-- Live Collaborative Cursors & Live Stroke Overlay -->
      <div v-if="isCollabActive" class="absolute inset-0 pointer-events-none z-30 overflow-hidden">
        <!-- Live Remote In-Progress Strokes & Shapes -->
        <svg class="absolute inset-0 w-full h-full pointer-events-none">
          <template v-for="c in Object.values(smoothedCursors)" :key="'stroke-' + c.uid">
            <!-- Freehand & Arrow In-Progress Strokes -->
            <path
              v-if="c.liveStroke?.points && c.liveStroke.points.length >= 2"
              :d="pointsToSvgPath(c.liveStroke.points)"
              fill="none"
              :stroke="c.liveStroke.color || c.color"
              :stroke-width="(c.liveStroke.width || 4) * (canvas?.getZoom() || 1)"
              stroke-linecap="round"
              stroke-linejoin="round"
              class="opacity-80"
            />
            <!-- Live Rectangle -->
            <rect
              v-if="c.liveShape?.shapeType === 'rect'"
              :x="getNodeScreenPos({ x: c.liveShape.x, y: c.liveShape.y }).x"
              :y="getNodeScreenPos({ x: c.liveShape.x, y: c.liveShape.y }).y"
              :width="c.liveShape.w * (canvas?.getZoom() || 1)"
              :height="c.liveShape.h * (canvas?.getZoom() || 1)"
              fill="none"
              :stroke="c.liveShape.color || c.color"
              :stroke-width="(c.liveShape.strokeWidth || 3) * (canvas?.getZoom() || 1)"
              class="opacity-80"
            />
            <!-- Live Circle (Ellipse) -->
            <ellipse
              v-else-if="c.liveShape?.shapeType === 'circle'"
              :cx="getNodeScreenPos({ x: c.liveShape.x, y: c.liveShape.y }).x"
              :cy="getNodeScreenPos({ x: c.liveShape.x, y: c.liveShape.y }).y"
              :rx="c.liveShape.w * (canvas?.getZoom() || 1)"
              :ry="c.liveShape.h * (canvas?.getZoom() || 1)"
              fill="none"
              :stroke="c.liveShape.color || c.color"
              :stroke-width="(c.liveShape.strokeWidth || 3) * (canvas?.getZoom() || 1)"
              class="opacity-80"
            />
            <!-- Live Triangle -->
            <polygon
              v-else-if="c.liveShape?.shapeType === 'triangle'"
              :points="getTriangleScreenPoints(c.liveShape)"
              fill="none"
              :stroke="c.liveShape.color || c.color"
              :stroke-width="(c.liveShape.strokeWidth || 3) * (canvas?.getZoom() || 1)"
              stroke-linejoin="round"
              class="opacity-80"
            />
            <!-- Live Line -->
            <line
              v-else-if="c.liveShape?.shapeType === 'line'"
              :x1="getNodeScreenPos({ x: c.liveShape.x, y: c.liveShape.y }).x"
              :y1="getNodeScreenPos({ x: c.liveShape.x, y: c.liveShape.y }).y"
              :x2="getNodeScreenPos({ x: c.liveShape.w, y: c.liveShape.h }).x"
              :y2="getNodeScreenPos({ x: c.liveShape.w, y: c.liveShape.h }).y"
              :stroke="c.liveShape.color || c.color"
              :stroke-width="(c.liveShape.strokeWidth || 3) * (canvas?.getZoom() || 1)"
              stroke-linecap="round"
              class="opacity-80"
            />
          </template>
        </svg>

        <!-- 60fps RAF Lerped Cursors with Natural OS Pointer Angle -->
        <div
          v-for="c in Object.values(smoothedCursors)"
          :key="c.uid"
          class="absolute top-0 left-0 will-change-transform"
          :style="{
            transform: `translate3d(${getNodeScreenPos({ x: c.currentX, y: c.currentY }).x}px, ${getNodeScreenPos({ x: c.currentX, y: c.currentY }).y}px, 0)`
          }"
        >
          <!-- Natural OS Cursor Pointer SVG (tip at 0,0, classic natural tilt) -->
          <svg
            class="w-5 h-5 drop-shadow-md"
            viewBox="0 0 24 24"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path
              d="M0 0 L5 15 L7.5 9.5 L13 8 L0 0 Z"
              :fill="c.color"
              stroke="#ffffff"
              stroke-width="1.5"
              stroke-linejoin="round"
            />
          </svg>
          <!-- Name & Avatar Pill -->
          <div
            class="ml-3 -mt-1 px-2 py-0.5 rounded-full text-[10px] font-semibold text-white shadow-md flex items-center gap-1 whitespace-nowrap select-none"
            :style="{ backgroundColor: c.color }"
          >
            <span>{{ c.avatar }}</span>
            <span>{{ c.name }}</span>
          </div>
        </div>
      </div>

      <!-- Send Viewport Capture Framing Guide / Viewfinder (Clipped strictly to visible workspace) -->
      <div
        v-if="isHoveringSend && viewfinderBounds"
        class="absolute border-2 border-dashed border-sky-400 pointer-events-none rounded-xl z-30 flex flex-col justify-start p-3 animate-in fade-in duration-200"
        :style="{
          left: `${viewfinderBounds.left}px`,
          top: `${viewfinderBounds.top}px`,
          width: `${viewfinderBounds.width}px`,
          height: `${viewfinderBounds.height}px`
        }"
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

      <!-- Unified Floating Quick-Action Bar below Active Object -->
      <div
        v-if="(stickyToolbarPosition.visible && activeStickyNote) || (lockToolbarPosition.visible && lockToolbarPosition.hasLocked) || (arrowToolbarPosition.visible && activeArrow && !isArrowNodeEditing)"
        class="absolute z-40 flex items-center gap-1.5 p-1 bg-slate-900/95 backdrop-blur-md border border-slate-700 rounded-xl shadow-2xl transition-opacity animate-in fade-in zoom-in-95 pointer-events-auto cursor-default select-none"
        :class="{ 'opacity-15': isHoveringSend }"
        @pointerdown.stop
        @mousedown.stop
        :style="{
          left: `${lockToolbarPosition.visible ? lockToolbarPosition.x : (stickyToolbarPosition.visible ? stickyToolbarPosition.x : arrowToolbarPosition.x)}px`,
          top: `${lockToolbarPosition.visible ? lockToolbarPosition.y : (stickyToolbarPosition.visible ? stickyToolbarPosition.y : arrowToolbarPosition.y)}px`,
          transform: 'translate(-50%, 0)'
        }"
      >
        <!-- Unlock Button (if locked: icon-only) -->
        <button
          v-if="lockToolbarPosition.visible && lockToolbarPosition.hasLocked"
          type="button"
          @pointerdown.stop
          @mousedown.stop
          @click.stop="unlockSelectedObjects"
          @mouseenter="highlightLockedObjects"
          @mouseleave="clearLockedHighlights"
          class="p-1.5 rounded-lg bg-amber-500/20 hover:bg-amber-500/35 text-amber-300 hover:text-amber-200 border border-amber-500/40 transition cursor-pointer shadow-sm flex items-center justify-center"
          title="Click to unlock (Ctrl+L)"
        >
          <Lock class="w-4 h-4 text-amber-400 pointer-events-none" />
        </button>

        <!-- Sticky Note Tools (only if unlocked) -->
        <template v-if="stickyToolbarPosition.visible && activeStickyNote && !(lockToolbarPosition.visible && lockToolbarPosition.hasLocked)">
          <div class="flex items-center gap-1 px-1">
            <button
              v-for="color in stickyColors"
              :key="color.name"
              type="button"
              @pointerdown.stop
              @mousedown.stop
              @click.stop="changeStickyNoteColor(activeStickyNote, color)"
              class="w-4 h-4 rounded-full border border-black/20 hover:scale-125 transition transform cursor-pointer"
              :style="{ backgroundColor: color.bg }"
              :title="color.name"
            ></button>
          </div>
          <div class="w-px h-4 bg-slate-700"></div>
          <button
            type="button"
            @pointerdown.stop
            @mousedown.stop
            @click.stop="duplicateStickyNote(activeStickyNote)"
            class="p-1 hover:bg-slate-800 text-slate-300 hover:text-white rounded-lg transition cursor-pointer"
            title="Duplicate Note"
          >
            <Copy class="w-3.5 h-3.5 pointer-events-none" />
          </button>
          <button
            type="button"
            @pointerdown.stop
            @mousedown.stop
            @click.stop="toggleLockSelected"
            class="p-1 hover:bg-slate-800 text-slate-300 hover:text-white rounded-lg transition cursor-pointer"
            title="Lock Note (Ctrl+L)"
          >
            <Unlock class="w-3.5 h-3.5 pointer-events-none" />
          </button>
          <button
            type="button"
            @pointerdown.stop
            @mousedown.stop
            @click.stop="deleteSelected"
            class="p-1 hover:bg-rose-950/60 text-rose-400 hover:text-rose-300 rounded-lg transition cursor-pointer"
            title="Delete Note"
          >
            <Trash2 class="w-3.5 h-3.5 pointer-events-none" />
          </button>
        </template>

        <!-- Arrow Tools (only if unlocked) -->
        <template v-if="arrowToolbarPosition.visible && activeArrow && !isArrowNodeEditing && !(lockToolbarPosition.visible && lockToolbarPosition.hasLocked)">
          <button
            type="button"
            @pointerdown.stop
            @mousedown.stop
            @click.stop="enterArrowNodeEditing(activeArrow)"
            class="px-2 py-1 bg-indigo-600/30 hover:bg-indigo-600/50 text-indigo-300 hover:text-white rounded-lg transition cursor-pointer flex items-center gap-1.5 text-xs font-medium whitespace-nowrap"
            title="Edit vector line nodes (or double-click to edit)"
          >
            <Waypoints class="w-3.5 h-3.5 text-indigo-400 pointer-events-none" />
            <span>Edit Nodes</span>
          </button>
          <div class="w-px h-4 bg-slate-700"></div>
          <button
            type="button"
            @pointerdown.stop
            @mousedown.stop
            @click.stop="duplicateArrow(activeArrow)"
            class="p-1 hover:bg-slate-800 text-slate-300 hover:text-white rounded-lg transition cursor-pointer"
            title="Duplicate (Ctrl+D)"
          >
            <Copy class="w-3.5 h-3.5 pointer-events-none" />
          </button>
          <button
            type="button"
            @pointerdown.stop
            @mousedown.stop
            @click.stop="toggleLockSelected"
            class="p-1 hover:bg-slate-800 rounded-lg transition cursor-pointer"
            :class="isObjectLocked ? 'text-amber-400 hover:text-amber-300' : 'text-slate-300 hover:text-white'"
            :title="isObjectLocked ? 'Unlock (Ctrl+L)' : 'Lock (Ctrl+L)'"
          >
            <component :is="isObjectLocked ? Lock : Unlock" class="w-3.5 h-3.5 pointer-events-none" />
          </button>
          <button
            type="button"
            @pointerdown.stop
            @mousedown.stop
            @click.stop="deleteSelected"
            class="p-1 hover:bg-rose-950/60 text-rose-400 hover:text-rose-300 rounded-lg transition cursor-pointer"
            title="Delete (Del)"
          >
            <Trash2 class="w-3.5 h-3.5 pointer-events-none" />
          </button>
        </template>
      </div>

      <!-- Arrow Node Editing Handles Overlay -->
      <div
        v-if="isArrowNodeEditing && editingArrow"
        class="absolute inset-0 pointer-events-none z-30"
      >
        <!-- Marquee Selection Rectangle -->
        <div
          v-if="isNodeMarqueeActive"
          class="absolute border border-indigo-400 bg-indigo-500/15 pointer-events-none z-40 rounded-sm"
          :style="{
            left: `${nodeMarqueeRect.x1}px`,
            top: `${nodeMarqueeRect.y1}px`,
            width: `${Math.max(0, nodeMarqueeRect.x2 - nodeMarqueeRect.x1)}px`,
            height: `${Math.max(0, nodeMarqueeRect.y2 - nodeMarqueeRect.y1)}px`
          }"
        ></div>

        <!-- Connecting guide lines, stroke double click zone, and live preview between nodes -->
        <svg class="w-full h-full absolute inset-0 pointer-events-none">
          <!-- Invisible wide hit-testing polyline: Drag to move whole arrow, double-click to add node -->
          <polyline
            :points="nodeScreenPolyline"
            fill="none"
            stroke="transparent"
            stroke-width="26"
            stroke-linecap="round"
            stroke-linejoin="round"
            class="pointer-events-auto cursor-grab active:cursor-grabbing"
            title="Drag line to move arrow, double-click to add node"
            @pointerdown="onStrokePointerDown"
            @dblclick="insertNodeOnArrowStroke"
          />
          <polyline
            :points="nodeScreenPolyline"
            fill="none"
            stroke="#6366f1"
            stroke-width="1.5"
            stroke-dasharray="4,4"
            class="opacity-70 pointer-events-none"
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
          @dblclick.stop.prevent="toggleNodeCorner(idx)"
          class="absolute -translate-x-1/2 -translate-y-1/2 pointer-events-auto cursor-grab active:cursor-grabbing group transition-transform"
          :style="{
            left: `${getNodeScreenPos(pt).x}px`,
            top: `${getNodeScreenPos(pt).y}px`
          }"
          :title="idx === 0 ? 'Start Node (Double-click: toggle corner)' : idx === editingArrowPoints.length - 1 ? 'End Node (Double-click: toggle corner)' : `Node ${idx + 1} (Double-click: toggle corner, Del: delete)`"
        >
          <!-- Corner or Smooth Handle Styling -->
          <div
            class="w-4 h-4 shadow-lg flex items-center justify-center transition-all group-hover:scale-125"
            :class="[
              editingArrowCorners.has(idx) ? 'rounded-none rotate-45 border-2' : 'rounded-full border-2',
              selectedNodeIndices.has(idx) ? 'ring-4 ring-amber-400 border-amber-300 scale-110' : '',
              idx === 0 ? 'bg-emerald-500 border-white text-white ring-2 ring-emerald-400/40' :
              idx === editingArrowPoints.length - 1 ? 'bg-sky-500 border-white text-white ring-2 ring-sky-400/40' :
              editingArrowCorners.has(idx) ? 'bg-amber-500 border-white text-white' :
              'bg-white border-indigo-600 ring-2 ring-indigo-400/30'
            ]"
          >
            <div
              v-if="idx !== 0 && idx !== editingArrowPoints.length - 1"
              class="w-1.5 h-1.5"
              :class="editingArrowCorners.has(idx) ? 'bg-white rounded-none' : 'rounded-full bg-indigo-600'"
            ></div>
          </div>
        </div>
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
      class="absolute bottom-4 sm:bottom-6 left-1/2 -translate-x-1/2 z-40 flex items-center gap-1.5 sm:gap-2 transition-all duration-300 w-max max-w-[96%] overflow-visible flex-nowrap"
      :class="[
        isStackedToolbar ? 'flex-col items-center' : 'flex-row',
        { 'opacity-40 pointer-events-none select-none': isCurrentUserMuted }
      ]"
    >
      <!-- AI Input -->
      <div
        class="flex flex-col gap-1.5 transition-opacity duration-200 shrink-0"
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
        <form v-else @submit.prevent="generateAIObject" class="flex items-center h-9 sm:h-10 bg-white/95 rounded-2xl shadow-xl border border-slate-200 p-1" :class="{ 'opacity-40 pointer-events-none cursor-not-allowed': isArrowNodeEditing }">
          <input :disabled="isArrowNodeEditing" v-model="aiPrompt" type="text" :placeholder="isStackedToolbar ? 'AI Vector icon, chart...' : 'AI Vector...'" class="flex-1 bg-transparent px-2 py-1 text-xs focus:outline-none text-slate-700 placeholder-slate-400 min-w-0" />
          <button type="submit" :disabled="!aiPrompt.trim() || isArrowNodeEditing" class="p-1 sm:p-1.5 rounded-xl bg-indigo-100 text-indigo-600 hover:bg-indigo-200 transition disabled:opacity-50 disabled:cursor-not-allowed shrink-0 cursor-pointer">
            <Sparkles class="w-3.5 h-3.5" />
          </button>
        </form>
      </div>

      <!-- Main Tools Bar -->
      <div
        class="h-9 sm:h-10 rounded-2xl border flex items-center transition-all duration-200 shrink-0"
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
            <button
              @click="toggleMode(true); isBrushMenuOpen = !isBrushMenuOpen"
              class="rounded-xl transition flex items-center gap-1 cursor-pointer"
              :class="[
                currentTool !== 'select' && currentTool !== 'text' && currentTool !== 'sticky' ? 'bg-indigo-100 text-indigo-600' : 'hover:bg-slate-100 text-slate-500',
                isNarrowToolbar ? 'p-1' : 'p-1.5',
                { 'opacity-40 pointer-events-none cursor-not-allowed': isArrowNodeEditing }
              ]"
              :disabled="isArrowNodeEditing"
              title="Draw & Shapes"
            >
              <Pencil class="w-3.5 h-3.5 sm:w-4 sm:h-4" />
            </button>
            
            <div v-if="isBrushMenuOpen && isDrawingMode" class="absolute bottom-full mb-3 left-1/2 -translate-x-1/2 bg-white rounded-xl shadow-2xl border border-slate-200 p-3 flex flex-col gap-3 min-w-[140px] z-50 animate-in fade-in zoom-in-95">
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
                <button @click="addShape('arrow')" class="p-1.5 hover:bg-slate-100 rounded text-slate-500 cursor-pointer" :class="{ 'bg-indigo-100 text-indigo-600': currentTool === 'arrow' }" title="Arrow Line (Arrow Brush)"><ArrowUpRight class="w-4 h-4" /></button>
              </div>
            </div>
          </div>
          
          <button
            @click="addText"
            class="rounded-xl transition cursor-pointer"
            :class="[
              currentTool === 'text' ? 'bg-indigo-100 text-indigo-600' : 'hover:bg-slate-100 text-slate-500',
              isNarrowToolbar ? 'p-1' : 'p-1.5',
              { 'opacity-40 pointer-events-none cursor-not-allowed': isArrowNodeEditing }
            ]"
            :disabled="isArrowNodeEditing"
            title="Add Text"
          >
            <Type class="w-3.5 h-3.5 sm:w-4 sm:h-4" />
          </button>

          <!-- Sticky Note Tool -->
          <div class="relative">
            <button
              @click="addSticky(); isStickyMenuOpen = !isStickyMenuOpen"
              class="rounded-xl transition flex items-center gap-1 cursor-pointer"
              :class="[
                currentTool === 'sticky' ? 'bg-indigo-100 text-indigo-600' : 'hover:bg-slate-100 text-slate-500',
                isNarrowToolbar ? 'p-1' : 'p-1.5',
                { 'opacity-40 pointer-events-none cursor-not-allowed': isArrowNodeEditing }
              ]"
              :disabled="isArrowNodeEditing"
              title="Sticky Note"
            >
              <StickyNote class="w-3.5 h-3.5 sm:w-4 sm:h-4" />
            </button>
            <div
              v-if="isStickyMenuOpen"
              class="absolute bottom-full mb-3 left-1/2 -translate-x-1/2 bg-white rounded-xl shadow-2xl border border-slate-200 p-2 flex items-center gap-1.5 z-50 min-w-max animate-in fade-in zoom-in-95"
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
                class="absolute bottom-full mb-3 left-1/2 -translate-x-1/2 bg-white rounded-xl shadow-2xl border border-slate-200 p-2 flex items-center gap-1.5 z-50 min-w-max animate-in fade-in zoom-in-95"
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
            <button @click="fileInputRef?.click()" :disabled="isArrowNodeEditing" class="rounded-xl hover:bg-slate-100 text-slate-500 transition cursor-pointer" :class="[isNarrowToolbar ? 'p-1' : 'p-1.5', { 'opacity-40 pointer-events-none cursor-not-allowed': isArrowNodeEditing }]" title="Add Image"><ImageIcon class="w-3.5 h-3.5 sm:w-4 sm:h-4" /></button>
            <button @click="undo" class="rounded-xl hover:bg-slate-100 text-slate-500 transition cursor-pointer" :class="[{'opacity-50 cursor-not-allowed': !canUndo}, isNarrowToolbar ? 'p-1' : 'p-1.5']" title="Undo (Ctrl+Z)" :disabled="!canUndo"><Undo2 class="w-3.5 h-3.5 sm:w-4 sm:h-4" /></button>
            <button @click="redo" class="rounded-xl hover:bg-slate-100 text-slate-500 transition cursor-pointer" :class="[{'opacity-50 cursor-not-allowed': !canRedo}, isNarrowToolbar ? 'p-1' : 'p-1.5']" title="Redo (Ctrl+Y / Ctrl+Shift+Z)" :disabled="!canRedo"><Redo2 class="w-3.5 h-3.5 sm:w-4 sm:h-4" /></button>
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
            <span><strong class="text-indigo-300">Group Isolation:</strong> Double-click any group or use <kbd class="px-1.5 py-0.5 bg-slate-800 border border-slate-700 rounded-md font-mono text-[10px] text-slate-200">Ctrl+Drag</kbd> to edit individual elements. Press <kbd class="px-1.5 py-0.5 bg-slate-800 border border-slate-700 rounded-md font-mono text-[10px] text-slate-200">ESC</kbd> or click "Exit" to return.</span>
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

    <!-- Modal: Confirm Make Private -->
    <div
      v-if="showPrivateConfirmModal"
      class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs"
      @click.self="showPrivateConfirmModal = false"
    >
      <div class="w-full max-w-sm bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl p-5 space-y-4 animate-in fade-in zoom-in-95">
        <div class="flex items-center gap-3 text-rose-400">
          <div class="p-2 rounded-xl bg-rose-500/10 border border-rose-500/20">
            <Lock class="w-5 h-5 text-rose-400" />
          </div>
          <h3 class="text-sm font-bold text-white">Make Board Private?</h3>
        </div>
        <p class="text-xs text-slate-300 leading-relaxed">
          Converting to private will immediately <strong>exit other room members</strong> from this whiteboard. They will no longer be able to view or edit it.
        </p>
        <div class="flex items-center justify-end gap-2 pt-2">
          <button
            @click="showPrivateConfirmModal = false"
            class="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium transition cursor-pointer"
          >
            Cancel
          </button>
          <button
            @click="handleConfirmMakePrivate"
            :disabled="isConvertingToPrivate"
            class="px-3 py-1.5 rounded-xl bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold transition cursor-pointer flex items-center gap-1.5 shadow"
          >
            <Loader2 v-if="isConvertingToPrivate" class="w-3.5 h-3.5 animate-spin" />
            <span>Confirm & Make Private</span>
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
