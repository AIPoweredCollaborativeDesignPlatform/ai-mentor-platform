/**
 * Tripo3D & Text-to-3D Service
 * Generates photorealistic, smooth, curved 3D mesh models (.glb) from natural language prompts
 */

export interface TripoTaskResult {
  success: boolean;
  taskId?: string;
  modelUrl?: string;
  thumbnailUrl?: string;
  error?: string;
}

export const getStoredTripoApiKey = (): string => {
  return (
    localStorage.getItem('ai_tripo_api_key') ||
    (window as any).__SHARED_TRIPO_KEY__ ||
    import.meta.env.VITE_TRIPO_API_KEY ||
    ''
  );
};

export const setStoredTripoApiKey = (key: string): void => {
  if (key) {
    localStorage.setItem('ai_tripo_api_key', key.trim());
    (window as any).__SHARED_TRIPO_KEY__ = key.trim();
  } else {
    localStorage.removeItem('ai_tripo_api_key');
    delete (window as any).__SHARED_TRIPO_KEY__;
  }
};

/**
 * Generate a 3D .glb mesh using Tripo3D API
 */
export async function generate3DModelWithTripo(
  prompt: string,
  apiKey?: string,
  onProgress?: (status: string) => void
): Promise<TripoTaskResult> {
  const token = apiKey || getStoredTripoApiKey();
  if (!token) {
    return {
      success: false,
      error: 'No Tripo3D API Key configured.'
    };
  }

  try {
    if (onProgress) onProgress('Initiating 3D neural generation on Tripo...');

    // 1. Submit text_to_model task
    const createRes = await fetch('https://api.tripo3d.ai/v2/openapi/task', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        type: 'text_to_model',
        prompt: prompt.trim()
      })
    });

    if (!createRes.ok) {
      const errJson = await createRes.json().catch(() => ({}));
      return {
        success: false,
        error: errJson.message || `Tripo API error (${createRes.status})`
      };
    }

    const createData = await createRes.json();
    const taskId = createData.data?.task_id;
    if (!taskId) {
      return {
        success: false,
        error: 'Failed to obtain Tripo task ID.'
      };
    }

    // 2. Poll task status (max 45 attempts, every 2s = 90s max)
    let attempts = 0;
    const maxAttempts = 45;

    while (attempts < maxAttempts) {
      await new Promise((r) => setTimeout(r, 2000));
      attempts++;

      const pollRes = await fetch(`https://api.tripo3d.ai/v2/openapi/task/${taskId}`, {
        headers: {
          Authorization: `Bearer ${token}`
        }
      });

      if (!pollRes.ok) continue;
      const pollData = await pollRes.json();
      const task = pollData.data;

      if (task?.status === 'success') {
        const modelUrl = task.output?.pbr_model || task.output?.model;
        const thumbnailUrl = task.output?.rendered_image;
        return {
          success: true,
          taskId,
          modelUrl,
          thumbnailUrl
        };
      } else if (task?.status === 'failed' || task?.status === 'cancelled') {
        return {
          success: false,
          error: task.error_message || '3D generation failed on Tripo servers.'
        };
      } else {
        const progress = task?.progress || Math.min(90, attempts * 3);
        if (onProgress) onProgress(`Generating 3D mesh with Tripo: ${progress}%...`);
      }
    }

    return {
      success: false,
      error: '3D model generation timed out. Please try again.'
    };
  } catch (err: any) {
    console.error('[Tripo3D Service Error]', err);
    return {
      success: false,
      error: err.message || 'Network error connecting to Tripo3D API.'
    };
  }
}
