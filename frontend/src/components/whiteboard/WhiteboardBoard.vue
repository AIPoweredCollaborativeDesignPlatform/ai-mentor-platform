<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue';
import * as fabric from 'fabric';
import { getDownloadURL, ref as storageRef, uploadBytes } from 'firebase/storage';
import {
  Circle, Download, Eraser, Globe, Hand, Image as ImageIcon, Lock, Minus, MousePointer2, PenLine, Plus, Redo2,
  Send, Sparkles, Square, StickyNote as StickyIcon, Trash2, Type, Undo2, Wand2, X, ArrowUpToLine, ArrowDownToLine
} from 'lucide-vue-next';
import { storage } from '../../firebase/config';
import { useAuthStore } from '../../stores/auth';
import { useRoomStore } from '../../stores/room';
import { useRoomAi } from '../../composables/useRoomAi';
import { isOwnBoard } from '../../utils/chat';
import { generateSvgForWhiteboard, redrawSketchToSvg } from '../../services/ai';
import {
  STICKY_COLORS, StickyNote, assignBoardIdentity, createImage, createShape, createSticky, createText, enliven,
  isBoardObject, normalizeTextScale, resizeShape, serialize, svgToDataUrl, type BoardObject, type ShapeKind
} from '../../whiteboard/objects';
import { createBoardSync, type BoardSync, type ObjectDoc, type PresenceDoc, type RemoteChange } from '../../whiteboard/sync';
import { createHistory, type ObjectState } from '../../whiteboard/history';
import { downscaleImage, renderObjects, renderSnapshot, renderThumbnail } from '../../whiteboard/exporting';
import { convertLegacyBoard } from '../../whiteboard/legacy';

const props = defineProps<{ roomId: string; boardId: string }>();
const emit = defineEmits<{ (e: 'close'): void; (e: 'share', file: File): void }>();

const authStore = useAuthStore();
const roomStore = useRoomStore();
const { aiModules, aiName } = useRoomAi();

// ---------- board identity & privacy ----------
const board = computed(() => roomStore.currentRoom?.messages.find(m => m.id === props.boardId));
const isMine = computed(() => !board.value || isOwnBoard(board.value, authStore.uid));
const isPrivate = computed(() => board.value?.metadata?.isPrivate ?? true);
const creatorName = computed(() => board.value?.metadata?.creatorName || board.value?.senderName || authStore.displayName || 'My');
const showWhiteboardAi = computed(() => aiModules.value.enableWhiteboardAi);

// ---------- tools ----------
type Tool = 'select' | 'hand' | 'pen' | 'eraser' | 'sticky' | 'text' | 'rect' | 'ellipse';
const tool = ref<Tool>('select');
const COLORS = ['#0f172a', '#ef4444', '#f97316', '#eab308', '#22c55e', '#0ea5e9', '#6366f1', '#a855f7', '#ec4899', '#ffffff'];
const color = ref(COLORS[0]);
const penWidth = ref(4);
const shapeFilled = ref(false);
const stickyColor = ref(STICKY_COLORS[0]);
const zoomPct = ref(100);
const isLoading = ref(true);
const loadError = ref('');
const selection = shallowRef<BoardObject[]>([]);
const canUndo = ref(false);
const canRedo = ref(false);
const others = ref<PresenceDoc[]>([]);
const ai = reactive({ open: false, prompt: '', busy: false, error: '' });
const toast = ref('');
let toastTimer: ReturnType<typeof setTimeout> | undefined;
const showToast = (text: string) => {
  toast.value = text;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.value = ''), 2500);
};

const containerRef = ref<HTMLDivElement | null>(null);
const canvasEl = ref<HTMLCanvasElement | null>(null);
const overlayEl = ref<HTMLCanvasElement | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);

let canvas: fabric.Canvas | null = null;
let sync: BoardSync | null = null;
const objects = new Map<string, BoardObject>();
let maxZ = 0;
const nextZ = () => ++maxZ;

const CURSOR_COLORS = ['#ef4444', '#f97316', '#22c55e', '#0ea5e9', '#6366f1', '#a855f7', '#ec4899', '#14b8a6'];
const colorFor = (uid: string) => CURSOR_COLORS[[...uid].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % CURSOR_COLORS.length];

// ---------- serialization in scene coordinates ----------
/** Absolute state of an object, also when it is inside the active multi-selection. */
function stateOf(obj: BoardObject): { z: number; fabric: Record<string, any> } {
  const json = serialize(obj);
  if (obj.group) {
    const d = fabric.util.qrDecompose(obj.calcTransformMatrix());
    Object.assign(json, { left: d.translateX, top: d.translateY, angle: d.angle, scaleX: d.scaleX, scaleY: d.scaleY, skewX: d.skewX, skewY: 0 });
  }
  return { z: obj.z, fabric: json };
}

/** Objects restored from older data may use other origins; the board works in center origin everywhere. */
function centerOrigin(obj: fabric.FabricObject) {
  if (obj.originX === 'center' && obj.originY === 'center') return;
  const c = obj.getCenterPoint();
  obj.set({ originX: 'center', originY: 'center' });
  obj.setPositionByOrigin(c, 'center', 'center');
}

function prepare(obj: BoardObject) {
  centerOrigin(obj);
  obj.set({ lockScalingFlip: true, borderColor: '#6366f1', cornerColor: '#ffffff', cornerStrokeColor: '#6366f1', transparentCorners: false, cornerSize: 10 });
  if (obj instanceof fabric.Path) obj.set({ perPixelTargetFind: true });
  if (obj instanceof fabric.FabricImage) {
    const el = obj.getElement() as HTMLImageElement;
    if (el && !el.complete) el.addEventListener('load', () => canvas?.requestRenderAll(), { once: true });
  }
  maxZ = Math.max(maxZ, obj.z || 0);
  return obj;
}

/** Inserts keeping canvas order = z order. */
function insertByZ(obj: BoardObject) {
  if (!canvas) return;
  const list = canvas.getObjects() as BoardObject[];
  let index = list.findIndex(o => (o.z || 0) > (obj.z || 0));
  if (index === -1) index = list.length;
  canvas.insertAt(index, obj);
  objects.set(obj.id, obj);
}

function removeLocal(id: string) {
  const obj = objects.get(id);
  if (!obj || !canvas) return;
  if (canvas.getActiveObjects().includes(obj)) canvas.discardActiveObject();
  canvas.remove(obj);
  objects.delete(id);
}

