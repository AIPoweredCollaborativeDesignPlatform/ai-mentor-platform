import { marked } from 'marked';
import DOMPurify from 'dompurify';
import type { MessageItem } from '../types';

export const AI_TYPING_UIDS = ['ai_mentor', 'ai_mentor_3d'];

/** Renders chat text as sanitized HTML; inline markdown for plain messages, block markdown for structured ones. */
export function formatMessageText(text: string): string {
  if (!text) return '';
  const hasMarkdownBlocks = /^(?:#{1,6}\s|```|[-*+]\s|\d+\.\s|>\s|\|)/m.test(text) || text.includes('\n\n');
  const rawHtml = hasMarkdownBlocks
    ? (marked.parse(text, { breaks: true, gfm: true }) as string).trim()
    : (marked.parseInline(text, { breaks: true, gfm: true }) as string);
  const styledHtml = rawHtml.replace(
    /<a href="/g,
    '<a target="_blank" rel="noopener noreferrer" class="text-sky-400 hover:underline font-semibold pointer-events-auto" data-link="true" href="'
  );
  return DOMPurify.sanitize(styledHtml, { ADD_ATTR: ['target', 'data-link'] });
}

export interface MentionTarget {
  name: string;
  kind: 'me' | 'ai' | 'member';
}

const MENTION_CLASS: Record<MentionTarget['kind'], string> = {
  me: 'mention mention-me',
  ai: 'mention mention-ai',
  member: 'mention mention-member'
};
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Wraps "@Name" of known people (longest names first) in a coloured span; tags and attributes are left alone. */
export function highlightMentions(html: string, targets: MentionTarget[]): string {
  const list = targets.filter(t => t.name?.trim()).sort((a, b) => b.name.length - a.name.length);
  if (!list.length || !html.includes('@')) return html;
  const byName = new Map(list.map(t => [t.name.toLowerCase(), t]));
  const re = new RegExp(`@(${list.map(t => escapeRegex(t.name)).join('|')})`, 'gi');
  return html.split(/(<[^>]+>)/).map(part =>
    part.startsWith('<') ? part : part.replace(re, (m, name) => `<span class="${MENTION_CLASS[byName.get(String(name).toLowerCase())?.kind || 'member']}">${m}</span>`)
  ).join('');
}

export function isMentioning(msg: MessageItem, displayName: string, uid: string): boolean {
  if (!msg?.content || !displayName) return false;
  const content = msg.content.toLowerCase();
  return content.includes(`@${displayName.toLowerCase().trim()}`) || content.includes(`@${uid.toLowerCase()}`);
}

export const formatTime = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export function formatDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
}

export function formatTypingText(users: { displayName: string }[]): string {
  if (users.length === 1) return `${users[0].displayName} is typing...`;
  if (users.length === 2) return `${users[0].displayName} and ${users[1].displayName} are typing...`;
  return `${users[0].displayName} and ${users.length - 1} others are typing...`;
}

/** Old versions created extra whiteboard "pointer" messages referencing the real asset via metadata.assetId. */
export const isDuplicateBoardPointer = (m: MessageItem, all: MessageItem[]) =>
  Boolean(m.metadata?.assetId && all.some(other => other.id === m.metadata.assetId));

export const isOwnBoard = (m: MessageItem, uid: string) => m.metadata?.creatorUid === uid || m.senderUid === uid;
