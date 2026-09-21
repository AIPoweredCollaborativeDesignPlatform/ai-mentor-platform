/**
 * Meshy.ai & Text-to-3D Service
 * Generates high-fidelity, textured 3D mesh models (.glb) from natural language prompts
 * API Docs: https://developer.meshy.ai/
 */

export interface MeshyTaskResult {
  success: boolean;
  taskId?: string;
  modelUrl?: string;
  thumbnailUrl?: string;
  error?: string;
}

export const getStoredMeshyApiKey = (): string => {
  return localStorage.getItem('ai_meshy_api_key') || '';
};

export const setStoredMeshyApiKey = (key: string): void => {
  if (key) {
    localStorage.setItem('ai_meshy_api_key', key.trim());
  } else {
    localStorage.removeItem('ai_meshy_api_key');
  }
};

/**
 * Generate a fast, cost-effective 3D .glb preview mesh using Meshy API (v2 text-to-3d preview mode)
 */
export async function generate3DModelWithMeshy(
  prompt: string,
  apiKey?: string,
  onProgress?: (status: string) => void
): Promise<MeshyTaskResult> {
  const token = apiKey || getStoredMeshyApiKey();
  if (!token) {
    return {
      success: false,
      error: 'No Meshy API Key configured.'
    };
  }

  try {
    if (onProgress) onProgress('Submitting 3D task to Meshy AI (Fast Preview Mode)...');

    // 1. Submit text-to-3d preview task (costs minimal credits, 1-2 min fast generation)
    const createRes = await fetch('https://api.meshy.ai/openapi/v2/text-to-3d', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        mode: 'preview',
        prompt: prompt.trim(),
        art_style: 'realistic',
        should_remesh: true
      })
    });

    if (!createRes.ok) {
      const errJson = await createRes.json().catch(() => ({}));
      return {
        success: false,
        error: errJson.message || `Meshy API error (${createRes.status})`
      };
    }

    const createData = await createRes.json();
    const taskId = createData.result || createData.id;
    if (!taskId) {
      return {
        success: false,
        error: 'Failed to obtain Meshy task ID.'
      };
    }

    // 2. Poll task status until SUCCEEDED or FAILED
    let attempts = 0;
    const maxAttempts = 60;

    while (attempts < maxAttempts) {
      await new Promise((r) => setTimeout(r, 2500));
      attempts++;

      const pollRes = await fetch(`https://api.meshy.ai/openapi/v2/text-to-3d/${taskId}`, {
        headers: {
          Authorization: `Bearer ${token}`
        }
      });

      if (!pollRes.ok) continue;
      const task = await pollRes.json();

      if (task?.status === 'SUCCEEDED') {
        const modelUrl = task.model_urls?.glb;
        const thumbnailUrl = task.thumbnail_url;
        if (!modelUrl) {
          return {
            success: false,
            error: 'Meshy task succeeded but no GLB link was provided.'
          };
        }
        return {
          success: true,
          taskId,
          modelUrl,
          thumbnailUrl
        };
      } else if (task?.status === 'FAILED' || task?.status === 'EXPIRED') {
        return {
          success: false,
          error: task.task_error?.message || '3D generation failed on Meshy servers.'
        };
      } else {
        const progress = task?.progress !== undefined ? task.progress : Math.min(95, attempts * 2);
        if (onProgress) onProgress(`Generating 3D model with Meshy: ${progress}%...`);
      }
    }

    return {
      success: false,
      error: 'Meshy 3D generation timed out. Please try again.'
    };
  } catch (err: any) {
    console.error('[Meshy Service Error]', err);
    return {
      success: false,
      error: err.message || 'Network error connecting to Meshy API.'
    };
  }
}

/**
 * Refine & Colorize an existing 3D model (Meshy Text-to-3D Refine Mode)
 * Adds realistic textures, colors, and PBR shading to a previously generated preview mesh
 */
export async function refineAndColorizeModelWithMeshy(
  previewTaskId: string,
  texturePrompt?: string,
  apiKey?: string,
  onProgress?: (status: string) => void
): Promise<MeshyTaskResult> {
  const token = apiKey || getStoredMeshyApiKey();
  if (!token) {
    return {
      success: false,
      error: 'No Meshy API Key configured.'
    };
  }

  try {
    if (onProgress) onProgress('Submitting refinement & texturing task to Meshy AI...');

    const payload: any = {
      mode: 'refine',
      preview_task_id: previewTaskId,
      enable_pbr: true
    };
    if (texturePrompt && texturePrompt.trim()) {
      payload.texture_prompt = texturePrompt.trim();
    }

    const refineRes = await fetch('https://api.meshy.ai/openapi/v2/text-to-3d', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify(payload)
    });

    if (!refineRes.ok) {
      const errJson = await refineRes.json().catch(() => ({}));
      return {
        success: false,
        error: errJson.message || `Meshy Refine API error (${refineRes.status})`
      };
    }

    const refineData = await refineRes.json();
    const refineTaskId = refineData.result || refineData.id;
    if (!refineTaskId) {
      return {
        success: false,
        error: 'Failed to obtain Meshy refine task ID.'
      };
    }

    let attempts = 0;
    const maxAttempts = 60;

    while (attempts < maxAttempts) {
      await new Promise((r) => setTimeout(r, 2500));
      attempts++;

      const pollRes = await fetch(`https://api.meshy.ai/openapi/v2/text-to-3d/${refineTaskId}`, {
        headers: {
          Authorization: `Bearer ${token}`
        }
      });

      if (!pollRes.ok) continue;
      const task = await pollRes.json();

      if (task?.status === 'SUCCEEDED') {
        const modelUrl = task.model_urls?.glb;
        const thumbnailUrl = task.thumbnail_url;
        return {
          success: true,
          taskId: refineTaskId,
          modelUrl,
          thumbnailUrl
        };
      } else if (task?.status === 'FAILED' || task?.status === 'EXPIRED') {
        return {
          success: false,
          error: task.task_error?.message || 'Meshy texturing failed.'
        };
      } else {
        const progress = task?.progress !== undefined ? task.progress : Math.min(95, attempts * 2);
        if (onProgress) onProgress(`Applying textures & colors: ${progress}%...`);
      }
    }

    return {
      success: false,
      error: 'Texturing task timed out. Please try again.'
    };
  } catch (err: any) {
    console.error('[Meshy Refine Error]', err);
    return {
      success: false,
      error: err.message || 'Network error connecting to Meshy API.'
    };
  }
}