// ---------- remote changes ----------
const PATCH_SKIP = new Set(['type', 'version', 'path', 'src', 'objects', 'filters', 'resizeFilter', 'clipPath', 'id']);
const pendingRemote = new Map<string, ObjectDoc | null>();

const isBusyLocally = (obj: BoardObject) =>
  Boolean(canvas && ((canvas as any)._currentTransform && canvas.getActiveObjects().includes(obj))) ||
  (obj instanceof fabric.IText && obj.isEditing);

function canPatch(obj: BoardObject, data: Record<string, any>) {
  if (obj.type !== data.type) return false;
  if (obj instanceof fabric.Path) return JSON.stringify(obj.path) === data.path;
  if (obj instanceof fabric.FabricImage) return obj.getSrc() === data.src;
  if (obj instanceof fabric.Group) return false;
  return true;
}

async function applyDoc(id: string, data: ObjectDoc | null) {
  if (!canvas) return;
  const existing = objects.get(id);
  if (!data) return removeLocal(id);
  if (existing && isBusyLocally(existing)) {
    pendingRemote.set(id, data);
    return;
  }
  const json = { ...data.fabric, z: data.z, id };
  if (existing && canPatch(existing, json)) {
    const patch = Object.fromEntries(Object.entries(json).filter(([k]) => !PATCH_SKIP.has(k)));
    existing.set(patch);
    if (existing instanceof fabric.Textbox) existing.initDimensions();
    existing.setCoords();
    if ((existing.z || 0) !== data.z) {
      canvas.remove(existing);
      insertByZ(existing);
    }
    maxZ = Math.max(maxZ, data.z);
    return;
  }
  const obj = await enliven(json);
  if (!obj || !canvas) return;
  prepare(obj);
  if (objects.has(id)) removeLocal(id);
  insertByZ(obj);
}

async function applyRemote(changes: RemoteChange[]) {
  for (const c of changes) await applyDoc(c.id, c.type === 'removed' ? null : c.data!);
  canvas?.requestRenderAll();
}

function flushPendingRemote() {
  if (!pendingRemote.size) return;
  const entries = [...pendingRemote.entries()];
  pendingRemote.clear();
  entries.forEach(([id, data]) => applyDoc(id, data));
  canvas?.requestRenderAll();
}

// ---------- local writes ----------
let created = false;
async function ensureBoard() {
  if (created || board.value) return (created = true);
  await roomStore.createBoard(props.boardId);
  created = true;
}

async function persist(objs: BoardObject[], deletes: string[] = []) {
  if (!sync) return;
  await ensureBoard();
  await sync.commit(objs.map(o => ({ id: o.id, ...stateOf(o) })), deletes);
  scheduleThumbnail();
}

const snapshotStates = (ids: string[]) => new Map<string, ObjectState>(ids.map(id => [id, objects.has(id) ? stateOf(objects.get(id)!) : null]));

const history = createHistory(async states => {
  canvas?.discardActiveObject();
  const writes: BoardObject[] = [];
  const deletes: string[] = [];
  for (const [id, state] of states) {
    if (!state) {
      removeLocal(id);
      deletes.push(id);
      continue;
    }
    await applyDoc(id, { ...state, updatedBy: authStore.uid, updatedAt: Date.now() });
    const obj = objects.get(id);
    if (obj) writes.push(obj);
  }
  canvas?.requestRenderAll();
  await persist(writes, deletes);
  refreshHistoryFlags();
});
const refreshHistoryFlags = () => {
  canUndo.value = history.canUndo();
  canRedo.value = history.canRedo();
};
const record = (before: Map<string, ObjectState>, ids: string[]) => {
  history.record(before, snapshotStates(ids));
  refreshHistoryFlags();
};

/** Adds new objects (already given ids) as one undoable step. */
async function addObjects(list: BoardObject[], { select = true } = {}) {
  if (!canvas) return;
  const before = new Map<string, ObjectState>(list.map(o => [o.id, null]));
  list.forEach(o => insertByZ(prepare(o)));
  record(before, list.map(o => o.id));
  if (select && list.length === 1) canvas.setActiveObject(list[0]);
  canvas.requestRenderAll();
  await persist(list);
}

async function deleteObjects(list: BoardObject[]) {
  if (!canvas || !list.length) return;
  const ids = list.map(o => o.id);
  const before = snapshotStates(ids);
  canvas.discardActiveObject();
  ids.forEach(removeLocal);
  record(before, ids);
  canvas.requestRenderAll();
  await persist([], ids);
}

// ---------- thumbnail & AI snapshot ----------
let thumbTimer: ReturnType<typeof setTimeout> | undefined;
let thumbDirty = false;
const THUMB_DEBOUNCE_MS = 2500;

function scheduleThumbnail() {
  thumbDirty = true;
  clearTimeout(thumbTimer);
  thumbTimer = setTimeout(writeThumbnail, THUMB_DEBOUNCE_MS);
}

async function writeThumbnail() {
  clearTimeout(thumbTimer);
  if (!thumbDirty || !canvas || !board.value) return;
  thumbDirty = false;
  const list = canvas.getObjects();
  try {
    const thumb = await renderThumbnail(list);
    await roomStore.updateBoardThumbnail(props.boardId, thumb);
    if (!isPrivate.value && list.length) {
      const snap = await renderObjects(list, { maxW: 1024, maxH: 768, format: 'jpeg' });
      roomStore.recordWhiteboardSnapshotMemory(snap, props.boardId);
    }
  } catch (e) {
    console.warn('[whiteboard] thumbnail failed', e);
  }
}

// ---------- canvas setup ----------
let resizeObserver: ResizeObserver | null = null;

