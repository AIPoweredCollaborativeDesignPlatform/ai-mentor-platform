import * as fabric from 'fabric';
import { newId } from './objects';

type Pt = { x: number; y: number };
export type EndIndex = 0 | 1;

const HIT_TOLERANCE = 8; // screen pixels around the line that still count as a hit
const SNAP_GAP = 4; // gap between an attached end and the object's edge

/**
 * Arrow / line between two points. Each end can be attached to a board object (`startId` / `endId`), in which
 * case it sits on that object's edge and follows it. The geometry is stored as the vector `dx, dy` from the
 * start to the end, centred on the object's position; `layoutConnector` recomputes it from attached objects.
 */
export class Connector extends fabric.FabricObject {
  static type = 'connector';
  static customProperties = ['dx', 'dy', 'startId', 'endId', 'arrowStart', 'arrowEnd'];
  declare dx: number;
  declare dy: number;
  declare startId: string | null;
  declare endId: string | null;
  declare arrowStart: boolean;
  declare arrowEnd: boolean;

  constructor(options: Record<string, any> = {}) {
    super({ stroke: '#0f172a', strokeWidth: 3, fill: '', objectCaching: false, ...options });
    this.dx ??= 0;
    this.dy ??= 0;
    this.startId ??= null;
    this.endId ??= null;
    this.arrowStart ??= false;
    this.arrowEnd ??= true;
    this.syncSize();
    this.hasBorders = false;
    this.controls = { p0: endControl(0), p1: endControl(1) };
  }

  syncSize() {
    this.width = Math.abs(this.dx);
    this.height = Math.abs(this.dy);
  }

  /** End point in scene coordinates (also while inside a selection or a group). */
  getEnd(i: EndIndex) {
    const s = i === 0 ? -0.5 : 0.5;
    return new fabric.Point(this.dx * s, this.dy * s).transform(this.calcTransformMatrix());
  }

  /** Places the connector between two scene points (resets rotation and scale). */
  setEnds(a: Pt, b: Pt) {
    this.set({ dx: b.x - a.x, dy: b.y - a.y, angle: 0, scaleX: 1, scaleY: 1, skewX: 0, skewY: 0, flipX: false, flipY: false });
    this.syncSize();
    this.setPositionByOrigin(new fabric.Point((a.x + b.x) / 2, (a.y + b.y) / 2), 'center', 'center');
    this.setCoords();
  }

  _render(ctx: CanvasRenderingContext2D) {
    const ax = -this.dx / 2, ay = -this.dy / 2, bx = this.dx / 2, by = this.dy / 2;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = this.stroke as string;
    ctx.fillStyle = this.stroke as string;
    ctx.lineWidth = this.strokeWidth;
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.stroke();
    if (this.arrowEnd) drawHead(ctx, ax, ay, bx, by, this.strokeWidth);
    if (this.arrowStart) drawHead(ctx, bx, by, ax, ay, this.strokeWidth);
    ctx.restore();
  }

  // The bounding box of a diagonal line is mostly empty: only points near the segment hit it
  containsPoint(point: fabric.Point) {
    const a = this.getEnd(0), b = this.getEnd(1);
    const zoom = this.canvas?.getZoom() || 1;
    return distToSegment(point, a, b) <= HIT_TOLERANCE / zoom + this.strokeWidth / 2;
  }
}
fabric.classRegistry.setClass(Connector, 'connector');

function drawHead(ctx: CanvasRenderingContext2D, fx: number, fy: number, tx: number, ty: number, width: number) {
  const len = Math.hypot(tx - fx, ty - fy);
  if (len < 1) return;
  const size = Math.min(len * 0.6, 8 + width * 2.5);
  const ux = (tx - fx) / len, uy = (ty - fy) / len;
  const bx = tx - ux * size, by = ty - uy * size;
  const nx = -uy * size * 0.55, ny = ux * size * 0.55;
  ctx.beginPath();
  ctx.moveTo(tx + ux * width * 0.3, ty + uy * width * 0.3);
  ctx.lineTo(bx + nx, by + ny);
  ctx.lineTo(bx - nx, by - ny);
  ctx.closePath();
  ctx.fill();
}

export function distToSegment(p: Pt, a: Pt, b: Pt) {
  const vx = b.x - a.x, vy = b.y - a.y;
  const len2 = vx * vx + vy * vy;
  const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2)) : 0;
  return Math.hypot(p.x - (a.x + t * vx), p.y - (a.y + t * vy));
}

// ---------- attaching ----------
/** Centre and half size of an object's axis-aligned box in scene coordinates (works inside groups). */
function sceneBox(obj: fabric.FabricObject) {
  const m = obj.calcTransformMatrix();
  const pad = ((obj as any).padding || 0) + (obj.strokeWidth || 0) / 2;
  const w = obj.width / 2 + pad, h = obj.height / 2 + pad;
  const pts = [[-w, -h], [w, -h], [w, h], [-w, h]].map(([x, y]) => new fabric.Point(x, y).transform(m));
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, hw: (maxX - minX) / 2, hh: (maxY - minY) / 2 };
}

