// Googlechat plugin module implements monitor reply target behavior.
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";

export function normalizeGoogleChatReplyTarget(params: {
  payload: ReplyPayload;
  sourceMessageName?: string;
  replyThreadName?: string;
}): ReplyPayload {
  const sourceMessageName = params.sourceMessageName;
  const implicitReply =
    params.payload.replyToId === undefined && params.payload.replyToCurrent !== false;
  if (!implicitReply && (!sourceMessageName || params.payload.replyToId !== sourceMessageName)) {
    return params.payload;
  }
  return { ...params.payload, replyToId: params.replyThreadName };
}
