import { ref, watch, type Ref } from 'vue';
import { useAuthStore } from '../stores/auth';
import { useRoomStore } from '../stores/room';
import type { MessageItem } from '../types';
import { isOwnBoard } from '../utils/chat';

/** Methods exposed by the whiteboard component that the room view relies on. */
export interface WhiteboardHandle {
  /** Writes the latest thumbnail before the board closes or the page is left. */
  flush?: () => Promise<void> | void;
  handleCloseRequest?: () => void;
}

const newBoardId = () => `wb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

/**
 * Which board is open in the room view. Rules (user requirements):
 *  - a new board starts as a private draft; sharing it moves the same card to public (never duplicated)
 *  - public boards are collaborative for everyone; closing a board never closes it for anyone else
 *  - when a creator makes a board private, everyone else viewing it is ejected
 */
export function useWhiteboardSession(whiteboardRef: Ref<WhiteboardHandle | null>) {
  const authStore = useAuthStore();
  const roomStore = useRoomStore();

  const isWhiteboardOpen = ref(false);
  const activeBoardId = ref<string | null>(null);
  const whiteboardSessionKey = ref('wb_init');

  const findMessage = (id: string | null) => (id ? roomStore.currentRoom?.messages.find(m => m.id === id) : undefined);

  const flushOpenBoard = async () => {
    if (!isWhiteboardOpen.value) return;
    try {
      await whiteboardRef.value?.flush?.();
    } catch (e) {
      console.warn('Whiteboard flush error:', e);
    }
  };

  const open = (boardId: string) => {
    activeBoardId.value = boardId;
    whiteboardSessionKey.value = `wb_${boardId}_${Date.now()}`;
    isWhiteboardOpen.value = true;
  };

  const closeWhiteboard = () => {
    isWhiteboardOpen.value = false;
    activeBoardId.value = null;
  };

  const openNewWhiteboard = async () => {
    await flushOpenBoard();
    open(newBoardId());
  };

  const openWhiteboardAsset = async (msg: MessageItem) => {
    if (msg.type !== 'whiteboard_state') return;
    if (msg.metadata?.isPrivate && !isOwnBoard(msg, authStore.uid)) {
      roomStore.pushToast('Access Restricted', 'This whiteboard is set to private by its creator.', 'warning');
      return;
    }
    if (isWhiteboardOpen.value && activeBoardId.value === msg.id) {
      roomStore.pushToast('Whiteboard Active', 'This whiteboard is currently open.', 'info');
      return;
    }
    await flushOpenBoard();
    open(msg.id);
  };

  // Made private by its creator while I am viewing it → leave
  watch(() => findMessage(activeBoardId.value)?.metadata?.isPrivate, isPrivate => {
    const msg = findMessage(activeBoardId.value);
    if (isPrivate && msg && !isOwnBoard(msg, authStore.uid) && isWhiteboardOpen.value) {
      closeWhiteboard();
      roomStore.pushToast('Board Made Private', 'The creator made this whiteboard private.', 'info');
    }
  });

  // Mirror which public board I am on, so others can see viewer avatars on it
  watch([isWhiteboardOpen, activeBoardId, () => findMessage(activeBoardId.value)?.metadata?.isPrivate], ([isOpen, id, isPrivate]) => {
    roomStore.updateParticipantWhiteboard(isOpen && id && isPrivate === false ? id : null);
  }, { immediate: true });

  return {
    isWhiteboardOpen,
    activeBoardId,
    whiteboardSessionKey,
    openNewWhiteboard,
    openWhiteboardAsset,
    closeWhiteboard,
    saveBeforeLeaving: flushOpenBoard
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
