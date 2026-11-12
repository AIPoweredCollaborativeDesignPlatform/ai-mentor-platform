export const humanSender = m => !!m.senderUid && !['ai_mentor', 'ai_mentor_3d', 'system'].includes(m.senderUid);
export const hasCodingMedia = m => m.status !== 'failed' && !(m.type === 'whiteboard_state' && (m.metadata?.isPrivate === true || m.metadata?.wasPublished === false)) && (
  (m.type === 'file' && m.fileData?.type === 'image') || m.type === 'whiteboard_state'
  || ['image', 'moodboard', 'sketch', 'mesh_3d', 'parametric_3d'].includes(m.assetType));
export const codingTarget = m => humanSender(m) && m.status !== 'failed'
  && ((m.type === 'text' && !!String(m.content || '').trim()) || hasCodingMedia(m));
export function mediaWindow(messages, id) {
  const targets = messages.filter(codingTarget), i = targets.findIndex(m => m.id === id);
  if (i < 0) return [];
  const start = i <= 5 ? 0 : messages.indexOf(targets[i - 5]);
  const end = i + 5 >= targets.length - 1 ? messages.length - 1 : messages.indexOf(targets[i + 5]);
  // Asset cards are evidence; their AI-authored prose is hidden by the renderer.
  return messages.slice(start, end + 1).filter(m => codingTarget(m) || (m.senderUid !== 'system' && hasCodingMedia(m)));
}
export function mediaEvidence(m) {
  return [m.id, m.senderUid, m.senderName || '', m.timestamp, humanSender(m) ? m.content || '' : '',
    m.type, m.fileData || null, m.assetType || null, m.assetPayload || null, m.collage || null, m.whiteboardThumbnail || null];
}
