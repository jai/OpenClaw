// Google Chat message-tool discovery stays read-only and account-isolated.
import type { ChannelMessageActionAdapter } from "openclaw/plugin-sdk/channel-contract";
import { isRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { extractToolSend } from "openclaw/plugin-sdk/tool-send";
import { inspectGoogleChatAccount, listGoogleChatAccountIds } from "./accounts.js";

export const googlechatMessageActions = {
  describeMessageTool({ cfg, accountId }) {
    const accounts = accountId
      ? [inspectGoogleChatAccount({ cfg, accountId })]
      : listGoogleChatAccountIds(cfg).map((listedAccountId) =>
          inspectGoogleChatAccount({ cfg, accountId: listedAccountId }),
        );
    const hasAvailableAccount = accounts.some(
      (account) =>
        account.enabled &&
        account.credentialSource !== "none" &&
        account.tokenStatus === "available",
    );
    return hasAvailableAccount ? { actions: ["send" as const] } : null;
  },
  supportsAction: ({ action }) => action === "send",
  extractToolSend: ({ args }) =>
    extractToolSend(
      { ...args, threadId: Object.hasOwn(args, "threadId") ? args.threadId : args.replyTo },
      args.action === "send" ? "send" : "sendMessage",
    ),
  extractToolSendResult: ({ result, send }) => {
    const details = isRecord(result)
      ? isRecord(result.details)
        ? result.details
        : result
      : undefined;
    const delivery = details && isRecord(details.result) ? details.result : details;
    const receipt = delivery && isRecord(delivery.receipt) ? delivery.receipt : undefined;
    const threadId =
      normalizeOptionalString(delivery?.threadName) ??
      normalizeOptionalString(delivery?.threadId) ??
      normalizeOptionalString(receipt?.threadId);
    const to =
      normalizeOptionalString(delivery?.to) ?? normalizeOptionalString(delivery?.chatId) ?? send.to;
    if (!threadId || !threadId.startsWith(`${to}/threads/`)) {
      return null;
    }
    return {
      to,
      accountId: send.accountId,
      ...(send.threadSuppressed ? { threadSuppressed: true } : { threadId }),
    };
  },
  handleAction: async (ctx) => (await import("./actions.js")).handleGoogleChatAction(ctx),
} satisfies ChannelMessageActionAdapter;