function setupCanvas() {
  const el = canvasEl.value!;
  const box = containerRef.value!.getBoundingClientRect();
  canvas = new fabric.Canvas(el, {
    width: box.width,
    height: box.height,
    preserveObjectStacking: true,
    selectionColor: 'rgba(99,102,241,0.08)',
    selectionBorderColor: '#6366f1',
    selectionLineWidth: 1,
    stopContextMenu: true,
    fireMiddleClick: true
  });
  canvas.freeDrawingBrush = new fabric.PencilBrush(canvas);
  if (import.meta.env.DEV) (window as any).__wb = { canvas, objects };
  applyTool();

  resizeObserver = new ResizeObserver(() => {
    const r = containerRef.value?.getBoundingClientRect();
    if (!r || !canvas) return;
    canvas.setDimensions({ width: r.width, height: r.height });
    sizeOverlay();
    drawOverlay();
  });
  resizeObserver.observe(containerRef.value!);
  sizeOverlay();

  canvas.on('selection:created', updateSelection);
  canvas.on('selection:updated', updateSelection);
  canvas.on('selection:cleared', updateSelection);
  canvas.on('mouse:down', onMouseDown);
  canvas.on('mouse:move', onMouseMove);
  canvas.on('mouse:up', onMouseUp);
  canvas.on('mouse:wheel', onWheel);
  canvas.on('path:created', onPathCreated as any);
  canvas.on('before:transform', onBeforeTransform);
  canvas.on('object:moving', onLiveTransform);
  canvas.on('object:scaling', onLiveTransform);
  canvas.on('object:rotating', onLiveTransform);
  canvas.on('object:modified', onModified);
  canvas.on('text:editing:entered', onEditingEntered as any);
  canvas.on('text:editing:exited', onEditingExited as any);
  canvas.on('after:render', drawOverlay);
}

function sizeOverlay() {
  const r = containerRef.value?.getBoundingClientRect();
  const o = overlayEl.value;
  if (!r || !o) return;
  const dpr = window.devicePixelRatio || 1;
  o.width = r.width * dpr;
  o.height = r.height * dpr;
  o.style.width = `${r.width}px`;
  o.style.height = `${r.height}px`;
}

function applyTool() {
  if (!canvas) return;
  const t = tool.value;
  canvas.isDrawingMode = t === 'pen';
  canvas.selection = t === 'select';
  canvas.skipTargetFind = t !== 'select';
  canvas.defaultCursor = t === 'hand' ? 'grab' : t === 'select' ? 'default' : 'crosshair';
  canvas.hoverCursor = t === 'select' ? 'move' : canvas.defaultCursor;
  if (t !== 'select') canvas.discardActiveObject();
  const brush = canvas.freeDrawingBrush as fabric.PencilBrush;
  brush.color = color.value === '#ffffff' ? '#0f172a' : color.value;
  brush.width = penWidth.value;
  canvas.requestRenderAll();
}
watch([tool, color, penWidth], applyTool);

function updateSelection() {
  selection.value = (canvas?.getActiveObjects() || []).filter(isBoardObject);
}

// ---------- pointer handling ----------
let panning: { x: number; y: number } | null = null;
let spaceDown = false;
let drawingShape: { obj: BoardObject; start: fabric.Point } | null = null;
let erasing: { ids: Set<string>; before: Map<string, ObjectState> } | null = null;
let transformBefore: Map<string, ObjectState> | null = null;
let liveWriteAt = 0;
// A new note/text starts editing only after the click's mouseup, which would otherwise end the editing
let pendingEdit: { obj: BoardObject; selectAll: boolean } | null = null;

const scenePoint = (e: fabric.TPointerEvent) => canvas!.getScenePoint(e);
const clientXY = (e: fabric.TPointerEvent) => ('touches' in e && e.touches[0] ? e.touches[0] : (e as MouseEvent));

function onMouseDown(opt: fabric.TPointerEventInfo) {
  if (!canvas) return;
  const e = opt.e as MouseEvent;
  if (tool.value === 'hand' || spaceDown || e.button === 1) {
    const p = clientXY(opt.e);
    panning = { x: p.clientX, y: p.clientY };
    canvas.setCursor('grabbing');
    return;
  }
  const p = scenePoint(opt.e);
  if (tool.value === 'rect' || tool.value === 'ellipse') {
    const obj = createShape(tool.value as ShapeKind, p, color.value, shapeFilled.value ? color.value : 'transparent', nextZ());
    prepare(obj);
    obj.set({ selectable: false, evented: false });
    canvas.add(obj);
    drawingShape = { obj, start: p };
  } else if (tool.value === 'sticky') {
    const note = createSticky(p, stickyColor.value, nextZ());
    tool.value = 'select';
    addObjects([note]);
    pendingEdit = { obj: note, selectAll: false };
  } else if (tool.value === 'text') {
    const text = createText(p, color.value === '#ffffff' ? '#0f172a' : color.value, nextZ());
    tool.value = 'select';
    addObjects([text]);
    pendingEdit = { obj: text, selectAll: true };
  } else if (tool.value === 'eraser') {
    erasing = { ids: new Set(), before: new Map() };
    eraseAt(opt);
  }
}

function onMouseMove(opt: fabric.TPointerEventInfo) {
  if (!canvas) return;
  const p = scenePoint(opt.e);
  if (panning) {
    const c = clientXY(opt.e);
    canvas.relativePan(new fabric.Point(c.clientX - panning.x, c.clientY - panning.y));
    panning = { x: c.clientX, y: c.clientY };
    return;
  }
  if (drawingShape) {
    resizeShape(drawingShape.obj, drawingShape.start, p, (opt.e as MouseEvent).shiftKey);
    canvas.requestRenderAll();
  } else if (erasing) {
    eraseAt(opt);
  }
  // Cursor and the stroke being drawn are broadcast to everyone on the board
  const brush = canvas.freeDrawingBrush as any;
  const drawing = canvas.isDrawingMode && brush?._points?.length > 1;
  sync?.updatePresence({
    x: p.x,
    y: p.y,
    live: drawing ? { points: flattenPoints(brush._points), color: brush.color, width: brush.width } : null
  });
}

function onMouseUp() {
  if (!canvas) return;
  if (pendingEdit) {
    const { obj, selectAll } = pendingEdit;
    pendingEdit = null;
    setTimeout(() => startEditing(obj, selectAll));
  }
  if (panning) {
    panning = null;
    canvas.setCursor(tool.value === 'hand' ? 'grab' : 'default');
    return;
  }
  if (drawingShape) {
    const { obj, start } = drawingShape;
    drawingShape = null;
    canvas.remove(obj);
    if (obj.width * obj.scaleX < 6 && obj.height * obj.scaleY < 6) resizeShape(obj, new fabric.Point(start.x - 60, start.y - 45), new fabric.Point(start.x + 60, start.y + 45), false);
    obj.set({ selectable: true, evented: true });
    tool.value = 'select';
    addObjects([obj]);
  }
  if (erasing) {
    const { ids, before } = erasing;
    erasing = null;
    if (ids.size) {
      history.record(before, new Map([...ids].map(id => [id, null])));
      refreshHistoryFlags();
      persist([], [...ids]);
    }
  }
  flushPendingRemote();
}

