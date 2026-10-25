import * as fabric from 'fabric';

const WIDTH = 400;
const HEIGHT = 250;
const BG = '#f8fafc';

function placeholder(text: string, dashedFrame: boolean): string {
  const canvas = document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  if (dashedFrame) {
    ctx.strokeStyle = '#cbd5e1';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    ctx.strokeRect(20, 20, WIDTH - 40, HEIGHT - 40);
    ctx.setLineDash([]);
  }
  ctx.fillStyle = '#94a3b8';
  ctx.font = 'bold 13px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(text, WIDTH / 2, HEIGHT / 2 + 5);
  return canvas.toDataURL('image/jpeg', 0.85);
}

/** Renders a Fabric JSON board to a 400×250 JPEG data URL, zoomed to fit its content. */
export async function renderWhiteboardThumbnail(json: string | object): Promise<string> {
  if (!json) return '';
  let staticCanvas: fabric.StaticCanvas | null = null;
  try {
    const data = typeof json === 'string' ? JSON.parse(json) : json;
    const canvasEl = document.createElement('canvas');
    canvasEl.width = WIDTH;
    canvasEl.height = HEIGHT;
    staticCanvas = new fabric.StaticCanvas(canvasEl, { width: WIDTH, height: HEIGHT, renderOnAddRemove: false });
    await staticCanvas.loadFromJSON(data);

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    staticCanvas.getObjects().forEach((o: any) => {
      o.setCoords();
      if (o.isSystemObject || o.id === 'workspace-bg') return;
      const br = o.getBoundingRect();
      minX = Math.min(minX, br.left);
      minY = Math.min(minY, br.top);
      maxX = Math.max(maxX, br.left + br.width);
      maxY = Math.max(maxY, br.top + br.height);
    });

    const hasContent = minX !== Infinity && maxX > minX && maxY > minY;
    if (!hasContent) return placeholder('Blank Canvas', true);

    const pad = 60;
    const scale = Math.min(WIDTH / Math.max(100, maxX - minX + pad * 2), HEIGHT / Math.max(100, maxY - minY + pad * 2));
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    staticCanvas.setViewportTransform([scale, 0, 0, scale, WIDTH / 2 - cx * scale, HEIGHT / 2 - cy * scale]);
    staticCanvas.renderAll();

    // Composite onto an opaque background so the JPEG never turns black
    const out = document.createElement('canvas');
    out.width = WIDTH;
    out.height = HEIGHT;
    const ctx = out.getContext('2d');
    if (!ctx) return '';
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    ctx.drawImage(canvasEl, 0, 0);
    return out.toDataURL('image/jpeg', 0.85);
  } catch (e) {
    console.warn('renderWhiteboardThumbnail error:', e);
    return placeholder('Whiteboard Draft', false);
  } finally {
    staticCanvas?.dispose();
  }
}
