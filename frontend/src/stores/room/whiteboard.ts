import { arrayUnion, deleteDoc, updateDoc } from 'firebase/firestore';
import type { MessageItem } from '../../types';
import { roomDocRef, roomRef, type RoomContext } from './context';

const SYNC_DEBOUNCE_MS = 50;
const MEMORY_COOLDOWN_MS = 30000;

type Messages = {
  sendCustomMessage: (payload: Partial<MessageItem>) => Promise<string | undefined>;
  updateCustomMessage: (id: string, updates: Partial<MessageItem>) => Promise<void>;
};

const CLEARED_SESSION = {
  whiteboardActive: false,
  whiteboardHostUid: null,
  whiteboardHostName: null,
  whiteboardState: null,
  whiteboardThumbnail: null
};

/**
 * Shared whiteboard session (rooms/{id}.whiteboardState is the authoritative live state)
 * and whiteboard assets (messages with type 'whiteboard_state').
 */
export function useRoomWhiteboard(ctx: RoomContext, messages: Messages) {
  const { currentRoom, authStore } = ctx;
  let syncTimer: ReturnType<typeof setTimeout> | undefined;
  let lastMemoryAt = 0;

  const myBoards = () =>
    currentRoom.value!.messages.filter(
      m => m.type === 'whiteboard_state' && (m.metadata?.creatorUid === authStore.uid || m.senderUid === authStore.uid)
    );

  // Older versions created extra "pointer" messages (metadata.assetId) for the same board; remove them
  const deleteDuplicatePointers = async (boards: MessageItem[]) => {
    for (const m of boards) {
      if (m.metadata?.assetId && boards.some(other => other.id === m.metadata.assetId)) {
        await deleteDoc(roomDocRef(currentRoom.value!.roomId, 'messages', m.id)).catch(() => {});
      }
    }
  };

  const thumbnailFile = (url: string) => ({ type: 'image' as const, url, name: 'whiteboard.jpg', size: 0 });

  const startWhiteboardSession = async (
    initialJson?: string,
    thumbnail?: string,
    existingAssetId?: string | null
  ): Promise<string | null | undefined> => {
    if (!currentRoom.value) return null;
    const hostName = authStore.displayName || 'Participant';
    try {
      await updateDoc(roomRef(currentRoom.value.roomId), {
        whiteboardActive: true,
        whiteboardHostUid: authStore.uid,
        whiteboardHostName: hostName,
        whiteboardState: initialJson || null,
        ...(thumbnail ? { whiteboardThumbnail: thumbnail } : {})
      });
      await deleteDuplicatePointers(myBoards());

      const sharedMeta = {
        isPrivate: false,
        wasPublished: true,
        isSharedPost: true,
        creatorUid: authStore.uid,
        creatorName: hostName
      };

      // Sharing an existing private draft moves it to public in place (never duplicates it)
      const existingMsg = existingAssetId ? currentRoom.value.messages.find(m => m.id === existingAssetId) : undefined;
      if (existingMsg) {
        await messages.updateCustomMessage(existingMsg.id, {
          content: `${hostName} shared a collaborative whiteboard`,
          timestamp: Date.now(),
          fileData: thumbnailFile(thumbnail || ''),
          metadata: {
            ...(existingMsg.metadata || {}),
            ...sharedMeta,
            whiteboardJson: initialJson || existingMsg.metadata?.whiteboardJson || '',
            updatedAt: Date.now()
          }
        });
        return existingMsg.id;
      }

      return await messages.sendCustomMessage({
        senderUid: authStore.uid,
        senderName: hostName,
        senderAvatar: authStore.avatar || '🎨',
        content: `${hostName} shared a collaborative whiteboard`,
        type: 'whiteboard_state',
        fileData: thumbnailFile(thumbnail || ''),
        metadata: { ...sharedMeta, whiteboardJson: initialJson || '' }
      });
    } catch (e) {
      console.error('Failed to start whiteboard:', e);
      alert('Failed to publish whiteboard: ' + ((e as any).message || String(e)));
      return null;
    }
  };

  // Debounced to stay under Firestore write limits
  const syncWhiteboardState = async (json: string, thumbnail?: string) => {
    if (!currentRoom.value?.whiteboardActive) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(async () => {
      if (!currentRoom.value?.whiteboardActive) return;
      try {
        await updateDoc(roomRef(currentRoom.value.roomId), {
          whiteboardState: json,
          ...(thumbnail ? { whiteboardThumbnail: thumbnail } : {})
        });
      } catch (e) {
        console.warn('Failed to sync whiteboard:', e);
      }
    }, SYNC_DEBOUNCE_MS);
  };

  const endWhiteboardSession = async () => {
    if (!currentRoom.value) return;
    await updateDoc(roomRef(currentRoom.value.roomId), CLEARED_SESSION).catch(e => console.warn('Failed to end whiteboard:', e));
  };

  // Ends the shared session and marks the board private; its chat card stays visible but greyed out
  const makeWhiteboardPrivate = async (targetAssetId?: string | null) => {
    if (!currentRoom.value) return;
    try {
      await updateDoc(roomRef(currentRoom.value.roomId), CLEARED_SESSION);
      const boards = myBoards();
      await deleteDuplicatePointers(boards);

      const targets = boards.filter(
        m => !m.metadata?.assetId && (m.id === targetAssetId || (!targetAssetId && !m.metadata?.isPrivate))
      );
      for (const asset of targets) {
        await messages.updateCustomMessage(asset.id, {
          // Keep the preview so the creator still sees the thumbnail among private drafts
          fileData: thumbnailFile(asset.fileData?.url || ''),
          metadata: { ...(asset.metadata || {}), isPrivate: true, isSharedPost: false, wasPublished: true }
        });
      }
    } catch (e) {
      console.warn('Failed to make whiteboard private:', e);
    }
  };

  // AI-generated visual summary of the board, fed back into the mentor prompt (rate-limited)
  const recordWhiteboardSnapshotMemory = async (previewUrl: string, json: string, assetId?: string) => {
    if (!currentRoom.value || !previewUrl) return;
    const now = Date.now();
    if (now - lastMemoryAt < MEMORY_COOLDOWN_MS) return;
    lastMemoryAt = now;

    try {
      const { summarizeWhiteboardVisualSnapshot } = await import('../../services/ai');
      const summary = await summarizeWhiteboardVisualSnapshot(previewUrl);
      if (!summary) return;
      const memoryItem = { timestamp: now, timeFormatted: new Date(now).toLocaleTimeString(), summary, assetId: assetId || '' };
      (currentRoom.value.whiteboardMemories ||= []).push(memoryItem);
      await updateDoc(roomRef(currentRoom.value.roomId), { whiteboardMemories: arrayUnion(memoryItem) });
    } catch (err) {
      console.warn('Failed to record whiteboard snapshot memory:', err);
    }
  };

  return {
    startWhiteboardSession,
    syncWhiteboardState,
    endWhiteboardSession,
    makeWhiteboardPrivate,
    recordWhiteboardSnapshotMemory
  };
}
