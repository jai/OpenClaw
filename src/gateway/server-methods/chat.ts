import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { proto } from "@whiskeysockets/baileys";
import { CURRENT_SESSION_VERSION } from "@mariozechner/pi-coding-agent";
import type { Bot } from "grammy";
import { resolveDefaultAgentId, resolveSessionAgentId } from "../../agents/agent-scope.js";
import { resolveEffectiveMessagesConfig, resolveIdentityName } from "../../agents/identity.js";
import { resolveThinkingDefault } from "../../agents/model-selection.js";
import { resolveAgentTimeoutMs } from "../../agents/timeout.js";
import { dispatchInboundMessage } from "../../auto-reply/dispatch.js";
import { getReplyFromConfig } from "../../auto-reply/reply.js";
import { DEFAULT_GROUP_HISTORY_LIMIT } from "../../auto-reply/reply/history.js";
import { createReplyDispatcher } from "../../auto-reply/reply/reply-dispatcher.js";
import {
  extractShortModelName,
  type ResponsePrefixContext,
} from "../../auto-reply/reply/response-prefix-template.js";
import type { FinalizedMsgContext, MsgContext } from "../../auto-reply/templating.js";
import { formatLocationText } from "../../channels/location.js";
import { loadConfig } from "../../config/config.js";
import type { DmPolicy, GroupPolicy } from "../../config/types.base.js";
import { resolveChannelGroupRequireMention } from "../../config/group-policy.js";
import { loadSessionStore, resolveStorePath } from "../../config/sessions.js";
import { registerAgentRunContext } from "../../infra/agent-events.js";
import { getChildLogger } from "../../logging.js";
import { resolveAgentRoute } from "../../routing/resolve-route.js";
import { DEFAULT_ACCOUNT_ID, buildGroupHistoryKey } from "../../routing/session-key.js";
import { resolveSendPolicy } from "../../sessions/send-policy.js";
import { resolveTelegramAccount } from "../../telegram/accounts.js";
import { buildTelegramMessageContext } from "../../telegram/bot-message-context.js";
import { buildTelegramGroupPeerId } from "../../telegram/bot/helpers.js";
import type { TelegramMessage } from "../../telegram/bot/types.js";
import { readTelegramAllowFromStore } from "../../telegram/pairing-store.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import { normalizeE164 } from "../../utils.js";
import { resolveWhatsAppAccount } from "../../web/accounts.js";
import { DEFAULT_WEB_MEDIA_BYTES } from "../../web/auto-reply/constants.js";
import { createEchoTracker } from "../../web/auto-reply/monitor/echo.js";
import { applyGroupGating } from "../../web/auto-reply/monitor/group-gating.js";
import { resolvePeerId } from "../../web/auto-reply/monitor/peer.js";
import { processMessage } from "../../web/auto-reply/monitor/process-message.js";
import { buildMentionConfig } from "../../web/auto-reply/mentions.js";
import type { WebInboundMsg } from "../../web/auto-reply/types.js";
import { checkInboundAccessControl } from "../../web/inbound/access-control.js";
import {
  describeReplyContext,
  extractLocationData,
  extractMediaPlaceholder,
  extractMentionedJids,
  extractText,
} from "../../web/inbound/extract.js";
import {
  abortChatRunById,
  abortChatRunsForSessionKey,
  isChatStopCommandText,
  resolveChatRunExpiresAtMs,
} from "../chat-abort.js";
import { type ChatImageContent, parseMessageWithAttachments } from "../chat-attachments.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateChatAbortParams,
  validateChatHistoryParams,
  validateChatIngressParams,
  validateChatInjectParams,
  validateChatSendParams,
} from "../protocol/index.js";
import { getMaxChatHistoryMessagesBytes } from "../server-constants.js";
import {
  capArrayByJsonBytes,
  loadSessionEntry,
  readSessionMessages,
  resolveSessionModelRef,
} from "../session-utils.js";
import { stripEnvelopeFromMessages } from "../chat-sanitize.js";
import { formatForLog } from "../ws-log.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "./types.js";

type TranscriptAppendResult = {
  ok: boolean;
  messageId?: string;
  message?: Record<string, unknown>;
  error?: string;
};

function resolveTranscriptPath(params: {
  sessionId: string;
  storePath: string | undefined;
  sessionFile?: string;
}): string | null {
  const { sessionId, storePath, sessionFile } = params;
  if (sessionFile) return sessionFile;
  if (!storePath) return null;
  return path.join(path.dirname(storePath), `${sessionId}.jsonl`);
}

