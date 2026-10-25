import { httpsCallable } from 'firebase/functions';
import { functions } from '../firebase/config';

export interface Model3DResult {
  taskId: string;
  modelUrl: string; // permanent Firebase Storage copy
  originalModelUrl: string;
  thumbnailUrl?: string;
  provider: string;
}

// Jobs run to completion server-side (1–3 minutes) with the system-configured engine and keys
const callable = <Req>(name: string) => httpsCallable<Req, Model3DResult>(functions, name, { timeout: 540_000 });

export async function generateModel3D(prompt: string): Promise<Model3DResult> {
  return (await callable<{ prompt: string }>('generateModel3D')({ prompt })).data;
}

export async function refineModel3D(taskId: string, texturePrompt = ''): Promise<Model3DResult> {
  return (await callable<{ taskId: string; texturePrompt: string }>('refineModel3D')({ taskId, texturePrompt })).data;
}
