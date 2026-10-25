import { computed, ref, watch, type Ref } from 'vue';
import { useAuthStore } from '../stores/auth';
import { useRoomStore } from '../stores/room';
import type { MessageItem } from '../types';

/** Methods exposed by the whiteboard component that the room view relies on. */
export interface WhiteboardHandle {
  hasUnsavedChanges?: boolean;
  triggerAutoSaveAsAsset?: () => Promise<void> | void;
  handleCloseRequest?: () => void;
  setCurrentAssetId?: (id: string) => void;
  isBlankCanvas?: () => boolean;
}

/**
 * Which whiteboard is open in the room view and whether it is a private draft or the room's
 * shared live session. Rules (user requirements):
 *  - sharing a private draft moves it to public in place; it is never duplicated
 *  - when the shared session ends, everyone except the publisher is ejected (no parallel boards)
 *  - the publisher's board seamlessly continues as their private draft
 */
export function useWhiteboardSession(whiteboardRef: Ref<WhiteboardHandle | null>) {
  const authStore = useAuthStore();
  const roomStore = useRoomStore();

  const isWhiteboardOpen = ref(false);
  const activeWhiteboardAssetId = ref<string | null>(null);
  const currentWhiteboardJson = ref<string | undefined>(undefined);
  const whiteboardSessionKey = ref('wb_init_' + Date.now());
  const isJoiningSharedBoard = ref(false);
  const isLocalWhiteboardPublisher = ref(false);
  const isActiveWhiteboardPrivate = ref(false);
  const activeWhiteboardIsPublic = ref(false);
  const activeWhiteboardCreatorUid = ref<string | null>(null);

  const room = () => roomStore.currentRoom;
  const findMessage = (id: string | null) => (id ? room()?.messages.find(m => m.id === id) : undefined);
  const isByHost = (m: MessageItem, hostUid?: string | null) =>
    !hostUid || m.metadata?.creatorUid === hostUid || m.senderUid === hostUid;

  const resetActiveBoard = () => {
    isJoiningSharedBoard.value = false;
    isLocalWhiteboardPublisher.value = false;
    isActiveWhiteboardPrivate.value = false;
    activeWhiteboardIsPublic.value = false;
    activeWhiteboardCreatorUid.value = null;
    activeWhiteboardAssetId.value = null;
    currentWhiteboardJson.value = undefined;
  };

  const closeWhiteboard = () => {
    isWhiteboardOpen.value = false;
    resetActiveBoard();
  };

  const saveOpenBoardIfDirty = async (context: string) => {
    if (!isWhiteboardOpen.value || !whiteboardRef.value?.hasUnsavedChanges) return;
    try {
      await whiteboardRef.value.triggerAutoSaveAsAsset?.();
    } catch (e) {
      console.warn(`Auto save before ${context} error:`, e);
    }
  };

  // Session ended or converted to private: eject non-publishers, keep the publisher's board as a private draft
  watch(() => room()?.whiteboardActive, isActive => {
    if (isActive === true && room()?.whiteboardHostUid === authStore.uid && !isActiveWhiteboardPrivate.value) {
      isLocalWhiteboardPublisher.value = true;
    }
    if (isActive !== false) return;
    if (isLocalWhiteboardPublisher.value) {
      isLocalWhiteboardPublisher.value = false;
      isActiveWhiteboardPrivate.value = true;
      activeWhiteboardIsPublic.value = false;
      return;
    }
    if (isWhiteboardOpen.value && !isActiveWhiteboardPrivate.value) {
      closeWhiteboard();
      roomStore.pushToast('Collaboration Ended', 'The shared whiteboard session has ended.', 'info');
    }
  });

  // Follow privacy changes of the open asset made elsewhere (e.g. made private by its creator)
  watch(() => findMessage(activeWhiteboardAssetId.value)?.metadata?.isPrivate, isPrivate => {
    if (typeof isPrivate !== 'boolean') return;
    isActiveWhiteboardPrivate.value = isPrivate;
    activeWhiteboardIsPublic.value = !isPrivate;
  });

  const isWhiteboardSharedSession = computed(() => {
    if (isActiveWhiteboardPrivate.value) return false;
    const asset = findMessage(activeWhiteboardAssetId.value);
    if (asset?.metadata?.isPrivate) return false;
    if (!room()?.whiteboardActive) return false;
    if (isLocalWhiteboardPublisher.value || isJoiningSharedBoard.value) return true;
    return Boolean(asset && isByHost(asset, room()?.whiteboardHostUid));
  });

  const openNewWhiteboard = async () => {
    await saveOpenBoardIfDirty('new whiteboard');
    resetActiveBoard();
    isActiveWhiteboardPrivate.value = true;
    activeWhiteboardCreatorUid.value = authStore.uid;
    whiteboardSessionKey.value = 'wb_new_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
    isWhiteboardOpen.value = true;
  };

  const joinSharedWhiteboard = async () => {
    if (!room()?.whiteboardActive) {
      roomStore.pushToast('Session Ended', 'The shared whiteboard session is no longer active.', 'warning');
      return;
    }
    await saveOpenBoardIfDirty('joining shared board');
    const hostUid = room()?.whiteboardHostUid;
    const existingShared = room()?.messages.find(
      m => m.type === 'whiteboard_state' && isByHost(m, hostUid) && (m.metadata?.isSharedPost || !m.metadata?.isPrivate)
    );
    isActiveWhiteboardPrivate.value = false;
    activeWhiteboardIsPublic.value = true;
    activeWhiteboardCreatorUid.value = hostUid || null;
    isJoiningSharedBoard.value = true;
    activeWhiteboardAssetId.value = existingShared?.id || null;
    currentWhiteboardJson.value = room()?.whiteboardState || existingShared?.metadata?.whiteboardJson || undefined;
    whiteboardSessionKey.value = 'wb_shared_' + (existingShared?.id || room()?.roomId || Date.now());
    isWhiteboardOpen.value = true;
  };

  const openWhiteboardAsset = async (msg: MessageItem) => {
    if (msg.type !== 'whiteboard_state') return;
    const isMine = room()?.whiteboardHostUid === authStore.uid || msg.metadata?.creatorUid === authStore.uid || msg.senderUid === authStore.uid;
    if (msg.metadata?.isPrivate && !isMine) {
      roomStore.pushToast('Access Restricted', 'This whiteboard is set to private by its creator.', 'warning');
      return;
    }
    const isCanvasBlank = whiteboardRef.value?.isBlankCanvas?.() ?? false;
    if (isWhiteboardOpen.value && activeWhiteboardAssetId.value === msg.id && !isJoiningSharedBoard.value && !isCanvasBlank) {
      roomStore.pushToast('Whiteboard Active', 'This whiteboard is currently open.', 'info');
      return;
    }
    await saveOpenBoardIfDirty('opening asset');

    const isPrivateAsset = !!msg.metadata?.isPrivate;
    isActiveWhiteboardPrivate.value = isPrivateAsset;
    activeWhiteboardIsPublic.value = !isPrivateAsset;
    activeWhiteboardCreatorUid.value = msg.metadata?.creatorUid || msg.senderUid || null;

    const hostUid = room()?.whiteboardHostUid;
    const isThisBoardLive = !isPrivateAsset && room()?.whiteboardActive && isByHost(msg, hostUid);
    isJoiningSharedBoard.value = Boolean(isThisBoardLive);
    isLocalWhiteboardPublisher.value = Boolean(isThisBoardLive && hostUid === authStore.uid);

    activeWhiteboardAssetId.value = msg.id;
    currentWhiteboardJson.value = msg.metadata?.whiteboardJson || undefined;
    whiteboardSessionKey.value = 'wb_asset_' + msg.id + '_' + Date.now();
    isWhiteboardOpen.value = true;
  };

  // Persists the board as a whiteboard asset message. `isPrivateParam` from the component wins over local state.
  const saveWhiteboardState = async (json: string, previewUrl: string, explicitAssetId?: string | null, isPrivateParam?: boolean) => {
    let targetAssetId = explicitAssetId || activeWhiteboardAssetId.value;
    const existingMsg = findMessage(targetAssetId);
    const meta = existingMsg?.metadata;

    let isPrivate: boolean;
    if (isPrivateParam !== undefined) isPrivate = isPrivateParam;
    else if (isActiveWhiteboardPrivate.value) isPrivate = true;
    else if (activeWhiteboardIsPublic.value) isPrivate = false;
    else if (meta?.isPrivate === true) isPrivate = true;
    else if (meta?.isPrivate === false && (meta?.wasPublished || meta?.isSharedPost)) isPrivate = false;
    else isPrivate = !isWhiteboardSharedSession.value;

    isActiveWhiteboardPrivate.value = isPrivate;
    activeWhiteboardIsPublic.value = !isPrivate;

    const isShared = !isPrivate && isWhiteboardSharedSession.value;
    const hostUid = room()?.whiteboardHostUid || authStore.uid;
    const hostName = room()?.whiteboardHostName || authStore.displayName || 'Host';

    if (isShared && !targetAssetId) {
      const existingShared = room()?.messages.find(m => m.type === 'whiteboard_state' && isByHost(m, hostUid) && !m.metadata?.isPrivate);
      if (existingShared) targetAssetId = activeWhiteboardAssetId.value = existingShared.id;
    } else if (!isShared && isPrivate && targetAssetId && existingMsg && !(meta?.creatorUid === authStore.uid || existingMsg.senderUid === authStore.uid)) {
      // Editing someone else's board privately forks it into a new personal draft
      targetAssetId = activeWhiteboardAssetId.value = null;
    }

    const wasPublished = Boolean(meta?.wasPublished || !isPrivate);
    const newMeta = {
      whiteboardJson: json,
      isPrivate,
      isSharedPost: Boolean(meta?.isSharedPost || !isPrivate),
      wasPublished,
      creatorUid: meta?.creatorUid || (isShared ? hostUid : authStore.uid),
      creatorName: meta?.creatorName || (isShared ? hostName : authStore.displayName || 'Participant'),
      creatorAvatar: meta?.creatorAvatar || (isShared ? room()?.participants[hostUid]?.avatar || '🎨' : authStore.avatar || '🎨'),
      isAutoSave: true
    };
    const fileData = { type: 'image' as const, url: previewUrl, name: 'whiteboard.jpg', size: 0 };

    if (targetAssetId) {
      // Silent auto-save of an existing asset (no chat message)
      await roomStore.updateCustomMessage(targetAssetId, { fileData, metadata: newMeta });
    } else {
      const existingContent = existingMsg?.content;
      const content = isPrivate
        ? (wasPublished && existingContent && !existingContent.includes('Personal Draft') ? existingContent : 'Personal Draft')
        : `${hostName} shared a collaborative whiteboard`;
      const newId = await roomStore.sendCustomMessage({
        senderUid: authStore.uid,
        senderName: authStore.displayName || 'Participant',
        senderAvatar: authStore.avatar || '🎨',
        type: 'whiteboard_state',
        content,
        fileData,
        metadata: newMeta
      });
      if (newId) {
        targetAssetId = activeWhiteboardAssetId.value = newId;
        whiteboardRef.value?.setCurrentAssetId?.(newId);
      }
    }

    // Visual memory for the AI is only recorded for shared boards
    if (isShared) roomStore.recordWhiteboardSnapshotMemory(previewUrl, json, targetAssetId || undefined);
  };

  // Mirror which public board I am on, so others can see viewer avatars on it
  watch([isWhiteboardOpen, activeWhiteboardAssetId, isActiveWhiteboardPrivate], ([isOpen, assetId, isPrivate]) => {
    roomStore.updateParticipantWhiteboard(isOpen && assetId && !isPrivate ? assetId : null);
  }, { immediate: true });

  const isMyLiveSessionOpen = () =>
    isWhiteboardOpen.value && room()?.whiteboardActive && room()?.whiteboardHostUid === authStore.uid;

  /** Saves and ends my live session (used on page leave), or just saves a dirty board. */
  const saveBeforeLeaving = async () => {
    if (isMyLiveSessionOpen()) {
      try {
        await whiteboardRef.value?.triggerAutoSaveAsAsset?.();
        await roomStore.endWhiteboardSession();
      } catch (err) {
        console.error('Error auto-saving whiteboard on navigation leave:', err);
      }
      return;
    }
    await saveOpenBoardIfDirty('navigation leave');
  };

  return {
    isWhiteboardOpen,
    activeWhiteboardAssetId,
    currentWhiteboardJson,
    whiteboardSessionKey,
    activeWhiteboardIsPublic,
    activeWhiteboardCreatorUid,
    isWhiteboardSharedSession,
    openNewWhiteboard,
    joinSharedWhiteboard,
    openWhiteboardAsset,
    saveWhiteboardState,
    closeWhiteboard,
    isMyLiveSessionOpen,
    saveBeforeLeaving
  };
}