function eraseAt(opt: fabric.TPointerEventInfo) {
  if (!canvas || !erasing) return;
  const p = scenePoint(opt.e);
  const vp = canvas.getViewportPoint(opt.e);
  const objs = [...canvas.getObjects()].reverse() as BoardObject[];
  for (const obj of objs) {
    if (!isBoardObject(obj) || erasing.ids.has(obj.id)) continue;
    if (!obj.containsPoint(p)) continue;
    if (obj instanceof fabric.Path && canvas.isTargetTransparent(obj, vp.x, vp.y)) continue;
    erasing.before.set(obj.id, stateOf(obj));
    erasing.ids.add(obj.id);
    removeLocal(obj.id);
    canvas.requestRenderAll();
    break;
  }
}

function flattenPoints(points: fabric.Point[]) {
  const step = Math.max(1, Math.ceil(points.length / 400));
  const out: number[] = [];
  for (let i = 0; i < points.length; i += step) out.push(Math.round(points[i].x * 10) / 10, Math.round(points[i].y * 10) / 10);
  return out;
}

function onPathCreated({ path }: { path: fabric.Path }) {
  if (!canvas) return;
  canvas.remove(path);
  const obj = assignBoardIdentity(path, nextZ());
  addObjects([obj], { select: false });
  sync?.updatePresence({ live: null }, true);
}

function onWheel(opt: fabric.TPointerEventInfo<WheelEvent>) {
  if (!canvas) return;
  const e = opt.e;
  e.preventDefault();
  e.stopPropagation();
  if (e.ctrlKey || e.metaKey) {
    const zoom = Math.min(8, Math.max(0.1, canvas.getZoom() * 0.999 ** e.deltaY));
    canvas.zoomToPoint(canvas.getViewportPoint(e), zoom);
    zoomPct.value = Math.round(zoom * 100);
  } else {
    canvas.relativePan(new fabric.Point(-e.deltaX, -e.deltaY));
  }
}

function zoomBy(factor: number) {
  if (!canvas) return;
  const zoom = Math.min(8, Math.max(0.1, canvas.getZoom() * factor));
  canvas.zoomToPoint(new fabric.Point(canvas.width / 2, canvas.height / 2), zoom);
  zoomPct.value = Math.round(zoom * 100);
}

function zoomToFit() {
  if (!canvas) return;
  const list = canvas.getObjects();
  if (!list.length) {
    canvas.setViewportTransform([1, 0, 0, 1, 0, 0]);
    zoomPct.value = 100;
    return;
  }
  const rects = list.map(o => o.getBoundingRect());
  // getBoundingRect is in scene coordinates in Fabric v7
  const minX = Math.min(...rects.map(r => r.left)), minY = Math.min(...rects.map(r => r.top));
  const maxX = Math.max(...rects.map(r => r.left + r.width)), maxY = Math.max(...rects.map(r => r.top + r.height));
  const pad = 60;
  const zoom = Math.min(2, Math.max(0.1, Math.min(canvas.width / (maxX - minX + pad * 2), canvas.height / (maxY - minY + pad * 2))));
  canvas.setViewportTransform([zoom, 0, 0, zoom, canvas.width / 2 - ((minX + maxX) / 2) * zoom, canvas.height / 2 - ((minY + maxY) / 2) * zoom]);
  zoomPct.value = Math.round(zoom * 100);
}

const viewportCenter = () => {
  const inv = fabric.util.invertTransform(canvas!.viewportTransform);
  return new fabric.Point(canvas!.width / 2, canvas!.height / 2).transform(inv);
};

// ---------- transforms & text editing ----------
function onBeforeTransform(opt: { transform: fabric.Transform }) {
  const t = opt.transform.target;
  const list = (t instanceof fabric.ActiveSelection ? t.getObjects() : [t]).filter(isBoardObject);
  transformBefore = snapshotStates(list.map(o => o.id));
  sync?.updatePresence({ editing: list.map(o => o.id) });
}

function onLiveTransform(opt: { target: fabric.FabricObject }) {
  const t = opt.target;
  if (!isBoardObject(t) || !sync || Date.now() - liveWriteAt < 120) return;
  liveWriteAt = Date.now();
  sync.writeObject(t.id, t.z, stateOf(t).fabric);
}

function onModified(opt: { target: fabric.FabricObject }) {
  const t = opt.target;
  const list = (t instanceof fabric.ActiveSelection ? t.getObjects() : [t]).filter(isBoardObject);
  if (!(t instanceof fabric.ActiveSelection)) normalizeTextScale(t);
  const before = transformBefore || snapshotStates(list.map(o => o.id));
  transformBefore = null;
  record(before, list.map(o => o.id));
  persist(list);
  sync?.updatePresence({ editing: [] });
  canvas?.requestRenderAll();
}

let editingBefore: Map<string, ObjectState> | null = null;
function startEditing(obj: BoardObject, selectAll = false) {
  if (!canvas || !(obj instanceof fabric.IText)) return;
  canvas.setActiveObject(obj);
  obj.enterEditing();
  if (selectAll) obj.selectAll();
  canvas.requestRenderAll();
}

function onEditingEntered({ target }: { target: BoardObject }) {
  editingBefore = snapshotStates([target.id]);
  sync?.updatePresence({ editing: [target.id] });
}

function onEditingExited({ target }: { target: BoardObject }) {
  const before = editingBefore;
  editingBefore = null;
  sync?.updatePresence({ editing: [] });
  // An empty plain text box is removed; an empty sticky note stays (it is still a card)
  if (!(target instanceof StickyNote) && !(target as any).text?.trim()) {
    deleteObjects([target]);
    return;
  }
  if (before) record(before, [target.id]);
  persist([target]);
  flushPendingRemote();
}

// ---------- selection actions ----------
const selectionKinds = computed(() => {
  const s = selection.value;
  return {
    sticky: s.length > 0 && s.every(o => o instanceof StickyNote),
    any: s.length > 0,
    sketchable: s.some(o => !(o instanceof fabric.Textbox))
  };
});

