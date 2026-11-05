import { randomUUID } from 'node:crypto';
import { rehostToStorage } from './storage.js';

/**
 * Text-to-image via fal.ai (FLUX schnell by default), or image-to-image when `imageUrl` is given
 * (a URL or data URI; `strength` 0-1 = how far it may move away from the input). fal result URLs are
 * temporary, so each image is copied into Firebase Storage.
 */
export async function generateImage(prompt, { falKey, model, folder, imageUrl = null, strength = 0.85 }) {
  const body = imageUrl
    ? { prompt, image_url: imageUrl, strength, num_images: 1, enable_safety_checker: true }
    : { prompt, image_size: 'landscape_4_3', num_images: 1, enable_safety_checker: true };
  const res = await fetch(`https://fal.run/${model}`, {
    method: 'POST',
    headers: { Authorization: `Key ${falKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Image generation failed (${res.status}): ${detail.slice(0, 200)}`);
  }
  const data = await res.json();
  const url = data?.images?.[0]?.url;
  if (!url) throw new Error('Image generation returned no image');
  return rehostToStorage(url, `generated/${folder}/${randomUUID()}.jpg`);
}

/** Generates all images in parallel; a failed image keeps an empty url instead of failing the batch. */
export async function generateImages(prompts, opts) {
  const results = await Promise.allSettled(prompts.map(p => generateImage(p, opts)));
  return results.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    console.warn(`[images] prompt ${i} failed:`, r.reason?.message || r.reason);
    return '';
  });
}

// Sketch look added to every sketch prompt, so the style stays the same whatever the AI writes
export const SKETCH_STYLE = 'loose pencil product design idea sketch on white paper, black line art with light grey shading, a few construction lines, no text, no colour';
const REFINE_STYLES = [
  'clean, confident product design presentation sketch of the same object, black pencil line art with light grey shading on white paper, same form and proportions, no text',
  'photorealistic product render of the same object, soft studio lighting, neutral light background, same form and proportions, no text'
];

/** Idea sketches from text prompts (AI asset "sketch"); failed ones keep an empty url. */
export const generateSketches = (prompts, opts) => generateImages(prompts.map(p => `${p}. ${SKETCH_STYLE}`), opts);

/**
 * A whiteboard drawing -> a clean sketch and a render of the same object (image-to-image). `items` are the
 * on-topic descriptions from sketchBrief; without them a generic prompt is used.
 */
export async function refineSketch(imageDataUrl, notes, opts, items = null) {
  const hint = notes ? ` The designers describe it as: ${notes}.` : '';
  const results = await Promise.allSettled(REFINE_STYLES.map((style, i) =>
    generateImage(items?.[i] ? `${style}. The object: ${items[i].prompt}` : `${style}.${hint}`, { ...opts, imageUrl: imageDataUrl, strength: i === 0 ? 0.7 : 0.8 })));
  return results.map(r => (r.status === 'fulfilled' ? r.value : ''));
}

// An uploaded sketch or photo -> new idea sketches that develop it further (image-to-image)
const VARIATION_STYLES = [
  'product design idea sketch developing the object in the input image: the same idea with a cleaner, more resolved form',
  'product design idea sketch of a bolder variation of the object in the input image: change the overall form and proportions',
  'product design idea sketch of a variation of the object in the input image: a different mechanism, joint or way of use'
];

/**
 * Uploaded sketch or photo -> 3 idea sketches that take it further. `items` (from sketchBrief) keep them on
 * the team's topic; the lower strength keeps the composition of the original.
 */
export async function sketchVariations(imageUrl, notes, opts, items = null) {
  const hint = notes ? ` The designers say: ${notes}.` : '';
  const results = await Promise.allSettled(VARIATION_STYLES.map((style, i) =>
    generateImage(items?.[i] ? `${items[i].prompt}. ${SKETCH_STYLE}` : `${style}. ${SKETCH_STYLE}.${hint}`, { ...opts, imageUrl, strength: i === 0 ? 0.7 : 0.82 })));
  return results.map(r => (r.status === 'fulfilled' ? r.value : ''));
}
