import * as fabric from 'fabric';

const BG = '#f8fafc';

function boundsOf(objects: fabric.FabricObject[]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const o of objects) {
    const r = o.getBoundingRect();
    minX = Math.min(minX, r.left);
    minY = Math.min(minY, r.top);
    maxX = Math.max(maxX, r.left + r.width);
    maxY = Math.max(maxY, r.top + r.height);
  }
  return { left: minX, top: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * Renders `objects` (clones, the live canvas is untouched) into a JPEG/PNG data URL that fits
 * `maxW × maxH`, with `margin` canvas units around the content.
 */
export async function renderObjects(objects: fabric.FabricObject[], opts: { maxW: number; maxH: number; margin?: number; format?: 'jpeg' | 'png'; background?: string | null; fixedSize?: boolean }) {
  const margin = opts.margin ?? 24;
  // Children of the active multi-selection are stored relative to it; clones get their scene transform back
  const clones = await Promise.all(objects.map(async o => {
    const c = await o.clone();
    if (o.group) fabric.util.applyTransformToObject(c, o.calcTransformMatrix());
    c.setCoords();
    return c;
  }));
  const b = clones.length ? boundsOf(clones) : { left: 0, top: 0, width: 400, height: 250 };
  const contentW = b.width + margin * 2;
  const contentH = b.height + margin * 2;
  const scale = Math.min(opts.maxW / contentW, opts.maxH / contentH, opts.fixedSize ? Infinity : 2);
  const width = opts.fixedSize ? opts.maxW : Math.max(1, Math.round(contentW * scale));
  const height = opts.fixedSize ? opts.maxH : Math.max(1, Math.round(contentH * scale));

  const el = document.createElement('canvas');
  const sc = new fabric.StaticCanvas(el, { width, height, renderOnAddRemove: false, enableRetinaScaling: false });
  if (opts.background !== null) sc.backgroundColor = opts.background ?? BG;
  const offsetX = (width - b.width * scale) / 2 - b.left * scale;
  const offsetY = (height - b.height * scale) / 2 - b.top * scale;
  sc.setViewportTransform([scale, 0, 0, scale, offsetX, offsetY]);
  clones.forEach(c => sc.add(c));
  sc.renderAll();
  const url = sc.toDataURL({ format: opts.format ?? 'jpeg', quality: 0.75, multiplier: 1 });
  sc.dispose();
  return url;
}

/** Chat-card thumbnail (400×300, matches the 4:3 card). */
export const renderThumbnail = (objects: fabric.FabricObject[]) =>
  renderObjects(objects, { maxW: 400, maxH: 300, fixedSize: true });

/** Larger image for the AI vision summary and for "share as image". */
export const renderSnapshot = (objects: fabric.FabricObject[]) =>
  renderObjects(objects, { maxW: 1600, maxH: 1200, format: 'png' });

/** Shrinks an uploaded image so the longest side is at most `maxSide`. */
export async function downscaleImage(file: Blob, maxSide = 2000): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.size < 1.5 * 1024 * 1024) return file;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
  return new Promise(resolve => canvas.toBlob(b => resolve(b || file), type, 0.88));
}