async function mutateSelection(fn: (o: BoardObject) => void) {
  const list = selection.value;
  if (!list.length || !canvas) return;
  const ids = list.map(o => o.id);
  const before = snapshotStates(ids);
  list.forEach(fn);
  canvas.requestRenderAll();
  record(before, ids);
  await persist(list);
}

const applyColor = (c: string) => {
  color.value = c;
  mutateSelection(o => {
    if (o instanceof StickyNote) return;
    if (o instanceof fabric.Textbox) o.set('fill', c);
    else if (o instanceof fabric.Path) o.set('stroke', c);
    else if (o instanceof fabric.Rect || o instanceof fabric.Ellipse) o.set({ stroke: c, ...(o.fill && o.fill !== 'transparent' ? { fill: c } : {}) });
  });
};
const applyStickyColor = (c: string) => {
  stickyColor.value = c;
  mutateSelection(o => o instanceof StickyNote && o.set('backgroundColor', c));
};
const toggleFill = () => {
  shapeFilled.value = !shapeFilled.value;
  mutateSelection(o => {
    if (o instanceof fabric.Rect || o instanceof fabric.Ellipse) o.set('fill', shapeFilled.value ? o.stroke : 'transparent');
  });
};
const bringToFront = () => mutateSelection(o => (o.z = nextZ())).then(restack);
const sendToBack = () => {
  const minZ = Math.min(0, ...[...objects.values()].map(o => o.z || 0));
  let z = minZ - selection.value.length;
  return mutateSelection(o => (o.z = z++)).then(restack);
};
function restack() {
  if (!canvas) return;
  const sorted = [...canvas.getObjects()].sort((a: any, b: any) => (a.z || 0) - (b.z || 0));
  sorted.forEach((o, i) => canvas!.moveObjectTo(o, i));
  canvas.requestRenderAll();
}
const deleteSelection = () => deleteObjects(selection.value);

// ---------- images ----------
async function insertImageFile(file: File, at?: fabric.Point) {
  if (!file.type.startsWith('image/')) return;
  showToast('Uploading image...');
  try {
    await ensureBoard();
    const blob = await downscaleImage(file);
    const ext = blob.type === 'image/png' ? 'png' : 'jpg';
    const path = `rooms/${props.roomId}/boards/${props.boardId}/${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}.${ext}`;
    const snap = await uploadBytes(storageRef(storage, path), blob, { contentType: blob.type });
    const url = await getDownloadURL(snap.ref);
    const img = await createImage(url, at || viewportCenter(), 480, nextZ());
    await addObjects([img]);
    showToast('Image added');
  } catch (e) {
    console.error('[whiteboard] image upload failed', e);
    showToast('Image upload failed');
  }
}
const onFilePicked = (e: Event) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (file) insertImageFile(file);
  input.value = '';
};
const onPaste = (e: ClipboardEvent) => {
  if (isTyping(e)) return;
  const file = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith('image/'))?.getAsFile();
  if (file) {
    e.preventDefault();
    insertImageFile(file);
  }
};
const onDrop = (e: DragEvent) => {
  const file = e.dataTransfer?.files?.[0];
  if (!file || !canvas) return;
  e.preventDefault();
  insertImageFile(file, canvas.getScenePoint(e as any));
};

// ---------- AI ----------
/** Gives an SVG intrinsic width/height (from its viewBox) so it loads as an image with a real size. */
function sizedSvg(svg: string, fallback = 512) {
  const open = svg.match(/<svg\b[^>]*>/i)?.[0];
  if (!open) return svg;
  if (/\swidth=/.test(open) && /\sheight=/.test(open)) return svg;
  const vb = open.match(/viewBox=["']([^"']+)["']/i)?.[1]?.split(/[\s,]+/).map(Number);
  const [w, h] = vb && vb.length === 4 ? [vb[2], vb[3]] : [fallback, fallback];
  return svg.replace(open, open.replace(/<svg\b/i, `<svg width="${w}" height="${h}"`));
}

async function svgObject(svg: string, center: fabric.Point, maxSide: number) {
  const img = await createImage(svgToDataUrl(sizedSvg(svg)), center, maxSide, nextZ());
  return img;
}

async function generateSvg() {
  const prompt = ai.prompt.trim();
  if (!prompt || ai.busy) return;
  ai.busy = true;
  ai.error = '';
  try {
    const svg = await generateSvgForWhiteboard(prompt);
    await addObjects([await svgObject(svg, viewportCenter(), 360)]);
    ai.prompt = '';
    ai.open = false;
  } catch (e: any) {
    ai.error = e?.title || e?.message || 'Generation failed';
  } finally {
    ai.busy = false;
  }
}

async function sketchToSvg() {
  const list = selection.value.filter(o => !(o instanceof fabric.Textbox));
  if (!list.length || ai.busy || !canvas) return;
  ai.busy = true;
  showToast(`${aiName.value} is redrawing your sketch...`);
  try {
    canvas.discardActiveObject();
    const png = await renderObjects(list, { maxW: 1024, maxH: 1024, format: 'png', background: '#ffffff' });
    const rects = list.map(o => o.getBoundingRect());
    const minX = Math.min(...rects.map(r => r.left)), minY = Math.min(...rects.map(r => r.top));
    const maxX = Math.max(...rects.map(r => r.left + r.width)), maxY = Math.max(...rects.map(r => r.top + r.height));
    const svg = await redrawSketchToSvg(png);
    const img = await svgObject(svg, new fabric.Point((minX + maxX) / 2, (minY + maxY) / 2), Math.max(maxX - minX, maxY - minY, 120));

    // Replace the strokes with the vector drawing as one undoable step
    const ids = [...list.map(o => o.id), img.id];
    const before = snapshotStates(ids);
    list.forEach(o => removeLocal(o.id));
    insertByZ(prepare(img));
    record(before, ids);
    canvas.setActiveObject(img);
    canvas.requestRenderAll();
    await persist([img], list.map(o => o.id));
    showToast('Sketch converted to SVG');
  } catch (e: any) {
    showToast(e?.title || 'Sketch conversion failed');
  } finally {
    ai.busy = false;
  }
}

