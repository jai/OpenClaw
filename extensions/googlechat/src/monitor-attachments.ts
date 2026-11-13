import type { ResolvedGoogleChatAccount } from "./accounts.js";
import { downloadGoogleChatMedia } from "./api.js";
import type { GoogleChatCoreRuntime } from "./monitor-types.js";
import type { GoogleChatAttachment } from "./types.js";

export async function downloadGoogleChatAttachment(
  attachment: GoogleChatAttachment,
  account: ResolvedGoogleChatAccount,
  mediaMaxMb: number,
  core: GoogleChatCoreRuntime,
): Promise<{ path: string; contentType?: string } | null> {
  const resourceName = attachment.attachmentDataRef?.resourceName;
  if (!resourceName) {
    return null;
  }
  const maxBytes = mediaMaxMb * 1024 * 1024;
  const downloaded = await downloadGoogleChatMedia({ account, resourceName, maxBytes });
  const saved = await core.channel.media.saveMediaBuffer(
    downloaded.buffer,
    downloaded.contentType ?? attachment.contentType,
    "inbound",
    maxBytes,
    attachment.contentName,
  );
  return { path: saved.path, contentType: saved.contentType };
}