/** Where the ray from the object's centre towards `toward` leaves its box. */
function edgePoint(obj: fabric.FabricObject, toward: Pt) {
  const { cx, cy, hw, hh } = sceneBox(obj);
  const dx = toward.x - cx, dy = toward.y - cy;
  if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) return new fabric.Point(cx, cy);
  const s = Math.min(Math.abs(dx) > 1e-6 ? (hw + SNAP_GAP) / Math.abs(dx) : Infinity, Math.abs(dy) > 1e-6 ? (hh + SNAP_GAP) / Math.abs(dy) : Infinity);
  return new fabric.Point(cx + dx * s, cy + dy * s);
}

const centerOf = (obj: fabric.FabricObject) => new fabric.Point(0, 0).transform(obj.calcTransformMatrix());

export type FindObject = (id: string) => fabric.FabricObject | undefined;

/**
 * Re-places a connector's attached ends on their objects. An end whose object is gone (deleted, or not loaded
 * yet) keeps its last position, so undoing the deletion re-attaches it. Returns true if anything moved.
 */
export function layoutConnector(conn: Connector, find: FindObject) {
  const A = conn.startId ? find(conn.startId) : undefined;
  const B = conn.endId ? find(conn.endId) : undefined;
  if (!A && !B) return false;
  const a0 = conn.getEnd(0), b0 = conn.getEnd(1);
  const refA = A ? centerOf(A) : a0;
  const refB = B ? centerOf(B) : b0;
  const a = A ? edgePoint(A, refB) : a0;
  const b = B ? edgePoint(B, refA) : b0;
  if (Math.abs(a.x - a0.x) < 0.01 && Math.abs(a.y - a0.y) < 0.01 && Math.abs(b.x - b0.x) < 0.01 && Math.abs(b.y - b0.y) < 0.01) return false;
  conn.setEnds(a, b);
  return true;
}

/** Top-most attachable object under a scene point (connectors themselves are never attach targets). */
export function attachTargetAt(canvas: fabric.Canvas, p: Pt, exclude?: fabric.FabricObject) {
  const list = canvas.getObjects();
  for (let i = list.length - 1; i >= 0; i--) {
    const o = list[i];
    if (o === exclude || o instanceof Connector || !(o as any).id || !o.visible) continue;
    const { cx, cy, hw, hh } = sceneBox(o);
    if (Math.abs(p.x - cx) <= hw && Math.abs(p.y - cy) <= hh) return o;
  }
  return undefined;
}

export function createConnector(a: Pt, stroke: string, strokeWidth: number, z: number, startId: string | null = null) {
  const conn = new Connector({ stroke, strokeWidth, startId }) as Connector & { id: string; z: number };
  conn.id = newId();
  conn.z = z;
  conn.setEnds(a, a);
  return conn;
}

/** Moves one end of a connector to `p`, attaching it to the object under `p` (or detaching it). */
export function dragEnd(conn: Connector, end: EndIndex, p: Pt, find: FindObject) {
  const canvas = conn.canvas as fabric.Canvas | undefined;
  const target = canvas ? attachTargetAt(canvas, p) : undefined;
  const targetId = target ? ((target as any).id as string) : null;
  const otherId = end === 0 ? conn.endId : conn.startId;
  const id = targetId && targetId !== otherId ? targetId : null;
  if (end === 0) conn.startId = id;
  else conn.endId = id;
  const other = conn.getEnd(end === 0 ? 1 : 0);
  if (end === 0) conn.setEnds(p, other);
  else conn.setEnds(other, p);
  layoutConnector(conn, find);
}

// ---------- end-point controls ----------
let findForControls: FindObject = () => undefined;
/** The board registers how controls look objects up by id (for snapping while an end is dragged). */
export const setConnectorLookup = (find: FindObject) => (findForControls = find);

function endControl(end: EndIndex) {
  return new fabric.Control({
    cursorStyle: 'crosshair',
    actionName: 'moveEnd',
    sizeX: 12,
    sizeY: 12,
    positionHandler: (_dim, _finalMatrix, obj) => {
      const conn = obj as Connector;
      const p = conn.getEnd(end);
      return p.transform(conn.canvas?.viewportTransform || [1, 0, 0, 1, 0, 0]);
    },
    actionHandler: (_e, transform, x, y) => {
      const conn = transform.target as Connector;
      dragEnd(conn, end, { x, y }, findForControls);
      conn.canvas?.fire('object:moving', { target: conn } as any);
      return true;
    },
    render: (ctx, left, top) => {
      ctx.save();
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#6366f1';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(left, top, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
  });
}
