// The shell's reading of the server's conversations (server/src/http/conversation-routes.ts). Reads only; a failure is a sentence.

import { CONVERSATION_API } from '@conduit/language';
import type { ConversationSummary, ConversationView } from '@conduit/language';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isSummary(value: unknown): value is ConversationSummary {
  return isObject(value) && typeof value['id'] === 'string' && typeof value['session'] === 'string' && typeof value['title'] === 'string' && typeof value['started'] === 'string' && typeof value['updated'] === 'string' && typeof value['turns'] === 'number';
}

function isView(value: unknown): value is ConversationView {
  return isObject(value) && isSummary(value['summary']) && Array.isArray(value['turns']);
}

async function get(url: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { headers: { accept: 'application/json' } });
  } catch (cause) {
    throw new Error('The server cannot be reached.', { cause });
  }
  if (!response.ok) throw new Error(response.status === 404 ? 'That conversation is not there any more.' : `The server could not give the conversation (${response.status}).`);
  return response.json().catch(() => null);
}

export async function listConversations(): Promise<readonly ConversationSummary[]> {
  const body = await get(CONVERSATION_API.list);
  if (!Array.isArray(body)) throw new Error('The server answered with something that is not a list of conversations.');
  return body.filter(isSummary);
}

export async function readConversation(id: string): Promise<ConversationView> {
  const body = await get(CONVERSATION_API.one(id));
  if (!isView(body)) throw new Error('The server answered with something that is not a conversation.');
  return body;
}
