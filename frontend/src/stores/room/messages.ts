import { addDoc, increment, updateDoc } from 'firebase/firestore';
import type { MessageItem } from '../../types';
import { roomCollection, roomDocRef, roomRef, stripUndefined, tempId, type RoomContext } from './context';

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
      { preview: text.trim().slice(0, 100), failToast: ['Send Failed', 'Could not sync message to server. Click to retry.'] }
    );

  const sendFileMessage = async (
    fileData: { name: string; size: number; type: 'image' | 'video' | 'document'; url: string; mimeType?: string },
    caption = ''
  ) => {
    await postMessage(
      { type: 'file', content: caption || '', fileData },
      {
        preview: caption ? caption.slice(0, 100) : `📎 ${fileData.name}`,
        failToast: ['Attachment Error', 'Attachment could not be saved to room database.']
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
      pushToast('Sent', 'Message delivered successfully.', 'success');
    } catch (e) {
      msg.status = 'failed';
      pushToast('Retry Failed', 'Still unable to reach database. Check your network.', 'error');
    }
  };

  /** Posts a message authored by the system (not the current user); no optimistic rendering. */
  const postSystemMessage = (content: string, senderAvatar: string) => {
    if (!currentRoom.value) return Promise.resolve();
    return addDoc(roomCollection(currentRoom.value.roomId, 'messages'), {
      senderUid: 'system',
      senderName: 'System',
      senderAvatar,
      type: 'text',
      content,
      timestamp: Date.now()
    });
  };

  /** `aiMeta` (model, prompt version, token usage) is kept on the message for the research log. */
  const addAiMessage = async (content: string, assetType?: any, assetPayload?: any, actionOptions?: string[], aiMeta?: unknown) => {
    if (!currentRoom.value) return;
    const aiMsg: MessageItem = {
      id: tempId('ai'),
      senderUid: 'ai_mentor',
      senderName: 'AI Mentor',
      senderAvatar: '✨',
      type: assetType ? 'ai_asset' : 'text',
      content,
      actionOptions: actionOptions || [],
      timestamp: Date.now(),
      assetType,
      assetPayload,
      ...(aiMeta ? { metadata: { ai: aiMeta } } : {}),
      status: 'delivered'
    };
    // Render immediately so the AI response appears without waiting for the snapshot
    currentRoom.value.messages.push(aiMsg);

    try {
      const { id, status, ...rawPayload } = aiMsg;
      const ref = await addDoc(roomCollection(currentRoom.value.roomId, 'messages'), stripUndefined(rawPayload));
      aiMsg.id = ref.id;
      const preview = assetType
        ? (assetType === 'parametric_3d' || assetType === 'mesh_3d' ? '🎨 3D Model Generated' : '✨ AI Asset Generated')
        : content.slice(0, 100);
      await touchRoom(preview, { name: 'AI Mentor', uid: 'ai_mentor' }, assetType ? { assetsCount: increment(1) } : {});
    } catch (e) {
      console.warn('[AI Message] Firestore addDoc failed:', e);
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
    name: authStore.displayName || 'Participant',
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
    postSystemMessage,
    sendTextMessage,
    sendCustomMessage,
    sendFileMessage,
    retrySendMessage,
    addAiMessage,
    updateCustomMessage,
    toggleMessageReaction,
    votePollOption,
    addCustomPollOption
  };
}
