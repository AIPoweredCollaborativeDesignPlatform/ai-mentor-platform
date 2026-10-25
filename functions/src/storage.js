import { randomUUID } from 'node:crypto';
import { getStorage } from 'firebase-admin/storage';

/** Downloads a remote file and stores it in the default bucket; returns a permanent token URL. */
export async function rehostToStorage(sourceUrl, destPath, contentType) {
  const res = await fetch(sourceUrl);
  if (!res.ok) throw new Error(`Download failed (${res.status}) for ${sourceUrl}`);
  const buffer = Buffer.from(await res.arrayBuffer());

  const bucket = getStorage().bucket();
  const token = randomUUID();
  await bucket.file(destPath).save(buffer, {
    contentType: contentType || res.headers.get('content-type') || 'application/octet-stream',
    metadata: { metadata: { firebaseStorageDownloadTokens: token }, cacheControl: 'public, max-age=31536000' }
  });
  return `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(destPath)}?alt=media&token=${token}`;
}
