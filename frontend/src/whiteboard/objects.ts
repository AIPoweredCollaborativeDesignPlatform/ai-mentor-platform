import * as fabric from 'fabric';

// Every board object carries a stable id; it is the Firestore doc id of rooms/{r}/boards/{b}/objects/{id}
fabric.FabricObject.customProperties = ['id', 'z', 'locked'];

export type BoardObject = fabric.FabricObject & { id: string; z: number; locked?: boolean };

export const newId = () => `o_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

export const STICKY_COLORS = ['#fef08a', '#fbcfe8', '#bfdbfe', '#bbf7d0', '#fed7aa', '#e9d5ff'];
export const STICKY_SIZE = 180; // initial size only, never a lower bound
const STICKY_PAD = 14;

/**
 * Sticky note: a Textbox drawn on a padded coloured card. `minHeight` keeps the card square while the
 * text is short; longer text grows the card. Scaling is converted into width so text never stretches.
 */
export class StickyNote extends fabric.Textbox {
  static type = 'sticky';
  declare minHeight: number;

  static customProperties = ['minHeight'];

  constructor(text: string, options: Partial<fabric.TextboxProps> & { minHeight?: number } = {}) {
    super(text, { padding: STICKY_PAD, fontSize: 18, fontFamily: 'Inter, system-ui, sans-serif', fill: '#1e293b', splitByGrapheme: true, objectCaching: false, ...options });
    this.minHeight = options.minHeight ?? STICKY_SIZE - STICKY_PAD * 2;
    this.lockScalingFlip = true;
    this.initDimensions();
  }

  initDimensions() {
    super.initDimensions();
    if (this.minHeight && this.height < this.minHeight) this.height = this.minHeight;
  }

  _renderBackground(ctx: CanvasRenderingContext2D) {
    const p = this.padding;
    const w = this.width + p * 2;
    const h = this.height + p * 2;
    ctx.save();
    ctx.shadowColor = 'rgba(15,23,42,0.18)';
    ctx.shadowBlur = 10;
    ctx.shadowOffsetY = 3;
    ctx.fillStyle = (this.backgroundColor as string) || STICKY_COLORS[0];
    ctx.beginPath();
    ctx.roundRect(-w / 2, -h / 2, w, h, 6);
    ctx.fill();
    ctx.restore();
  }

  // Hit area includes the padded card, not only the text lines
  containsPoint(point: fabric.Point) {
    const local = point.transform(fabric.util.invertTransform(this.calcTransformMatrix()));
    return Math.abs(local.x) <= this.width / 2 + this.padding && Math.abs(local.y) <= this.height / 2 + this.padding;
  }
}
fabric.classRegistry.setClass(StickyNote, 'sticky');
fabric.classRegistry.setSVGClass(StickyNote, 'sticky');

/** Bakes scale into width (and minHeight) so text keeps its size; used for sticky notes and text boxes. */
export function normalizeTextScale(obj: fabric.FabricObject) {
  if (!(obj instanceof fabric.Textbox)) return;
  if (obj.scaleX === 1 && obj.scaleY === 1) return;
  const width = Math.max(40, obj.width * obj.scaleX);
  if (obj instanceof StickyNote) obj.minHeight = Math.max(40, obj.height * obj.scaleY);
  obj.set({ width, scaleX: 1, scaleY: 1 });
  obj.initDimensions();
  obj.setCoords();
}

const withId = <T extends fabric.FabricObject>(obj: T, z: number): T & BoardObject => {
  (obj as any).id = newId();
  (obj as any).z = z;
  return obj as T & BoardObject;
};

export function createSticky(center: fabric.Point, color: string, z: number) {
  const inner = STICKY_SIZE - STICKY_PAD * 2;
  return withId(new StickyNote('', { left: center.x, top: center.y, width: inner, backgroundColor: color }), z);
}

export function createText(center: fabric.Point, color: string, z: number) {
  return withId(new fabric.Textbox('Text', { left: center.x, top: center.y, width: 200, fontSize: 24, fill: color, fontFamily: 'Inter, system-ui, sans-serif' }), z);
}

export type ShapeKind = 'rect' | 'ellipse';

export function createShape(kind: ShapeKind, origin: fabric.Point, stroke: string, fill: string, z: number) {
  const common = { left: origin.x, top: origin.y, stroke, fill, strokeWidth: 3, strokeUniform: true, width: 1, height: 1 };
  const obj = kind === 'rect' ? new fabric.Rect({ ...common, rx: 6, ry: 6 }) : new fabric.Ellipse({ ...common, rx: 0.5, ry: 0.5 });
  return withId(obj, z);
}

/** Resizes a shape being dragged out from `start` to `end` (both canvas points). */
export function resizeShape(obj: fabric.FabricObject, start: fabric.Point, end: fabric.Point, square: boolean) {
  let w = Math.abs(end.x - start.x);
  let h = Math.abs(end.y - start.y);
  if (square) w = h = Math.max(w, h);
  const cx = start.x + Math.sign(end.x - start.x || 1) * w / 2;
  const cy = start.y + Math.sign(end.y - start.y || 1) * h / 2;
  if (obj instanceof fabric.Ellipse) obj.set({ rx: Math.max(1, w / 2), ry: Math.max(1, h / 2) });
  else obj.set({ width: Math.max(1, w), height: Math.max(1, h) });
  obj.set({ left: cx, top: cy });
  obj.setCoords();
}

export async function createImage(url: string, center: fabric.Point, maxSide: number, z: number) {
  const img = await fabric.FabricImage.fromURL(url, { crossOrigin: 'anonymous' });
  const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
  img.set({ left: center.x, top: center.y, scaleX: scale, scaleY: scale });
  return withId(img, z);
}

export const svgToDataUrl = (svg: string) => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);

export function assignBoardIdentity(obj: fabric.FabricObject, z: number) {
  return withId(obj, z);
}

export const isBoardObject = (obj: fabric.FabricObject | undefined | null): obj is BoardObject =>
  Boolean(obj && (obj as any).id);

export const serialize = (obj: fabric.FabricObject): Record<string, any> => {
  const json = obj.toObject() as Record<string, any>;
  // Firestore rejects undefined and nested arrays (paths are arrays of arrays) → keep the path as a string
  if (Array.isArray(json.path)) json.path = JSON.stringify(json.path);
  return JSON.parse(JSON.stringify(json));
};

export const deserializeData = (data: Record<string, any>) => {
  const json = { ...data };
  if (typeof json.path === 'string') json.path = JSON.parse(json.path);
  return json;
};

export async function enliven(data: Record<string, any>): Promise<BoardObject | null> {
  try {
    const [obj] = await fabric.util.enlivenObjects<fabric.FabricObject>([deserializeData(data)]);
    return (obj as BoardObject) || null;
  } catch (err) {
    console.warn('[whiteboard] could not restore object', data?.type, err);
    return null;
  }
}
