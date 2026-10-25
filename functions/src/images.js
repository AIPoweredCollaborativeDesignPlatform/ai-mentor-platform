import { randomUUID } from 'node:crypto';
import { rehostToStorage } from './storage.js';

/**
 * Text-to-image via fal.ai (FLUX schnell by default). fal result URLs are temporary,
 * so each image is copied into Firebase Storage.
 */
export async function generateImage(prompt, { falKey, model, folder }) {
  const res = await fetch(`https://fal.run/${model}`, {
    method: 'POST',
    headers: { Authorization: `Key ${falKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, image_size: 'landscape_4_3', num_images: 1, enable_safety_checker: true })
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