function ensureTranscriptFile(params: { transcriptPath: string; sessionId: string }): {
  ok: boolean;
  error?: string;
} {
  if (fs.existsSync(params.transcriptPath)) return { ok: true };
  try {
    fs.mkdirSync(path.dirname(params.transcriptPath), { recursive: true });
    const header = {
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: params.sessionId,
      timestamp: new Date().toISOString(),
      cwd: process.cwd(),
    };
    fs.writeFileSync(params.transcriptPath, `${JSON.stringify(header)}\n`, "utf-8");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function appendAssistantTranscriptMessage(params: {
  message: string;
  label?: string;
  sessionId: string;
  storePath: string | undefined;
  sessionFile?: string;
  createIfMissing?: boolean;
}): TranscriptAppendResult {
  const transcriptPath = resolveTranscriptPath({
    sessionId: params.sessionId,
    storePath: params.storePath,
    sessionFile: params.sessionFile,
  });
  if (!transcriptPath) {
    return { ok: false, error: "transcript path not resolved" };
  }

  if (!fs.existsSync(transcriptPath)) {
    if (!params.createIfMissing) {
      return { ok: false, error: "transcript file not found" };
    }
    const ensured = ensureTranscriptFile({
      transcriptPath,
      sessionId: params.sessionId,
    });
    if (!ensured.ok) {
      return { ok: false, error: ensured.error ?? "failed to create transcript file" };
    }
  }

  const now = Date.now();
  const messageId = randomUUID().slice(0, 8);
  const labelPrefix = params.label ? `[${params.label}]\n\n` : "";
  const messageBody: Record<string, unknown> = {
    role: "assistant",
    content: [{ type: "text", text: `${labelPrefix}${params.message}` }],
    timestamp: now,
    stopReason: "injected",
    usage: { input: 0, output: 0, totalTokens: 0 },
  };
  const transcriptEntry = {
    type: "message",
    id: messageId,
    timestamp: new Date(now).toISOString(),
    message: messageBody,
  };

  try {
    fs.appendFileSync(transcriptPath, `${JSON.stringify(transcriptEntry)}\n`, "utf-8");
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  return { ok: true, messageId, message: transcriptEntry.message };
}

function nextChatSeq(context: { agentRunSeq: Map<string, number> }, runId: string) {
  const next = (context.agentRunSeq.get(runId) ?? 0) + 1;
  context.agentRunSeq.set(runId, next);
  return next;
}

function broadcastChatFinal(params: {
  context: Pick<GatewayRequestContext, "broadcast" | "nodeSendToSession" | "agentRunSeq">;
  runId: string;
  sessionKey: string;
  message?: Record<string, unknown>;
}) {
  const seq = nextChatSeq({ agentRunSeq: params.context.agentRunSeq }, params.runId);
  const payload = {
    runId: params.runId,
    sessionKey: params.sessionKey,
    seq,
    state: "final" as const,
    message: params.message,
  };
  params.context.broadcast("chat", payload);
  params.context.nodeSendToSession(params.sessionKey, "chat", payload);
}

function broadcastChatError(params: {
  context: Pick<GatewayRequestContext, "broadcast" | "nodeSendToSession" | "agentRunSeq">;
  runId: string;
  sessionKey: string;
  errorMessage?: string;
}) {
  const seq = nextChatSeq({ agentRunSeq: params.context.agentRunSeq }, params.runId);
  const payload = {
    runId: params.runId,
    sessionKey: params.sessionKey,
    seq,
    state: "error" as const,
    errorMessage: params.errorMessage,
  };
  params.context.broadcast("chat", payload);
  params.context.nodeSendToSession(params.sessionKey, "chat", payload);
}

type ChatIngressResult = {
  runId: string;
  status: "accepted" | "blocked";
  sessionKey?: string;
  summary?: string;
  meta?: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function buildIngressMeta(ctx: FinalizedMsgContext): Record<string, unknown> {
  return {
    rawBody: ctx.RawBody,
    body: ctx.Body,
    commandAuthorized: ctx.CommandAuthorized,
    forwardedFrom: ctx.ForwardedFrom,
    forwardedFromType: ctx.ForwardedFromType,
    forwardedFromId: ctx.ForwardedFromId,
    forwardedFromUsername: ctx.ForwardedFromUsername,
    forwardedFromTitle: ctx.ForwardedFromTitle,
    forwardedFromSignature: ctx.ForwardedFromSignature,
    forwardedDate: ctx.ForwardedDate,
    chatType: ctx.ChatType,
    senderId: ctx.SenderId,
    senderE164: ctx.SenderE164,
    groupSubject: ctx.GroupSubject,
    wasMentioned: ctx.WasMentioned,
  };
}

function createIngressDispatcher(context: Pick<GatewayRequestContext, "logGateway">) {
  return createReplyDispatcher({
    deliver: async () => {},
    onError: (err) => {
      context.logGateway.warn(`ingress dispatch failed: ${formatForLog(err)}`);
    },
  });
}

async function handleTelegramIngress(params: {
  cfg: ReturnType<typeof loadConfig>;
  runId: string;
  payload: unknown;
  accountId?: string;
  verbose?: boolean;
  context: Pick<GatewayRequestContext, "logGateway">;
}): Promise<ChatIngressResult> {
  const payload = isRecord(params.payload) ? params.payload : {};
  const update = isRecord(payload.update) ? payload.update : undefined;
  const callbackQuery = isRecord(payload.callback_query)
    ? payload.callback_query
    : update && isRecord(update) && isRecord(update.callback_query)
      ? update.callback_query
      : undefined;
  const messageCandidate =
    (payload.message && isRecord(payload.message) ? payload.message : undefined) ??
    (update && isRecord(update) && isRecord(update.message) ? update.message : undefined) ??
    (update && isRecord(update) && isRecord(update.edited_message) ? update.edited_message : undefined) ??
    (update && isRecord(update) && isRecord(update.channel_post) ? update.channel_post : undefined) ??
    (update && isRecord(update) && isRecord(update.edited_channel_post)
      ? update.edited_channel_post
      : undefined);
  const me = isRecord(payload.me) ? payload.me : undefined;
  const getFile = async () => ({});

  const options: { forceWasMentioned?: boolean; messageIdOverride?: string } = {};
  let message = messageCandidate;
  if (callbackQuery && isRecord(callbackQuery)) {
    const data = typeof callbackQuery.data === "string" ? callbackQuery.data.trim() : "";
    const callbackMessage = isRecord(callbackQuery.message) ? callbackQuery.message : undefined;
    if (data && callbackMessage) {
      const from = isRecord(callbackQuery.from) ? callbackQuery.from : callbackMessage.from;
      message = {
        ...callbackMessage,
        from,
        text: data,
        caption: undefined,
        caption_entities: undefined,
        entities: undefined,
      };
      options.forceWasMentioned = true;
      if (typeof callbackQuery.id === "string" && callbackQuery.id.trim()) {
        options.messageIdOverride = callbackQuery.id;
      }
    }
  }

  if (!message) {
    return {
      runId: params.runId,
      status: "blocked",
      summary: "telegram payload missing message",
    };
  }

  const resolvedAccountId =
    typeof params.accountId === "string" && params.accountId.trim()
      ? params.accountId.trim()
      : typeof payload.accountId === "string" && payload.accountId.trim()
        ? payload.accountId.trim()
        : DEFAULT_ACCOUNT_ID;
  const account = resolveTelegramAccount({
    cfg: params.cfg,
    accountId: resolvedAccountId,
  });
  const telegramCfg = account.config;
  const storeAllowFrom = await readTelegramAllowFromStore().catch(() => []);
  const allowFrom = Array.isArray(payload.allowFrom)
    ? payload.allowFrom.filter(
        (entry): entry is string | number => typeof entry === "string" || typeof entry === "number",
      )
    : telegramCfg.allowFrom;
  const groupAllowFrom = Array.isArray(payload.groupAllowFrom)
    ? payload.groupAllowFrom.filter(
        (entry): entry is string | number => typeof entry === "string" || typeof entry === "number",
      )
    : telegramCfg.groupAllowFrom ??
      (telegramCfg.allowFrom && telegramCfg.allowFrom.length > 0 ? telegramCfg.allowFrom : undefined);
  const dmPolicy =
    typeof payload.dmPolicy === "string" &&
    (payload.dmPolicy === "pairing" ||
      payload.dmPolicy === "allowlist" ||
      payload.dmPolicy === "open" ||
      payload.dmPolicy === "disabled")
      ? (payload.dmPolicy as DmPolicy)
      : telegramCfg.dmPolicy ?? "pairing";
  const historyLimit = Math.max(
    0,
    telegramCfg.historyLimit ??
      params.cfg.messages?.groupChat?.historyLimit ??
      DEFAULT_GROUP_HISTORY_LIMIT,
  );
  const groupHistories = new Map();
  const bot = {
    api: {
      sendChatAction: async () => {},
      setMessageReaction: async () => {},
    },
  } as unknown as Bot;
  const logger = {
    info: () => {},
  };
  const resolveGroupActivation = (activationParams: {
    chatId: string | number;
    agentId?: string;
    messageThreadId?: number;
    sessionKey?: string;
  }) => {
    const agentId = activationParams.agentId ?? resolveDefaultAgentId(params.cfg);
    const sessionKey =
      activationParams.sessionKey ??
      `agent:${agentId}:telegram:group:${buildTelegramGroupPeerId(
        activationParams.chatId,
        activationParams.messageThreadId,
      )}`;
    const storePath = resolveStorePath(params.cfg.session?.store, { agentId });
    try {
      const store = loadSessionStore(storePath);
      const entry = store[sessionKey];
      if (entry?.groupActivation === "always") return false;
      if (entry?.groupActivation === "mention") return true;
    } catch {
      return undefined;
    }
    return undefined;
  };
  const resolveGroupRequireMention = (chatId: string | number) =>
    resolveChannelGroupRequireMention({
      cfg: params.cfg,
      channel: "telegram",
      accountId: account.accountId,
      groupId: String(chatId),
    });
  const resolveTelegramGroupConfig = (chatId: string | number, messageThreadId?: number) => {
    const groups = telegramCfg.groups;
    if (!groups) return { groupConfig: undefined, topicConfig: undefined };
    const groupKey = String(chatId);
    const groupConfig = groups[groupKey] ?? groups["*"];
    const topicConfig =
      messageThreadId != null ? groupConfig?.topics?.[String(messageThreadId)] : undefined;
    return { groupConfig, topicConfig };
  };

  let context: Awaited<ReturnType<typeof buildTelegramMessageContext>> | null = null;
  try {
    context = await buildTelegramMessageContext({
      primaryCtx: {
        message: message as unknown as TelegramMessage,
        me,
        getFile,
      },
      allMedia: [],
      storeAllowFrom,
      options,
      bot,
      cfg: params.cfg,
      account: { accountId: account.accountId },
      historyLimit,
      groupHistories,
      dmPolicy,
      allowFrom,
      groupAllowFrom,
      ackReactionScope: "off",
      logger,
      resolveGroupActivation,
      resolveGroupRequireMention,
      resolveTelegramGroupConfig,
    });
  } catch (err) {
    return {
      runId: params.runId,
      status: "blocked",
      summary: `telegram ingress failed: ${formatForLog(err)}`,
    };
  }

  if (!context) {
    return {
      runId: params.runId,
      status: "blocked",
      summary: "telegram message blocked by channel policy",
    };
  }

  const ctxPayload = context.ctxPayload;
  const sessionKey = ctxPayload.SessionKey ?? context.route.sessionKey;
  if (sessionKey) {
    registerAgentRunContext(params.runId, {
      sessionKey,
      ...(params.verbose !== undefined
        ? { verboseLevel: params.verbose ? "on" : "off" }
        : {}),
    });
  }

  const dispatcher = createIngressDispatcher(params.context);
  void dispatchInboundMessage({
    ctx: ctxPayload,
    cfg: params.cfg,
    dispatcher,
    replyOptions: {
      runId: params.runId,
      disableBlockStreaming: true,
    },
  }).catch((err) => {
    params.context.logGateway.warn(`telegram ingress dispatch failed: ${formatForLog(err)}`);
  });

  return {
    runId: params.runId,
    status: "accepted",
    sessionKey,
    meta: buildIngressMeta(ctxPayload),
  };
}

async function handleWhatsAppIngress(params: {
  cfg: ReturnType<typeof loadConfig>;
  runId: string;
  payload: unknown;
  accountId?: string;
  verbose?: boolean;
  context: Pick<GatewayRequestContext, "logGateway">;
}): Promise<ChatIngressResult> {
  const payload = isRecord(params.payload) ? params.payload : {};
  const message = payload.message && isRecord(payload.message) ? payload.message : undefined;
  const rawChatType = typeof payload.chatType === "string" ? payload.chatType : undefined;
  const chatType =
    rawChatType === "group" || rawChatType === "direct"
      ? rawChatType
      : payload.group === true
        ? "group"
        : "direct";
  const chatId =
    typeof payload.chatId === "string"
      ? payload.chatId
      : typeof payload.remoteJid === "string"
        ? payload.remoteJid
        : undefined;
  const from =
    typeof payload.from === "string" ? payload.from : chatType === "group" ? chatId : undefined;
  const conversationId =
    typeof payload.conversationId === "string" ? payload.conversationId : from;
  const senderE164 =
    typeof payload.senderE164 === "string"
      ? normalizeE164(payload.senderE164) ?? payload.senderE164
      : null;
  const senderJid = typeof payload.senderJid === "string" ? payload.senderJid : undefined;
  const senderName = typeof payload.senderName === "string" ? payload.senderName : undefined;
  const selfE164 =
    typeof payload.selfE164 === "string"
      ? normalizeE164(payload.selfE164) ?? payload.selfE164
      : null;
  const selfJid = typeof payload.selfJid === "string" ? payload.selfJid : undefined;
  const to = typeof payload.to === "string" ? payload.to : selfE164 ?? "me";
  const timestamp = typeof payload.timestamp === "number" ? payload.timestamp : undefined;
  const pushName = typeof payload.pushName === "string" ? payload.pushName : senderName;
  const groupSubject =
    typeof payload.groupSubject === "string" ? payload.groupSubject : undefined;
  const groupParticipants = Array.isArray(payload.groupParticipants)
    ? payload.groupParticipants.filter((value): value is string => typeof value === "string")
    : undefined;
  const mentionedJids = Array.isArray(payload.mentionedJids)
    ? payload.mentionedJids.filter((value): value is string => typeof value === "string")
    : message
      ? extractMentionedJids(message as proto.IMessage)
      : undefined;
  const allowFrom = Array.isArray(payload.allowFrom)
    ? payload.allowFrom.filter(
        (entry): entry is string | number => typeof entry === "string" || typeof entry === "number",
      )
    : undefined;
  const groupAllowFrom = Array.isArray(payload.groupAllowFrom)
    ? payload.groupAllowFrom.filter(
        (entry): entry is string | number => typeof entry === "string" || typeof entry === "number",
      )
    : undefined;
  const dmPolicy =
    typeof payload.dmPolicy === "string" &&
    (payload.dmPolicy === "pairing" ||
      payload.dmPolicy === "allowlist" ||
      payload.dmPolicy === "open" ||
      payload.dmPolicy === "disabled")
      ? (payload.dmPolicy as DmPolicy)
      : undefined;
  const groupPolicy =
    typeof payload.groupPolicy === "string" &&
    (payload.groupPolicy === "open" ||
      payload.groupPolicy === "allowlist" ||
      payload.groupPolicy === "disabled")
      ? (payload.groupPolicy as GroupPolicy)
      : undefined;

  if (!from || !conversationId) {
    return {
      runId: params.runId,
      status: "blocked",
      summary: "whatsapp payload missing sender",
    };
  }

  const resolvedAccountId =
    typeof params.accountId === "string" && params.accountId.trim()
      ? params.accountId.trim()
      : typeof payload.accountId === "string" && payload.accountId.trim()
        ? payload.accountId.trim()
        : DEFAULT_ACCOUNT_ID;
  const account = resolveWhatsAppAccount({
    cfg: params.cfg,
    accountId: resolvedAccountId,
  });

  const overrides: {
    allowFrom?: Array<string | number>;
    groupAllowFrom?: Array<string | number>;
    dmPolicy?: DmPolicy;
    groupPolicy?: GroupPolicy;
  } = {};
  if (allowFrom) overrides.allowFrom = allowFrom;
  if (groupAllowFrom) overrides.groupAllowFrom = groupAllowFrom;
  if (dmPolicy) overrides.dmPolicy = dmPolicy;
  if (groupPolicy) overrides.groupPolicy = groupPolicy;

  const access = await checkInboundAccessControl({
    cfg: params.cfg,
    accountId: resolvedAccountId,
    from,
    selfE164,
    senderE164,
    group: chatType === "group",
    pushName,
    isFromMe: false,
    messageTimestampMs: timestamp,
    sock: {
      sendMessage: async () => {},
    },
    remoteJid: chatId ?? from,
    overrides: Object.keys(overrides).length > 0 ? overrides : undefined,
  });

  if (!access.allowed) {
    return {
      runId: params.runId,
      status: "blocked",
      summary: "whatsapp message blocked by access control",
    };
  }

  const location = message
    ? extractLocationData(message as proto.IMessage)
    : null;
  const locationText = location ? formatLocationText(location) : undefined;
  let body = typeof payload.body === "string" ? payload.body.trim() : undefined;
  if (!body && message) {
    body = extractText(message as proto.IMessage);
  }
  if (locationText) {
    body = [body, locationText].filter(Boolean).join("\n").trim();
  }
  if (!body && message) {
    body = extractMediaPlaceholder(message as proto.IMessage);
  }
  if (!body) {
    return {
      runId: params.runId,
      status: "blocked",
      summary: "whatsapp payload missing body",
    };
  }

  const replyContext = message
    ? describeReplyContext(message as proto.IMessage)
    : null;

  const inboundMessage: WebInboundMsg = {
    id: typeof payload.id === "string" ? payload.id : undefined,
    from,
    conversationId,
    to,
    accountId: access.resolvedAccountId,
    body,
    pushName,
    timestamp,
    chatType,
    chatId: chatId ?? from,
    senderJid,
    senderE164: senderE164 ?? undefined,
    senderName,
    replyToId: replyContext?.id,
    replyToBody: replyContext?.body,
    replyToSender: replyContext?.sender,
    replyToSenderJid: replyContext?.senderJid,
    replyToSenderE164: replyContext?.senderE164,
    groupSubject,
    groupParticipants,
    mentionedJids: mentionedJids ?? undefined,
    selfJid,
    selfE164,
    location: location ?? undefined,
    sendComposing: async () => {},
    reply: async () => {},
    sendMedia: async () => {},
    mediaPath: undefined,
    mediaType: undefined,
  };

  const peerId = resolvePeerId(inboundMessage);
  const route = resolveAgentRoute({
    cfg: params.cfg,
    channel: "whatsapp",
    accountId: access.resolvedAccountId,
    peer: {
      kind: chatType === "group" ? "group" : "dm",
      id: peerId,
    },
  });
  const groupHistoryKey =
    chatType === "group"
      ? buildGroupHistoryKey({
          channel: "whatsapp",
          accountId: route.accountId,
          peerKind: "group",
          peerId,
        })
      : route.sessionKey;

  const replyLogger = getChildLogger({ module: "gateway/ingress/whatsapp" });
  const groupHistories = new Map();
  const groupMemberNames = new Map();
  const groupHistoryLimit = Math.max(
    0,
    params.cfg.messages?.groupChat?.historyLimit ?? DEFAULT_GROUP_HISTORY_LIMIT,
  );
  const baseMentionConfig = buildMentionConfig(params.cfg, route.agentId);

  if (chatType === "group") {
    const gating = applyGroupGating({
      cfg: params.cfg,
      msg: inboundMessage,
      conversationId,
      groupHistoryKey,
      agentId: route.agentId,
      sessionKey: route.sessionKey,
      baseMentionConfig,
      authDir: account.authDir,
      groupHistories,
      groupHistoryLimit,
      groupMemberNames,
      logVerbose: (msg) => {
        params.context.logGateway.debug(msg);
      },
      replyLogger,
    });
    if (!gating.shouldProcess) {
      return {
        runId: params.runId,
        status: "blocked",
        summary: "whatsapp message blocked by group gating",
      };
    }
  }

  const backgroundTasks = new Set<Promise<unknown>>();
  const echoTracker = createEchoTracker({});
  let resolveContext: ((ctx: FinalizedMsgContext) => void) | null = null;
  let rejectContext: ((err: Error) => void) | null = null;
  const contextPromise = new Promise<FinalizedMsgContext>((resolve, reject) => {
    resolveContext = resolve;
    rejectContext = reject;
  });

  void processMessage({
    cfg: params.cfg,
    msg: inboundMessage,
    route,
    groupHistoryKey,
    groupHistories,
    groupMemberNames,
    connectionId: `ingress:${params.runId}`,
    verbose: params.verbose === true,
    maxMediaBytes: DEFAULT_WEB_MEDIA_BYTES,
    replyResolver: getReplyFromConfig,
    replyLogger,
    backgroundTasks,
    rememberSentText: echoTracker.rememberText,
    echoHas: echoTracker.has,
    echoForget: echoTracker.forget,
    buildCombinedEchoKey: echoTracker.buildCombinedKey,
    replyOptions: {
      runId: params.runId,
      disableBlockStreaming: true,
    },
    onContext: (ctx) => {
      resolveContext?.(ctx);
    },
  }).catch((err) => {
    const error = err instanceof Error ? err : new Error(String(err));
    rejectContext?.(error);
    params.context.logGateway.warn(`whatsapp ingress dispatch failed: ${formatForLog(error)}`);
  });

  let ctxPayload: FinalizedMsgContext;
  try {
    ctxPayload = await contextPromise;
  } catch (err) {
    return {
      runId: params.runId,
      status: "blocked",
      summary: `whatsapp ingress failed: ${formatForLog(err)}`,
    };
  }
  const sessionKey = ctxPayload.SessionKey ?? route.sessionKey;
  if (sessionKey) {
    registerAgentRunContext(params.runId, {
      sessionKey,
      ...(params.verbose !== undefined
        ? { verboseLevel: params.verbose ? "on" : "off" }
        : {}),
    });
  }

  return {
    runId: params.runId,
    status: "accepted",
    sessionKey,
    meta: buildIngressMeta(ctxPayload),
  };
}

export const chatHandlers: GatewayRequestHandlers = {
  "chat.history": async ({ params, respond, context }) => {
    if (!validateChatHistoryParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid chat.history params: ${formatValidationErrors(validateChatHistoryParams.errors)}`,
        ),
      );
      return;
    }
    const { sessionKey, limit } = params as {
      sessionKey: string;
      limit?: number;
    };
    const { cfg, storePath, entry } = loadSessionEntry(sessionKey);
    const sessionId = entry?.sessionId;
    const rawMessages =
      sessionId && storePath ? readSessionMessages(sessionId, storePath, entry?.sessionFile) : [];
    const hardMax = 1000;
    const defaultLimit = 200;
    const requested = typeof limit === "number" ? limit : defaultLimit;
    const max = Math.min(hardMax, requested);
    const sliced = rawMessages.length > max ? rawMessages.slice(-max) : rawMessages;
    const sanitized = stripEnvelopeFromMessages(sliced);
    const capped = capArrayByJsonBytes(sanitized, getMaxChatHistoryMessagesBytes()).items;
    let thinkingLevel = entry?.thinkingLevel;
    if (!thinkingLevel) {
      const configured = cfg.agents?.defaults?.thinkingDefault;
      if (configured) {
        thinkingLevel = configured;
      } else {
        const { provider, model } = resolveSessionModelRef(cfg, entry);
        const catalog = await context.loadGatewayModelCatalog();
        thinkingLevel = resolveThinkingDefault({
          cfg,
          provider,
          model,
          catalog,
        });
      }
    }
    respond(true, {
      sessionKey,
      sessionId,
      messages: capped,
      thinkingLevel,
    });
  },
  "chat.abort": ({ params, respond, context }) => {
    if (!validateChatAbortParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid chat.abort params: ${formatValidationErrors(validateChatAbortParams.errors)}`,
        ),
      );
      return;
    }
    const { sessionKey, runId } = params as {
      sessionKey: string;
      runId?: string;
    };

    const ops = {
      chatAbortControllers: context.chatAbortControllers,
      chatRunBuffers: context.chatRunBuffers,
      chatDeltaSentAt: context.chatDeltaSentAt,
      chatAbortedRuns: context.chatAbortedRuns,
      removeChatRun: context.removeChatRun,
      agentRunSeq: context.agentRunSeq,
      broadcast: context.broadcast,
      nodeSendToSession: context.nodeSendToSession,
    };

    if (!runId) {
      const res = abortChatRunsForSessionKey(ops, {
        sessionKey,
        stopReason: "rpc",
      });
      respond(true, { ok: true, aborted: res.aborted, runIds: res.runIds });
      return;
    }

    const active = context.chatAbortControllers.get(runId);
    if (!active) {
      respond(true, { ok: true, aborted: false, runIds: [] });
      return;
    }
    if (active.sessionKey !== sessionKey) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "runId does not match sessionKey"),
      );
      return;
    }

    const res = abortChatRunById(ops, {
      runId,
      sessionKey,
      stopReason: "rpc",
    });
    respond(true, {
      ok: true,
      aborted: res.aborted,
      runIds: res.aborted ? [runId] : [],
    });
  },
  "chat.send": async ({ params, respond, context, client }) => {
    if (!validateChatSendParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid chat.send params: ${formatValidationErrors(validateChatSendParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as {
      sessionKey: string;
      message: string;
      thinking?: string;
      deliver?: boolean;
      attachments?: Array<{
        type?: string;
        mimeType?: string;
        fileName?: string;
        content?: unknown;
      }>;
      timeoutMs?: number;
      idempotencyKey: string;
    };
    const stopCommand = isChatStopCommandText(p.message);
    const normalizedAttachments =
      p.attachments
        ?.map((a) => ({
          type: typeof a?.type === "string" ? a.type : undefined,
          mimeType: typeof a?.mimeType === "string" ? a.mimeType : undefined,
          fileName: typeof a?.fileName === "string" ? a.fileName : undefined,
          content:
            typeof a?.content === "string"
              ? a.content
              : ArrayBuffer.isView(a?.content)
                ? Buffer.from(
                    a.content.buffer,
                    a.content.byteOffset,
                    a.content.byteLength,
                  ).toString("base64")
                : undefined,
        }))
        .filter((a) => a.content) ?? [];
    const rawMessage = p.message.trim();
    if (!rawMessage && normalizedAttachments.length === 0) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "message or attachment required"),
      );
      return;
    }
    let parsedMessage = p.message;
    let parsedImages: ChatImageContent[] = [];
    if (normalizedAttachments.length > 0) {
      try {
        const parsed = await parseMessageWithAttachments(p.message, normalizedAttachments, {
          maxBytes: 5_000_000,
          log: context.logGateway,
        });
        parsedMessage = parsed.message;
        parsedImages = parsed.images;
      } catch (err) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, String(err)));
        return;
      }
    }
    const { cfg, entry } = loadSessionEntry(p.sessionKey);
    const timeoutMs = resolveAgentTimeoutMs({
      cfg,
      overrideMs: p.timeoutMs,
    });
    const now = Date.now();
    const clientRunId = p.idempotencyKey;

    const sendPolicy = resolveSendPolicy({
      cfg,
      entry,
      sessionKey: p.sessionKey,
      channel: entry?.channel,
      chatType: entry?.chatType,
    });
    if (sendPolicy === "deny") {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "send blocked by session policy"),
      );
      return;
    }

    if (stopCommand) {
      const res = abortChatRunsForSessionKey(
        {
          chatAbortControllers: context.chatAbortControllers,
          chatRunBuffers: context.chatRunBuffers,
          chatDeltaSentAt: context.chatDeltaSentAt,
          chatAbortedRuns: context.chatAbortedRuns,
          removeChatRun: context.removeChatRun,
          agentRunSeq: context.agentRunSeq,
          broadcast: context.broadcast,
          nodeSendToSession: context.nodeSendToSession,
        },
        { sessionKey: p.sessionKey, stopReason: "stop" },
      );
      respond(true, { ok: true, aborted: res.aborted, runIds: res.runIds });
      return;
    }

    const cached = context.dedupe.get(`chat:${clientRunId}`);
    if (cached) {
      respond(cached.ok, cached.payload, cached.error, {
        cached: true,
      });
      return;
    }

    const activeExisting = context.chatAbortControllers.get(clientRunId);
    if (activeExisting) {
      respond(true, { runId: clientRunId, status: "in_flight" as const }, undefined, {
        cached: true,
        runId: clientRunId,
      });
      return;
    }

    try {
      const abortController = new AbortController();
      context.chatAbortControllers.set(clientRunId, {
        controller: abortController,
        sessionId: entry?.sessionId ?? clientRunId,
        sessionKey: p.sessionKey,
        startedAtMs: now,
        expiresAtMs: resolveChatRunExpiresAtMs({ now, timeoutMs }),
      });

      const ackPayload = {
        runId: clientRunId,
        status: "started" as const,
      };
      respond(true, ackPayload, undefined, { runId: clientRunId });

      const trimmedMessage = parsedMessage.trim();
      const injectThinking = Boolean(
        p.thinking && trimmedMessage && !trimmedMessage.startsWith("/"),
      );
      const commandBody = injectThinking ? `/think ${p.thinking} ${parsedMessage}` : parsedMessage;
      const clientInfo = client?.connect?.client;
      const ctx: MsgContext = {
        Body: parsedMessage,
        BodyForAgent: parsedMessage,
        BodyForCommands: commandBody,
        RawBody: parsedMessage,
        CommandBody: commandBody,
        SessionKey: p.sessionKey,
        Provider: INTERNAL_MESSAGE_CHANNEL,
        Surface: INTERNAL_MESSAGE_CHANNEL,
        OriginatingChannel: INTERNAL_MESSAGE_CHANNEL,
        ChatType: "direct",
        CommandAuthorized: true,
        MessageSid: clientRunId,
        SenderId: clientInfo?.id,
        SenderName: clientInfo?.displayName,
        SenderUsername: clientInfo?.displayName,
      };

      const agentId = resolveSessionAgentId({
        sessionKey: p.sessionKey,
        config: cfg,
      });
      let prefixContext: ResponsePrefixContext = {
        identityName: resolveIdentityName(cfg, agentId),
      };
      const finalReplyParts: string[] = [];
      const dispatcher = createReplyDispatcher({
        responsePrefix: resolveEffectiveMessagesConfig(cfg, agentId).responsePrefix,
        responsePrefixContextProvider: () => prefixContext,
        onError: (err) => {
          context.logGateway.warn(`webchat dispatch failed: ${formatForLog(err)}`);
        },
        deliver: async (payload, info) => {
          if (info.kind !== "final") return;
          const text = payload.text?.trim() ?? "";
          if (!text) return;
          finalReplyParts.push(text);
        },
      });

      let agentRunStarted = false;
      void dispatchInboundMessage({
        ctx,
        cfg,
        dispatcher,
        replyOptions: {
          runId: clientRunId,
          abortSignal: abortController.signal,
          images: parsedImages.length > 0 ? parsedImages : undefined,
          disableBlockStreaming: true,
          onAgentRunStart: () => {
            agentRunStarted = true;
          },
          onModelSelected: (ctx) => {
            prefixContext.provider = ctx.provider;
            prefixContext.model = extractShortModelName(ctx.model);
            prefixContext.modelFull = `${ctx.provider}/${ctx.model}`;
            prefixContext.thinkingLevel = ctx.thinkLevel ?? "off";
          },
        },
      })
        .then(() => {
          if (!agentRunStarted) {
            const combinedReply = finalReplyParts
              .map((part) => part.trim())
              .filter(Boolean)
              .join("\n\n")
              .trim();
            let message: Record<string, unknown> | undefined;
            if (combinedReply) {
              const { storePath: latestStorePath, entry: latestEntry } = loadSessionEntry(
                p.sessionKey,
              );
              const sessionId = latestEntry?.sessionId ?? entry?.sessionId ?? clientRunId;
              const appended = appendAssistantTranscriptMessage({
                message: combinedReply,
                sessionId,
                storePath: latestStorePath,
                sessionFile: latestEntry?.sessionFile,
                createIfMissing: true,
              });
              if (appended.ok) {
                message = appended.message;
              } else {
                context.logGateway.warn(
                  `webchat transcript append failed: ${appended.error ?? "unknown error"}`,
                );
                const now = Date.now();
                message = {
                  role: "assistant",
                  content: [{ type: "text", text: combinedReply }],
                  timestamp: now,
                  stopReason: "injected",
                  usage: { input: 0, output: 0, totalTokens: 0 },
                };
              }
            }
            broadcastChatFinal({
              context,
              runId: clientRunId,
              sessionKey: p.sessionKey,
              message,
            });
          }
          context.dedupe.set(`chat:${clientRunId}`, {
            ts: Date.now(),
            ok: true,
            payload: { runId: clientRunId, status: "ok" as const },
          });
        })
        .catch((err) => {
          const error = errorShape(ErrorCodes.UNAVAILABLE, String(err));
          context.dedupe.set(`chat:${clientRunId}`, {
            ts: Date.now(),
            ok: false,
            payload: {
              runId: clientRunId,
              status: "error" as const,
              summary: String(err),
            },
            error,
          });
          broadcastChatError({
            context,
            runId: clientRunId,
            sessionKey: p.sessionKey,
            errorMessage: String(err),
          });
        })
        .finally(() => {
          context.chatAbortControllers.delete(clientRunId);
        });
    } catch (err) {
      const error = errorShape(ErrorCodes.UNAVAILABLE, String(err));
      const payload = {
        runId: clientRunId,
        status: "error" as const,
        summary: String(err),
      };
      context.dedupe.set(`chat:${clientRunId}`, {
        ts: Date.now(),
        ok: false,
        payload,
        error,
      });
      respond(false, payload, error, {
        runId: clientRunId,
        error: formatForLog(err),
      });
    }
  },
  "chat.ingress": async ({ params, respond, context }) => {
    if (!validateChatIngressParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid chat.ingress params: ${formatValidationErrors(validateChatIngressParams.errors)}`,
        ),
      );
      return;
    }

    const p = params as {
      channel: string;
      payload: unknown;
      runId?: string;
      accountId?: string;
      verbose?: boolean;
    };
    const runId = p.runId && p.runId.trim() ? p.runId.trim() : randomUUID();
    const cfg = loadConfig();
    const channel = p.channel.trim().toLowerCase();

    let result: ChatIngressResult | null = null;
    try {
      if (channel === "telegram") {
        result = await handleTelegramIngress({
          cfg,
          runId,
          payload: p.payload,
          accountId: p.accountId,
          verbose: p.verbose,
          context,
        });
      } else if (channel === "whatsapp") {
        result = await handleWhatsAppIngress({
          cfg,
          runId,
          payload: p.payload,
          accountId: p.accountId,
          verbose: p.verbose,
          context,
        });
      } else {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `unsupported ingress channel: ${p.channel}`),
        );
        return;
      }
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, `chat.ingress failed: ${formatForLog(err)}`),
      );
      return;
    }

    respond(true, result);
  },
  "chat.inject": async ({ params, respond, context }) => {
    if (!validateChatInjectParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid chat.inject params: ${formatValidationErrors(validateChatInjectParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as {
      sessionKey: string;
      message: string;
      label?: string;
    };

    // Load session to find transcript file
    const { storePath, entry } = loadSessionEntry(p.sessionKey);
    const sessionId = entry?.sessionId;
    if (!sessionId || !storePath) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "session not found"));
      return;
    }

    // Resolve transcript path
    const transcriptPath = entry?.sessionFile
      ? entry.sessionFile
      : path.join(path.dirname(storePath), `${sessionId}.jsonl`);

    if (!fs.existsSync(transcriptPath)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "transcript file not found"),
      );
      return;
    }

    // Build transcript entry
    const now = Date.now();
    const messageId = randomUUID().slice(0, 8);
    const labelPrefix = p.label ? `[${p.label}]\n\n` : "";
    const messageBody: Record<string, unknown> = {
      role: "assistant",
      content: [{ type: "text", text: `${labelPrefix}${p.message}` }],
      timestamp: now,
      stopReason: "injected",
      usage: { input: 0, output: 0, totalTokens: 0 },
    };
    const transcriptEntry = {
      type: "message",
      id: messageId,
      timestamp: new Date(now).toISOString(),
      message: messageBody,
    };

    // Append to transcript file
    try {
      fs.appendFileSync(transcriptPath, `${JSON.stringify(transcriptEntry)}\n`, "utf-8");
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err);
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, `failed to write transcript: ${errMessage}`),
      );
      return;
    }

    // Broadcast to webchat for immediate UI update
    const chatPayload = {
      runId: `inject-${messageId}`,
      sessionKey: p.sessionKey,
      seq: 0,
      state: "final" as const,
      message: transcriptEntry.message,
    };
    context.broadcast("chat", chatPayload);
    context.nodeSendToSession(p.sessionKey, "chat", chatPayload);

    respond(true, { ok: true, messageId });
  },
};
