import { rehostToStorage } from './storage.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function pollUntilDone({ url, headers, intervalMs, maxAttempts, read }) {
  for (let i = 0; i < maxAttempts; i++) {
    await sleep(intervalMs);
    const res = await fetch(url, { headers });
    if (!res.ok) continue;
    const outcome = read(await res.json());
    if (outcome) return outcome;
  }
  throw new Error('3D generation timed out. Please try again.');
}

async function postJson(url, token, body, label) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`${label} API error ${res.status}: ${data.message || JSON.stringify(data).slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

const MESHY_TASKS = 'https://api.meshy.ai/openapi/v2/text-to-3d';
const MESHY_IMAGE_TASKS = 'https://api.meshy.ai/openapi/v1/image-to-3d';

async function meshyTask(token, body, base = MESHY_TASKS) {
  const created = await postJson(base, token, body, 'Meshy');
  const taskId = created.result || created.id;
  if (!taskId) throw new Error('Failed to obtain Meshy task ID.');
  return pollUntilDone({
    url: `${base}/${taskId}`,
    headers: { Authorization: `Bearer ${token}` },
    intervalMs: 2500,
    maxAttempts: 120,
    read: task => {
      if (task?.status === 'SUCCEEDED') {
        if (!task.model_urls?.glb) throw new Error('Meshy task succeeded but returned no GLB.');
        return { taskId, modelUrl: task.model_urls.glb, thumbnailUrl: task.thumbnail_url };
      }
      if (task?.status === 'FAILED' || task?.status === 'EXPIRED') {
        throw new Error(task.task_error?.message || '3D generation failed on Meshy servers.');
      }
      return null;
    }
  });
}

async function tripoTask(token, prompt) {
  const created = await postJson('https://api.tripo3d.ai/v2/openapi/task', token, { type: 'text_to_model', prompt }, 'Tripo');
  const taskId = created.data?.task_id;
  if (!taskId) throw new Error('Failed to obtain Tripo task ID.');
  return pollUntilDone({
    url: `https://api.tripo3d.ai/v2/openapi/task/${taskId}`,
    headers: { Authorization: `Bearer ${token}` },
    intervalMs: 2000,
    maxAttempts: 150,
    read: ({ data: task }) => {
      if (task?.status === 'success') {
        const modelUrl = task.output?.pbr_model || task.output?.model;
        if (!modelUrl) throw new Error('Tripo task succeeded but returned no model.');
        return { taskId, modelUrl, thumbnailUrl: task.output?.rendered_image };
      }
      if (task?.status === 'failed' || task?.status === 'cancelled') {
        throw new Error(task.error_message || '3D generation failed on Tripo servers.');
      }
      return null;
    }
  });
}

// 2k / 4k geometry exists only on meshy-7.1 (and "latest"); 4k/8k textures not on meshy-6-lite
const meshyPreviewBody = (prompt, opts = {}) => {
  const aiModel = opts.aiModel || 'meshy-7.1';
  const body = { mode: 'preview', prompt: String(prompt).slice(0, 800), ai_model: aiModel, should_remesh: true };
  if (opts.geometryResolution && opts.geometryResolution !== 'standard' && ['meshy-7.1', 'latest'].includes(aiModel)) {
    body.geometry_resolution = opts.geometryResolution;
  }
  return body;
};

/**
 * Runs a text-to-3D job to completion and copies the GLB into Firebase Storage,
 * so the browser can load it without CORS problems. `meshy`: system settings (src/config.js);
 * with autoRefine the textured model is returned (isRefined).
 */
export async function generate3D({ engine, prompt, keys, meshy = {} }) {
  if (engine === 'tripo') {
    const result = { ...(await tripoTask(keys.tripo, prompt)), provider: 'Tripo3D API' };
    const storedUrl = await rehostToStorage(result.modelUrl, `models/${result.taskId}.glb`, 'model/gltf-binary');
    return { ...result, originalModelUrl: result.modelUrl, modelUrl: storedUrl, isRefined: false };
  }
  const preview = { ...(await meshyTask(keys.meshy, meshyPreviewBody(prompt, meshy))), provider: `Meshy ${meshy.aiModel || 'meshy-7.1'} Text-to-3D` };
  if (meshy.autoRefine) {
    try {
      const refined = await refineMeshy({ previewTaskId: preview.taskId, keys, meshy });
      return { ...refined, previewTaskId: preview.taskId, isRefined: true };
    } catch (err) {
      console.warn('[generate3D] auto refine failed, keeping the preview:', err?.message || err);
    }
  }
  const storedUrl = await rehostToStorage(preview.modelUrl, `models/${preview.taskId}.glb`, 'model/gltf-binary');
  return { ...preview, originalModelUrl: preview.modelUrl, modelUrl: storedUrl, isRefined: false };
}

/**
 * Meshy image-to-3D (docs.meshy.ai/en/api/image-to-3d): `imageUrl` is a public URL or a data URI.
 * Textured in the same task, so the result needs no separate refine.
 */
export async function meshyImageTo3D({ imageUrl, keys, meshy = {} }) {
  const aiModel = meshy.aiModel || 'meshy-7.1';
  const body = { image_url: imageUrl, ai_model: aiModel, should_texture: true, should_remesh: true, enable_pbr: meshy.enablePbr !== false };
  if (meshy.geometryResolution && meshy.geometryResolution !== 'standard' && ['meshy-7.1', 'latest'].includes(aiModel)) body.geometry_resolution = meshy.geometryResolution;
  if (meshy.textureResolution && meshy.textureResolution !== '2k' && aiModel !== 'meshy-6-lite') body.texture_resolution = meshy.textureResolution;
  let result;
  try {
    result = await meshyTask(keys.meshy, body, MESHY_IMAGE_TASKS);
  } catch (err) {
    // Some model / texture combinations reject optional settings (400): retry with the required fields only
    if (err.status !== 400) throw err;
    console.warn('[meshyImageTo3D] retrying with defaults:', err.message);
    result = await meshyTask(keys.meshy, { image_url: imageUrl, ai_model: aiModel, should_texture: true }, MESHY_IMAGE_TASKS);
  }
  const storedUrl = await rehostToStorage(result.modelUrl, `models/${result.taskId}.glb`, 'model/gltf-binary');
  return { ...result, originalModelUrl: result.modelUrl, modelUrl: storedUrl, provider: `Meshy ${aiModel} Image-to-3D`, isRefined: true };
}

/** Meshy texturing pass on an existing preview task. */
export async function refineMeshy({ previewTaskId, texturePrompt, keys, meshy = {} }) {
  const body = { mode: 'refine', preview_task_id: previewTaskId, enable_pbr: meshy.enablePbr !== false };
  const lite = meshy.aiModel === 'meshy-6-lite';
  if (meshy.textureResolution && meshy.textureResolution !== '2k' && !lite) body.texture_resolution = meshy.textureResolution;
  if (texturePrompt?.trim()) body.texture_prompt = texturePrompt.trim();
  const result = await meshyTask(keys.meshy, body);
  const storedUrl = await rehostToStorage(result.modelUrl, `models/${result.taskId}.glb`, 'model/gltf-binary');
  return { ...result, originalModelUrl: result.modelUrl, modelUrl: storedUrl, provider: 'Meshy.ai v2 Refine Engine' };
}