// ---------- sharing ----------
async function shareToChat() {
  if (!canvas) return;
  await ensureBoard();
  const thumb = await renderThumbnail(canvas.getObjects()).catch(() => '');
  await roomStore.setBoardPrivacy(props.boardId, false, thumb);
  showToast('Shared to chat — everyone can now edit this board');
}
async function makePrivate() {
  if (!window.confirm('Make this whiteboard private? Others will be removed from it and its card will be greyed out.')) return;
  await roomStore.setBoardPrivacy(props.boardId, true);
  showToast('Board is now private');
}
async function sendAsImage() {
  if (!canvas?.getObjects().length) return showToast('The board is empty');
  const url = await renderSnapshot(canvas.getObjects());
  const blob = await (await fetch(url)).blob();
  emit('share', new File([blob], `whiteboard_${Date.now()}.png`, { type: 'image/png' }));
}
async function downloadPng() {
  if (!canvas?.getObjects().length) return showToast('The board is empty');
  const a = document.createElement('a');
  a.href = await renderSnapshot(canvas.getObjects());
  a.download = `whiteboard_${Date.now()}.png`;
  a.click();
}

// ---------- keyboard ----------
const isTyping = (e: Event) => {
  const el = e.target as HTMLElement | null;
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return true;
  return canvas?.getActiveObjects().some(o => o instanceof fabric.IText && o.isEditing) ?? false;
};
const SHORTCUTS: Record<string, Tool> = { v: 'select', h: 'hand', p: 'pen', e: 'eraser', n: 'sticky', t: 'text', r: 'rect', o: 'ellipse' };

function onKeyDown(e: KeyboardEvent) {
  if (isTyping(e)) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    (e.shiftKey ? history.redo() : history.undo()).then(refreshHistoryFlags);
  } else if (mod && e.key.toLowerCase() === 'y') {
    e.preventDefault();
    history.redo().then(refreshHistoryFlags);
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    if (selection.value.length) {
      e.preventDefault();
      deleteSelection();
    }
  } else if (e.key === ' ') {
    if (!spaceDown) {
      spaceDown = true;
      canvas?.setCursor('grab');
    }
    e.preventDefault();
  } else if (e.key === 'Escape') {
    tool.value = 'select';
    canvas?.discardActiveObject();
    canvas?.requestRenderAll();
  } else if (!mod && SHORTCUTS[e.key.toLowerCase()]) {
    tool.value = SHORTCUTS[e.key.toLowerCase()];
  }
}
const onKeyUp = (e: KeyboardEvent) => {
  if (e.key === ' ') spaceDown = false;
};

// ---------- presence overlay ----------
const viewTick = ref(0); // re-evaluates cursor positions after pan/zoom
const cursorStyle = (p: PresenceDoc) => {
  void viewTick.value;
  if (!canvas || p.x == null || p.y == null) return { display: 'none' };
  const pt = new fabric.Point(p.x, p.y).transform(canvas.viewportTransform);
  return { transform: `translate(${pt.x}px, ${pt.y}px)` };
};

function drawOverlay() {
  viewTick.value++;
  const o = overlayEl.value;
  if (!o || !canvas) return;
  const ctx = o.getContext('2d')!;
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, o.width, o.height);
  const v = canvas.viewportTransform;
  ctx.setTransform(v[0] * dpr, v[1] * dpr, v[2] * dpr, v[3] * dpr, v[4] * dpr, v[5] * dpr);
  for (const p of others.value) {
    const live = p.live;
    if (!live || live.points.length < 4) continue;
    ctx.strokeStyle = live.color;
    ctx.lineWidth = live.width;
    ctx.lineCap = ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(live.points[0], live.points[1]);
    for (let i = 2; i < live.points.length; i += 2) ctx.lineTo(live.points[i], live.points[i + 1]);
    ctx.stroke();
  }
}
watch(others, drawOverlay);

const editingBy = computed(() => {
  const map = new Map<string, PresenceDoc>();
  others.value.forEach(p => p.editing?.forEach(id => map.set(id, p)));
  return map;
});

// ---------- lifecycle ----------
let heartbeat: ReturnType<typeof setInterval> | undefined;

async function load() {
  if (!canvas) return;
  // Board access rules read the card, so a new board's card must exist before listening
  await ensureBoard();
  sync = createBoardSync(props.roomId, props.boardId, authStore.uid);
  sync.listenObjects(async docs => {
    const entries = [...docs.entries()].sort((a, b) => a[1].z - b[1].z);
    for (const [id, data] of entries) await applyDoc(id, data);

    // First open of a v1 board: convert it once (deterministic ids make concurrent conversions harmless)
    const legacyJson = board.value?.metadata?.whiteboardJson;
    if (!entries.length && legacyJson && board.value?.metadata?.boardV !== 2) {
      const converted = await convertLegacyBoard(legacyJson);
      const writes = converted.map((c, i) => ({ ...c, id: `legacy_${i}` }));
      for (const w of writes) await applyDoc(w.id, { z: w.z, fabric: w.fabric, updatedBy: authStore.uid, updatedAt: Date.now() });
      await sync!.commit(writes);
      await roomStore.markBoardMigrated(props.boardId);
    }
    isLoading.value = false;
    canvas?.requestRenderAll();
    if (objects.size) zoomToFit();
  }, applyRemote, err => {
    isLoading.value = false;
    loadError.value = (err as any)?.code === 'permission-denied' ? 'You no longer have access to this whiteboard.' : 'Could not load the whiteboard.';
    console.warn('[whiteboard] listener error', err);
  });
  sync.startPresence({ uid: authStore.uid, name: authStore.displayName || 'Participant', color: colorFor(authStore.uid) }, list => (others.value = list));
  heartbeat = setInterval(() => sync?.updatePresence({}), 5000);
}

onMounted(async () => {
  await nextTick();
  setupCanvas();
  await load();
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('paste', onPaste);
});

onBeforeUnmount(async () => {
  window.removeEventListener('keydown', onKeyDown);
  window.removeEventListener('keyup', onKeyUp);
  window.removeEventListener('paste', onPaste);
  clearInterval(heartbeat);
  resizeObserver?.disconnect();
  const isEmptyDraft = !objects.size && isMine.value && isPrivate.value && !board.value?.metadata?.wasPublished && !loadError.value;
  if (isEmptyDraft) await roomStore.deleteEmptyDraft(props.boardId);
  else await writeThumbnail();
  await sync?.stop();
  canvas?.dispose();
  canvas = null;
});

const handleCloseRequest = async () => {
  await writeThumbnail();
  emit('close');
};

