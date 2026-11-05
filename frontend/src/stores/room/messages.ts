import { addDoc, updateDoc } from 'firebase/firestore';
import type { MessageItem } from '../../types';
import { roomCollection, roomDocRef, roomRef, stripUndefined, tempId, type RoomContext } from './context';
import { t } from '../../i18n';

type PollVote = { uid: string; name: string; avatar: string; option: string };

interface PostOptions {
  /** Text shown in the room's `lastMessage` preview; omit to leave the preview untouched. */
  preview?: string;
  failToast?: [title: string, description: string];
}

export function useRoomMessages(ctx: RoomContext, setMyTyping: (typing: boolean) => Promise<void>) {
  const { currentRoom, authStore, pushToast } = ctx;

  const touchRoom = (preview: string, sender: { name: string; uid: string }, extra: Record<string, any> = {}) => {
    if (!currentRoom.value) return Promise.resolve();
    return updateDoc(roomRef(currentRoom.value.roomId), {
      lastActive: Date.now(),
      lastMessage: { content: preview, senderName: sender.name, senderUid: sender.uid, timestamp: Date.now() },
      ...extra
    });
  };

  /** Optimistically renders a message from the current user, then persists it. Returns the Firestore id. */
  const postMessage = async (fields: Partial<MessageItem>, opts: PostOptions = {}): Promise<string | undefined> => {
    if (!currentRoom.value) return undefined;
    await setMyTyping(false);

    const msg: MessageItem = {
      id: tempId(),
      senderUid: authStore.uid,
      senderName: authStore.displayName,
      senderAvatar: authStore.avatar,
      type: 'text',
      content: '',
      timestamp: Date.now(),
      status: 'sending',
      ...fields
    } as MessageItem;
    currentRoom.value.messages.push(msg);

    try {
      const { status, id, ...payload } = msg;
      const ref = await addDoc(roomCollection(currentRoom.value.roomId, 'messages'), payload);
      msg.status = 'delivered';
      msg.id = ref.id;
      if (opts.preview !== undefined) {
        touchRoom(opts.preview, { name: authStore.displayName, uid: authStore.uid }).catch(() => {});
      }
      return ref.id;
    } catch (e) {
      console.warn('[Firestore] postMessage error:', e);
      msg.status = 'failed';
      if (opts.failToast) pushToast(opts.failToast[0], opts.failToast[1], 'error');
      return undefined;
    }
  };

  const sendCustomMessage = (customPayload: Partial<MessageItem>) => postMessage(customPayload);

  const sendTextMessage = (text: string, replyTo?: { id: string; senderName: string; text: string }) =>
    postMessage(
      { content: text.trim(), ...(replyTo ? { replyTo } : {}) },
      { preview: text.trim().slice(0, 100), failToast: [t('msg.sendFailedTitle'), t('msg.sendFailedText')] }
    );

  const sendFileMessage = async (
    fileData: { name: string; size: number; type: 'image' | 'video' | 'document'; url: string; mimeType?: string },
    caption = ''
  ) => {
    await postMessage(
      { type: 'file', content: caption || '', fileData },
      {
        preview: caption ? caption.slice(0, 100) : `📎 ${fileData.name}`,
        failToast: [t('msg.attachErrorTitle'), t('msg.attachErrorText')]
      }
    );
  };

  const retrySendMessage = async (msg: MessageItem) => {
    if (!currentRoom.value) return;
    msg.status = 'sending';
    try {
      const { status, id, ...payload } = msg;
      await addDoc(roomCollection(currentRoom.value.roomId, 'messages'), payload);
      msg.status = 'delivered';
      pushToast(t('msg.sentTitle'), t('msg.sentText'), 'success');
    } catch (e) {
      msg.status = 'failed';
      pushToast(t('toast.retryFailed'), t('msg.retryFailedText'), 'error');
    }
  };


  /** Applies updates locally and in Firestore. `timestamp` is only changed when explicitly provided. */
  const updateCustomMessage = async (messageId: string, updates: Partial<MessageItem>) => {
    if (!currentRoom.value) return;
    try {
      await updateDoc(roomDocRef(currentRoom.value.roomId, 'messages', messageId), stripUndefined(updates));
      const localMsg = currentRoom.value.messages.find(m => m.id === messageId);
      if (localMsg) Object.assign(localMsg, updates);
    } catch (e) {
      console.warn('Failed to update custom message:', e);
    }
  };

  /** Optimistic local patch followed by a Firestore write of the same fields. */
  const patchMessage = async (msg: MessageItem, fields: Partial<MessageItem>) => {
    Object.assign(msg, fields);
    try {
      await updateDoc(roomDocRef(currentRoom.value!.roomId, 'messages', msg.id), fields);
    } catch (e) {
      console.warn('Failed to update message in Firestore:', e);
    }
  };

  const findMessage = (messageId: string) =>
    currentRoom.value && authStore.uid ? currentRoom.value.messages.find(m => m.id === messageId) : undefined;

  const myVote = (option: string): PollVote => ({
    uid: authStore.uid,
    name: authStore.displayName || t('common.participant'),
    avatar: authStore.avatar || '🦊',
    option
  });

  // One emoji per user per message; clicking the selected emoji again clears it
  const toggleMessageReaction = async (messageId: string, emoji: string) => {
    const msg = findMessage(messageId);
    if (!msg) return;
    const myUid = authStore.uid;
    const reactions: Record<string, string[]> = {};
    for (const [key, uids] of Object.entries(msg.reactions || {})) {
      const rest = (uids || []).filter(uid => uid !== myUid);
      if (rest.length) reactions[key] = rest;
    }
    const alreadySelected = msg.reactions?.[emoji]?.includes(myUid);
    if (!alreadySelected) reactions[emoji] = [...(reactions[emoji] || []), myUid];
    await patchMessage(msg, { reactions });
  };

  // Voting the same option again cancels the vote; another option changes it
  const votePollOption = async (messageId: string, option: string) => {
    const msg = findMessage(messageId);
    if (!msg) return;
    const pollVotes: Record<string, PollVote> = { ...(msg.pollVotes || {}) };
    if (pollVotes[authStore.uid]?.option === option) delete pollVotes[authStore.uid];
    else pollVotes[authStore.uid] = myVote(option);
    await patchMessage(msg, { pollVotes });
  };

  // AI suggestion card: one answer per person (a new click replaces it); written by path so two
  // people answering at once do not overwrite each other
  const answerSuggestion = async (messageId: string, choice: 'accept' | 'decline') => {
    const msg = findMessage(messageId);
    if (!msg?.suggestion) return;
    const answer = { uid: authStore.uid, name: authStore.displayName || t('common.participant'), choice, at: Date.now() };
    msg.suggestion = { ...msg.suggestion, responses: { ...(msg.suggestion.responses || {}), [authStore.uid]: answer } };
    try {
      await updateDoc(roomDocRef(currentRoom.value!.roomId, 'messages', msg.id), { [`suggestion.responses.${authStore.uid}`]: answer });
    } catch (e) {
      console.warn('Failed to answer suggestion:', e);
    }
  };

  // Moodboard collage: one image's position, written by path so two people arranging at once both land
  const arrangeCollage = async (messageId: string, index: number, pos: { x: number; y: number; w: number; z: number }) => {
    const msg = findMessage(messageId);
    if (!msg) return;
    const entry = { ...pos, by: authStore.uid, at: Date.now() };
    msg.collage = { ...(msg.collage || {}), [index]: entry };
    try {
      await updateDoc(roomDocRef(currentRoom.value!.roomId, 'messages', msg.id), { [`collage.${index}`]: entry });
    } catch (e) {
      console.warn('Failed to arrange collage:', e);
    }
  };

  const addCustomPollOption = async (messageId: string, customOption: string) => {
    const cleanOption = customOption.trim();
    const msg = cleanOption ? findMessage(messageId) : undefined;
    if (!msg) return;
    const options = Array.isArray(msg.actionOptions) ? [...msg.actionOptions] : [];
    if (!options.includes(cleanOption)) options.push(cleanOption);
    const pollVotes = { ...(msg.pollVotes || {}), [authStore.uid]: myVote(cleanOption) };
    await patchMessage(msg, { actionOptions: options, pollVotes });
  };

  return {
    sendTextMessage,
    sendCustomMessage,
    sendFileMessage,
    retrySendMessage,
    updateCustomMessage,
    toggleMessageReaction,
    votePollOption,
    answerSuggestion,
    arrangeCollage,
    addCustomPollOption
  };
}
