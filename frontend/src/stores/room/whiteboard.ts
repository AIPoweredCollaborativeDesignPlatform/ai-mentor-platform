import { arrayUnion, deleteDoc, setDoc, updateDoc } from 'firebase/firestore';
import { roomDocRef, roomRef, type RoomContext } from './context';

const MEMORY_COOLDOWN_MS = 30000;

/**
 * Whiteboards (v2): the chat card rooms/{id}/messages/{boardId} (type 'whiteboard_state') is the board's
 * identity and privacy flag; its objects live in rooms/{id}/boards/{boardId}/objects (see src/whiteboard/).
 * There is no room-wide "live session": every public board is collaborative, private boards only open for
 * their creator, and a creator closing a board never affects anyone else.
 */
export function useRoomWhiteboard(ctx: RoomContext) {
  const { currentRoom, authStore } = ctx;
  let lastMemoryAt = 0;

  const msgRef = (boardId: string) => roomDocRef(currentRoom.value!.roomId, 'messages', boardId);
  const localMsg = (boardId: string) => currentRoom.value?.messages.find(m => m.id === boardId);

  /** Creates the card of a new board as a private draft (hidden from chat until shared). */
  const createBoard = async (boardId: string) => {
    if (!currentRoom.value || localMsg(boardId)) return;
    const name = authStore.displayName || 'Participant';
    await setDoc(msgRef(boardId), {
      senderUid: authStore.uid,
      senderName: name,
      senderAvatar: authStore.avatar || '🎨',
      type: 'whiteboard_state',
      content: 'Personal Draft',
      timestamp: Date.now(),
      fileData: { type: 'image', url: '', name: 'whiteboard.jpg', size: 0 },
      metadata: { boardV: 2, isPrivate: true, wasPublished: false, isSharedPost: false, creatorUid: authStore.uid, creatorName: name, creatorAvatar: authStore.avatar || '🎨', updatedAt: Date.now() }
    });
  };

  /** Removes a draft that was opened but never drawn on, so empty boards do not pile up in the drawer. */
  const deleteEmptyDraft = async (boardId: string) => {
    if (!currentRoom.value) return;
    await deleteDoc(msgRef(boardId)).catch(e => console.warn('Failed to delete empty draft:', e));
  };

  /** Shares a board to the chat (card moves to the latest position) or makes it private (card greys out). */
  const setBoardPrivacy = async (boardId: string, isPrivate: boolean, thumbnail?: string) => {
    if (!currentRoom.value) return;
    const name = localMsg(boardId)?.metadata?.creatorName || authStore.displayName || 'Participant';
    await updateDoc(msgRef(boardId), {
      'metadata.isPrivate': isPrivate,
      'metadata.isSharedPost': !isPrivate,
      'metadata.wasPublished': true,
      'metadata.updatedAt': Date.now(),
      ...(isPrivate ? {} : { content: `${name} shared a collaborative whiteboard`, timestamp: Date.now() }),
      ...(thumbnail ? { 'fileData.url': thumbnail } : {})
    });
  };

  const updateBoardThumbnail = async (boardId: string, thumbnail: string) => {
    if (!currentRoom.value || !thumbnail) return;
    await updateDoc(msgRef(boardId), { 'fileData.url': thumbnail, 'metadata.updatedAt': Date.now() }).catch(e => console.warn('Failed to update board thumbnail:', e));
  };

  /** Marks a v1 board as converted; its old JSON stays in metadata.whiteboardJson as a backup. */
  const markBoardMigrated = async (boardId: string) => {
    if (!currentRoom.value) return;
    await updateDoc(msgRef(boardId), { 'metadata.boardV': 2 }).catch(e => console.warn('Failed to mark board migrated:', e));
  };

  // AI-generated visual summary of the board, fed back into the mentor prompt (rate-limited)
  const recordWhiteboardSnapshotMemory = async (previewUrl: string, assetId?: string) => {
    if (!currentRoom.value || !previewUrl) return;
    const now = Date.now();
    if (now - lastMemoryAt < MEMORY_COOLDOWN_MS) return;
    lastMemoryAt = now;

    try {
      const { summarizeWhiteboardVisualSnapshot } = await import('../../services/ai');
      const summary = await summarizeWhiteboardVisualSnapshot(previewUrl, assetId);
      if (!summary) return;
      const memoryItem = { timestamp: now, timeFormatted: new Date(now).toLocaleTimeString(), summary, assetId: assetId || '' };
      (currentRoom.value.whiteboardMemories ||= []).push(memoryItem);
      await updateDoc(roomRef(currentRoom.value.roomId), { whiteboardMemories: arrayUnion(memoryItem) });
    } catch (err) {
      console.warn('Failed to record whiteboard snapshot memory:', err);
    }
  };

  return { createBoard, deleteEmptyDraft, setBoardPrivacy, updateBoardThumbnail, markBoardMigrated, recordWhiteboardSnapshotMemory };
}
