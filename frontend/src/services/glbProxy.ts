/**
 * GLB Proxy Service — Firebase Storage Re-hosting + Blob URL Fallback
 *
 * Problem: Meshy/Tripo presigned AWS S3 URLs are missing `Access-Control-Allow-Origin: *`,
 * so the browser's WebGL context (used by <model-viewer>) cannot fetch the binary.
 *
 * Two-tier solution:
 * 1. Blob URL (immediate, session-only): fetch GLB as ArrayBuffer → createObjectURL → 
 *    pass to model-viewer. Works if the Meshy/S3 CORS allows JS-level fetch.
 *
 * 2. Firebase Storage (permanent, cross-session): upload blob to Firebase Storage where
 *    we control CORS headers, then use the permanent download URL.
 *
 * The service tries Tier 1 first; if Firebase Storage is available it also does Tier 2.
 */

import { storage } from '../firebase/config';
import { ref as storageRef, uploadBytes, getDownloadURL } from 'firebase/storage';

export interface GlbProxyResult {
  success: boolean;
  /** A usable URL — either a Firebase Storage URL or a session-local Blob URL */
  firebaseUrl?: string;
  /** True if the URL is a permanent Firebase Storage URL */
  isPermanent?: boolean;
  error?: string;
}

/**
 * Check if a given URL is already a Firebase Storage URL (already proxied / permanent).
 */
export function isFirebaseStorageUrl(url: string): boolean {
  return (
    url.includes('firebasestorage.googleapis.com') ||
    url.includes('storage.googleapis.com') ||
    url.includes('firebasestorage.app')
  );
}

/**
 * Check if a given URL is a Blob URL (session-local, won't survive page reload).
 */
export function isBlobUrl(url: string): boolean {
  return url.startsWith('blob:');
}

/**
 * Attempt to download a GLB from a remote presigned URL, then:
 *   1. Always create a session-local Blob URL for immediate use.
 *   2. If Firebase Storage is available, also upload there for permanence.
 *
 * @param remoteGlbUrl  - The original Meshy / Tripo presigned model URL
 * @param taskId        - Unique ID used to name the file in Firebase Storage
 * @param onProgress    - Optional progress callback
 */
export async function reHostGlbToFirebaseStorage(
  remoteGlbUrl: string,
  taskId: string,
  onProgress?: (status: string) => void
): Promise<GlbProxyResult> {
  // Check if we already have a cached permanent Firebase URL for this task
  const cacheKey = `glb_firebase_url_${taskId}`;
  const cached = localStorage.getItem(cacheKey);
  if (cached && isFirebaseStorageUrl(cached)) {
    console.log('[GLB Proxy] Permanent cache hit for', taskId);
    return { success: true, firebaseUrl: cached, isPermanent: true };
  }

  try {
    if (onProgress) onProgress('正在取得 3D 模型資料...');

    // ─── Step 1: Fetch the GLB binary ─────────────────────────────────────────
    // Use JS fetch (not WebGL fetch) — browser CORS for fetch() is separate from
    // the WebGL binary loading context. Meshy presigned S3 URLs often allow this.
    const proxyErrors: string[] = [];

    // ─── Step 1: Attempt to fetch the GLB binary ──────────────────────────────
    let arrayBuffer: ArrayBuffer | null = null;
    
    // First attempt: Direct fetch
    try {
      const fetchRes = await fetch(remoteGlbUrl, {
        method: 'GET',
        mode: 'cors',
        cache: 'no-store'
      });
      if (fetchRes.ok) {
        arrayBuffer = await fetchRes.arrayBuffer();
        console.log('[GLB Proxy] Direct CORS fetch succeeded');
      } else {
        proxyErrors.push(`Direct: ${fetchRes.status}`);
        throw new Error(`Direct fetch failed: ${fetchRes.status}`);
      }
    } catch (corsErr: any) {
      if (!proxyErrors.length) proxyErrors.push(`Direct: ${corsErr.message}`);
      console.warn('[GLB Proxy] Direct fetch failed, trying CORS proxies...');
      
      // Fallback 1: Native Firebase Cloud Function proxy (Most Reliable)
      try {
        const proxyUrl2 = `/api/proxy?url=${encodeURIComponent(remoteGlbUrl)}`;
        const fetchRes2 = await fetch(proxyUrl2);
        if (fetchRes2.ok) {
          arrayBuffer = await fetchRes2.arrayBuffer();
          console.log('[GLB Proxy] Firebase Cloud Function proxy succeeded');
        } else {
          proxyErrors.push(`firebaseProxy: ${fetchRes2.status}`);
          throw new Error(`firebaseProxy failed: ${fetchRes2.status}`);
        }
      } catch (proxyErr2: any) {
        if (!proxyErrors.find(e => e.startsWith('firebaseProxy'))) proxyErrors.push(`firebaseProxy: ${proxyErr2.message}`);
        console.warn('[GLB Proxy] firebaseProxy failed, trying allorigins...', proxyErr2);
        
        // Fallback 2: allorigins.win
        try {
          const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(remoteGlbUrl)}`;
          const fetchRes = await fetch(proxyUrl);
          if (fetchRes.ok) {
            arrayBuffer = await fetchRes.arrayBuffer();
            console.log('[GLB Proxy] allorigins succeeded');
          } else {
            proxyErrors.push(`allorigins: ${fetchRes.status}`);
            throw new Error(`allorigins failed: ${fetchRes.status}`);
          }
        } catch (proxyErr: any) {
          if (!proxyErrors.find(e => e.startsWith('allorigins'))) proxyErrors.push(`allorigins: ${proxyErr.message}`);
          console.warn('[GLB Proxy] allorigins failed');
        }
      }
    }

    if (!arrayBuffer || arrayBuffer.byteLength === 0) {
      return {
        success: false,
        error: `Unable to fetch 3D model. The file may have expired or is blocked. \n[Details: ${proxyErrors.join(', ')}]`
      };
    }

    const blob = new Blob([arrayBuffer], { type: 'model/gltf-binary' });

    // ─── Step 2: Create a session-local Blob URL (immediate) ─────────────────
    const blobUrl = URL.createObjectURL(blob);
    console.log('[GLB Proxy] Blob URL created:', blobUrl);

    // ─── Step 3: Upload to Firebase Storage if available (permanent) ──────────
    if (storage && taskId) {
      try {
        if (onProgress) onProgress('Uploading to cloud storage (permanent preservation)...');
        const path = `models/${taskId}.glb`;
        const fileRef = storageRef(storage, path);

        await uploadBytes(fileRef, blob, {
          contentType: 'model/gltf-binary',
          cacheControl: 'public, max-age=31536000'
        });

        const firebaseUrl = await getDownloadURL(fileRef);
        console.log('[GLB Proxy] Uploaded to Firebase Storage:', firebaseUrl);

        // Cache the permanent URL
        localStorage.setItem(cacheKey, firebaseUrl);

        // Revoke the blob URL since we have a permanent one
        URL.revokeObjectURL(blobUrl);

        return { success: true, firebaseUrl, isPermanent: true };
      } catch (storageErr: any) {
        console.warn('[GLB Proxy] Firebase Storage upload failed, using Blob URL:', storageErr.message);
        // Storage upload failed (e.g. not set up yet) — fall back to blob URL
      }
    }

    // Return the session-local blob URL
    return { success: true, firebaseUrl: blobUrl, isPermanent: false };
  } catch (err: any) {
    console.error('[GLB Proxy] Error:', err);
    return {
      success: false,
      error: err.message || '處理 3D 模型時發生錯誤。'
    };
  }
}
