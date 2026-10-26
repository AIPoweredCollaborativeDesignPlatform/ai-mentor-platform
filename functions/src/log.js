import { FieldValue, getFirestore } from 'firebase-admin/firestore';

/**
 * Research log of every AI call (aiLogs collection). Written with the Admin SDK only;
 * Firestore rules give clients no access, so participants can never read assessments.
 * Logging failures never break the user-facing call.
 */
export async function logAiCall(entry) {
  try {
    await getFirestore().collection('aiLogs').add({ ...entry, createdAt: FieldValue.serverTimestamp() });
  } catch (err) {
    console.error('[aiLogs] write failed:', err?.message || err);
  }
}

export const countWebSearches = response =>
  (response?.content || []).filter(b => b.type === 'server_tool_use' && b.name === 'web_search').length;
