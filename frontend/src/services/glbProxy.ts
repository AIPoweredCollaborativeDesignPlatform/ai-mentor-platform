import { t } from '../i18n';
/**
 * GLB Proxy Service — Firebase Storage Re-hosting + Blob URL Fallback
 *
 * Problem: Meshy/Tripo presigned AWS S3 URLs are missing `Access-Control-Allow-Origin: *`,
 * so the browser's WebGL loader cannot fetch the binary.
 *
 * Two-tier solution:
 * 1. Blob URL (immediate, session-only): fetch GLB as ArrayBuffer → createObjectURL → 
 *    pass to the viewer. Works if the Meshy/S3 CORS allows JS-level fetch.
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
    return { success: true, firebaseUrl: cached, isPermanent: true };
  }

  try {
    if (onProgress) onProgress(t('glb.fetching'));

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
      } else {
        proxyErrors.push(`Direct: ${fetchRes.status}`);
        throw new Error(`Direct fetch failed: ${fetchRes.status}`);
      }
    } catch (corsErr: any) {
      if (!proxyErrors.length) proxyErrors.push(`Direct: ${corsErr.message}`);
      console.warn('[GLB Proxy] Direct fetch failed, trying CORS proxies...');
      
      // Fallback: our own Hosting /api/proxy function (no third-party proxies: research data stays in-project)
      try {
        const proxyRes = await fetch(`/api/proxy?url=${encodeURIComponent(remoteGlbUrl)}`);
        if (!proxyRes.ok) throw new Error(String(proxyRes.status));
        arrayBuffer = await proxyRes.arrayBuffer();
      } catch (proxyErr: any) {
        proxyErrors.push(`proxy: ${proxyErr.message}`);
      }
    }

    if (!arrayBuffer || arrayBuffer.byteLength === 0) {
      return {
        success: false,
        error: `${t('glb.fetchFailed')} \n[Details: ${proxyErrors.join(', ')}]`
      };
    }

    const blob = new Blob([arrayBuffer], { type: 'model/gltf-binary' });

    // ─── Step 2: Create a session-local Blob URL (immediate) ─────────────────
    const blobUrl = URL.createObjectURL(blob);

    // ─── Step 3: Upload to Firebase Storage if available (permanent) ──────────
    if (storage && taskId) {
      try {
        if (onProgress) onProgress(t('glb.uploading'));
        const path = `models/${taskId}.glb`;
        const fileRef = storageRef(storage, path);

        await uploadBytes(fileRef, blob, {
          contentType: 'model/gltf-binary',
          cacheControl: 'public, max-age=31536000'
        });

        const firebaseUrl = await getDownloadURL(fileRef);

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
      error: err.message || t('glb.processFailed')
    };
  }
}
