import { getSystemConfig } from './config.js';
import { generate3D, meshyImageTo3D } from './mesh3d.js';
import { renderFromImage } from './images.js';
import { sketchBrief } from './sketchBrief.js';
import { logAiCall } from './log.js';

/**
 * A sketch or photo -> a 3D model that keeps its form. Pencil lines are a poor input for image-to-3D,
 * so the image is first turned into a clean product render (fal.ai image-to-image, guided by Claude's
 * reading of the image and the conversation); Meshy image-to-3D then builds the model from that render.
 * Tripo has no image path here: it falls back to text-to-3D from the same description.
 */
export async function imageTo3D({ roomId, roomAi, image, notes = '', secrets }) {
  const sys = await getSystemConfig();
  const brief = await sketchBrief({ apiKey: secrets.anthropic, roomId, roomAi, image, notes, kind: 'refine' });
  const description = brief?.items?.[1]?.prompt || brief?.subject || notes || 'product prototype';
  const render = await renderFromImage(image, description, { falKey: secrets.fal, model: sys.sketchRefineModel, folder: `sketch/${roomId}` }).catch(err => {
    console.warn('[imageTo3D] render failed, using the original image:', err?.message || err);
    return '';
  });
  const input = render || image;
  const keys = { meshy: secrets.meshy, tripo: secrets.tripo };
  const res = sys.engine3D === 'meshy'
    ? await meshyImageTo3D({ imageUrl: input, keys, meshy: sys.meshy })
    : await generate3D({ engine: sys.engine3D, prompt: description, keys, meshy: sys.meshy });
  const source = image.startsWith('data:') ? 'chat upload' : image;
  await logAiCall({ kind: 'model_3d', roomId, model: sys.engine3D, input: { from: 'image', source, render, description, meshy: sys.engine3D === 'meshy' ? sys.meshy : null }, output: res });
  return { ...res, title: brief?.items?.[1]?.title || brief?.subject || '', description, source, render };
}