defineExpose({ flush: writeThumbnail, handleCloseRequest });

const tools: { id: Tool; icon: any; label: string; key: string }[] = [
  { id: 'select', icon: MousePointer2, label: 'Select', key: 'V' },
  { id: 'hand', icon: Hand, label: 'Pan', key: 'H' },
  { id: 'pen', icon: PenLine, label: 'Pen', key: 'P' },
  { id: 'eraser', icon: Eraser, label: 'Eraser', key: 'E' },
  { id: 'sticky', icon: StickyIcon, label: 'Sticky note', key: 'N' },
  { id: 'text', icon: Type, label: 'Text', key: 'T' },
  { id: 'rect', icon: Square, label: 'Rectangle', key: 'R' },
  { id: 'ellipse', icon: Circle, label: 'Ellipse', key: 'O' }
];
</script>

<template>
  <div class="h-full w-full flex flex-col bg-slate-900 text-slate-100 select-none">
    <!-- Header -->
    <div class="h-12 shrink-0 flex items-center gap-2 px-3 border-b border-slate-800 bg-slate-950">
      <span class="text-sm font-semibold truncate">{{ creatorName }}'s Board</span>
      <span
        class="px-2 py-0.5 rounded-full text-[10px] font-semibold flex items-center gap-1 shrink-0"
        :class="isPrivate ? 'bg-slate-800 text-slate-400' : 'bg-emerald-500/15 text-emerald-400'"
      >
        <component :is="isPrivate ? Lock : Globe" class="w-3 h-3" />{{ isPrivate ? 'Private' : 'Live' }}
      </span>
      <div class="flex -space-x-1.5 ml-1">
        <span
          v-for="p in others"
          :key="p.uid"
          class="w-6 h-6 rounded-full border-2 border-slate-950 text-[10px] font-bold flex items-center justify-center text-white"
          :style="{ background: p.color }"
          :title="p.name"
        >{{ p.name.slice(0, 1).toUpperCase() }}</span>
      </div>
      <div class="flex-1"></div>
      <button v-if="isMine && isPrivate" class="wb-btn bg-emerald-600 hover:bg-emerald-500 text-white" @click="shareToChat" title="Share this board to the chat so everyone can edit it">
        <Globe class="w-3.5 h-3.5" /> Share
      </button>
      <button v-if="isMine && !isPrivate" class="wb-btn" @click="makePrivate" title="Make private (others are removed)">
        <Lock class="w-3.5 h-3.5" /> Make Private
      </button>
      <button class="wb-btn" @click="sendAsImage" title="Send the board as an image to the chat"><Send class="w-3.5 h-3.5" /></button>
      <button class="wb-btn" @click="downloadPng" title="Download PNG"><Download class="w-3.5 h-3.5" /></button>
      <button class="wb-btn" @click="handleCloseRequest" title="Close"><X class="w-4 h-4" /></button>
    </div>

    <div class="flex-1 relative overflow-hidden">
      <!-- Canvas -->
      <div
        ref="containerRef"
        class="absolute inset-0 wb-grid"
        @dragover.prevent
        @drop="onDrop"
      >
        <canvas ref="canvasEl"></canvas>
        <canvas ref="overlayEl" class="absolute inset-0 pointer-events-none"></canvas>

        <!-- Remote cursors -->
        <template v-for="p in others" :key="p.uid">
          <div class="absolute left-0 top-0 pointer-events-none z-10 transition-transform duration-75" :style="cursorStyle(p)">
            <svg width="18" height="18" viewBox="0 0 24 24" :fill="p.color" stroke="white" stroke-width="1.5"><path d="M4 2l16 9-7 2-3 7z" /></svg>
            <span class="ml-3 -mt-1 inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold text-white whitespace-nowrap" :style="{ background: p.color }">{{ p.name }}</span>
          </div>
        </template>
      </div>

      <div v-if="isLoading" class="absolute inset-0 flex items-center justify-center bg-slate-900/60 z-20">
        <div class="w-8 h-8 border-2 border-indigo-400 border-t-transparent rounded-full animate-spin"></div>
      </div>
      <div v-if="loadError" class="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-slate-900/90 z-30 text-sm text-slate-300">
        <Lock class="w-6 h-6 text-slate-500" />{{ loadError }}
        <button class="wb-btn" @click="emit('close')">Close</button>
      </div>

      <!-- Tool rail -->
      <div class="absolute left-3 top-1/2 -translate-y-1/2 z-20 flex flex-col gap-1 p-1.5 rounded-2xl bg-slate-950/90 border border-slate-800 shadow-xl backdrop-blur">
        <button
          v-for="t in tools"
          :key="t.id"
          class="wb-tool"
          :class="{ 'wb-tool-active': tool === t.id }"
          :title="`${t.label} (${t.key})`"
          @click="tool = t.id"
        >
          <component :is="t.icon" class="w-4 h-4" />
        </button>
        <button class="wb-tool" title="Insert image (or paste / drop)" @click="fileInput?.click()"><ImageIcon class="w-4 h-4" /></button>
        <button v-if="showWhiteboardAi" class="wb-tool text-fuchsia-300" :class="{ 'wb-tool-active': ai.open }" :title="`Generate with ${aiName}`" @click="ai.open = !ai.open">
          <Sparkles class="w-4 h-4" />
        </button>
        <div class="h-px bg-slate-800 my-1"></div>
        <button class="wb-tool" :disabled="!canUndo" title="Undo (Ctrl+Z)" @click="history.undo().then(refreshHistoryFlags)"><Undo2 class="w-4 h-4" /></button>
        <button class="wb-tool" :disabled="!canRedo" title="Redo (Ctrl+Shift+Z)" @click="history.redo().then(refreshHistoryFlags)"><Redo2 class="w-4 h-4" /></button>
        <input ref="fileInput" type="file" accept="image/*" class="hidden" @change="onFilePicked" />
      </div>

      <!-- Tool options -->
      <div
        v-if="['pen', 'rect', 'ellipse', 'text', 'sticky'].includes(tool) || selectionKinds.any"
        class="absolute left-16 right-3 top-3 z-20 flex justify-center pointer-events-none"
      >
      <div class="pointer-events-auto flex flex-wrap items-center gap-2 px-2.5 py-1.5 rounded-xl bg-slate-950/90 border border-slate-800 shadow-xl backdrop-blur">
        <template v-if="tool === 'sticky' || selectionKinds.sticky">
          <button
            v-for="c in STICKY_COLORS"
            :key="c"
            class="w-5 h-5 rounded-md border border-slate-700"
            :class="{ 'ring-2 ring-indigo-400': stickyColor === c }"
            :style="{ background: c }"
            @click="applyStickyColor(c)"
          ></button>
        </template>
        <template v-else>
          <button
            v-for="c in COLORS"
            :key="c"
            class="w-5 h-5 rounded-full border border-slate-700"
            :class="{ 'ring-2 ring-indigo-400': color === c }"
            :style="{ background: c }"
            @click="applyColor(c)"
          ></button>
        </template>
        <template v-if="tool === 'pen'">
          <div class="w-px h-5 bg-slate-800"></div>
          <input v-model.number="penWidth" type="range" min="1" max="24" class="w-20 accent-indigo-500" title="Stroke width" />
        </template>
        <template v-if="tool === 'rect' || tool === 'ellipse' || selection.some(o => o.type === 'rect' || o.type === 'ellipse')">
          <div class="w-px h-5 bg-slate-800"></div>
          <button class="wb-chip" :class="{ 'wb-chip-active': shapeFilled }" @click="toggleFill">Fill</button>
        </template>
        <template v-if="selectionKinds.any">
          <div class="w-px h-5 bg-slate-800"></div>
          <button class="wb-tool !w-7 !h-7" title="Bring to front" @click="bringToFront"><ArrowUpToLine class="w-3.5 h-3.5" /></button>
          <button class="wb-tool !w-7 !h-7" title="Send to back" @click="sendToBack"><ArrowDownToLine class="w-3.5 h-3.5" /></button>
          <button
            v-if="showWhiteboardAi && selectionKinds.sketchable"
            class="wb-chip text-fuchsia-300"
            :disabled="ai.busy"
            title="Redraw the selected sketch as a clean SVG"
            @click="sketchToSvg"
          ><Wand2 class="w-3.5 h-3.5" /> Sketch → SVG</button>
          <button class="wb-tool !w-7 !h-7 text-rose-400" title="Delete (Del)" @click="deleteSelection"><Trash2 class="w-3.5 h-3.5" /></button>
        </template>
      </div>
      </div>

      <!-- Someone else is editing the selection -->
      <div
        v-if="selection.length && selection.some(o => editingBy.has(o.id))"
        class="absolute left-1/2 -translate-x-1/2 top-14 z-20 px-2 py-1 rounded-lg bg-amber-500/15 text-amber-300 text-[11px]"
      >
        {{ editingBy.get(selection.find(o => editingBy.has(o.id))!.id)?.name }} is editing this
      </div>

      <!-- AI generate panel -->
      <div
        v-if="ai.open && showWhiteboardAi"
        class="absolute left-16 top-1/2 -translate-y-1/2 z-30 w-72 p-3 rounded-2xl bg-slate-950/95 border border-slate-800 shadow-2xl backdrop-blur"
      >
        <p class="text-xs font-semibold mb-2 flex items-center gap-1.5"><Sparkles class="w-3.5 h-3.5 text-fuchsia-300" /> Generate SVG with {{ aiName }}</p>
        <textarea
          v-model="ai.prompt"
          rows="3"
          placeholder="e.g. a minimalist desk lamp, line art"
          class="w-full text-xs rounded-lg bg-slate-900 border border-slate-700 p-2 outline-none focus:border-indigo-500 resize-none select-text"
          @keydown.enter.exact.prevent="generateSvg"
        ></textarea>
        <p v-if="ai.error" class="text-[11px] text-rose-400 mt-1">{{ ai.error }}</p>
        <div class="flex justify-end gap-2 mt-2">
          <button class="wb-chip" @click="ai.open = false">Cancel</button>
          <button class="wb-chip wb-chip-active" :disabled="ai.busy || !ai.prompt.trim()" @click="generateSvg">
            {{ ai.busy ? 'Generating...' : 'Generate' }}
          </button>
        </div>
      </div>

      <!-- Zoom -->
      <div class="absolute right-3 bottom-3 z-20 flex items-center gap-1 px-1.5 py-1 rounded-xl bg-slate-950/90 border border-slate-800 shadow-xl text-xs">
        <button class="wb-tool !w-7 !h-7" title="Zoom out" @click="zoomBy(1 / 1.2)"><Minus class="w-3.5 h-3.5" /></button>
        <button class="w-12 text-center text-slate-300 hover:text-white" title="Zoom to fit" @click="zoomToFit">{{ zoomPct }}%</button>
        <button class="wb-tool !w-7 !h-7" title="Zoom in" @click="zoomBy(1.2)"><Plus class="w-3.5 h-3.5" /></button>
      </div>

      <div v-if="toast" class="absolute left-1/2 -translate-x-1/2 bottom-4 z-30 px-3 py-1.5 rounded-lg bg-slate-950/95 border border-slate-700 text-xs shadow-xl">
        {{ toast }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.wb-grid {
  background-color: #f8fafc;
  background-image: radial-gradient(#cbd5e1 1px, transparent 1px);
  background-size: 22px 22px;
}
.wb-btn {
  display: inline-flex;
  flex-shrink: 0;
  white-space: nowrap;
  align-items: center;
  gap: 0.375rem;
  padding: 0.375rem 0.625rem;
  border-radius: 0.5rem;
  font-size: 0.75rem;
  font-weight: 600;
  background: rgb(30 41 59);
  color: rgb(226 232 240);
}
.wb-btn:hover {
  background: rgb(51 65 85);
}
.wb-tool {
  width: 2.25rem;
  height: 2.25rem;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 0.6rem;
  color: rgb(203 213 225);
}
.wb-tool:hover:not(:disabled) {
  background: rgb(30 41 59);
  color: white;
}
.wb-tool:disabled {
  opacity: 0.35;
}
.wb-tool-active {
  background: rgb(79 70 229) !important;
  color: white !important;
}
.wb-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.25rem 0.5rem;
  border-radius: 0.5rem;
  font-size: 0.7rem;
  font-weight: 600;
  background: rgb(30 41 59);
  color: rgb(203 213 225);
}
.wb-chip:disabled {
  opacity: 0.5;
}
.wb-chip-active {
  background: rgb(79 70 229);
  color: white;
}
</style>