/** Drag handle between chat and whiteboard; dragging to the right edge requests closing the board. */
export function useWhiteboardResize(whiteboardRef: Ref<WhiteboardHandle | null>, isOpen: Ref<boolean>) {
  const whiteboardWidth = ref<number | null>(null);
  const isResizingWhiteboard = ref(false);

  watch(isOpen, open => {
    if (open && (whiteboardWidth.value === null || whiteboardWidth.value > window.innerWidth - 320)) {
      whiteboardWidth.value = Math.max(500, window.innerWidth - 360);
    }
  });

  const startWhiteboardResize = (e: MouseEvent) => {
    e.preventDefault();
    isResizingWhiteboard.value = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMouseMove = (moveEvent: MouseEvent) => {
      const remainingFromRight = window.innerWidth - moveEvent.clientX;
      if (remainingFromRight < 120) {
        stopResize();
        whiteboardRef.value?.handleCloseRequest?.();
        return;
      }
      const maxW = Math.max(300, window.innerWidth - 240);
      whiteboardWidth.value = Math.max(300, Math.min(maxW, remainingFromRight));
    };
    const stopResize = () => {
      isResizingWhiteboard.value = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', stopResize);
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', stopResize);
  };

  return { whiteboardWidth, isResizingWhiteboard, startWhiteboardResize };
}
