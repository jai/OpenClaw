// Googlechat plugin module classifies DM spaces and labels unnamed spaces from membership.
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { ResolvedGoogleChatAccount } from "./accounts.js";
import { listGoogleChatSpaceMembers } from "./api.js";
import { isGoogleChatDirectMessageSpace, resolveGoogleChatSpaceChatType } from "./targets.js";
import type { GoogleChatSpace, GoogleChatUser } from "./types.js";

const MEMBERS_CACHE_TTL_MS = 60 * 60_000;
const MEMBERS_CACHE_MAX_ENTRIES = 500;

const humanMembersCache = new Map<string, { expiresAt: number; humans: GoogleChatUser[] }>();

async function getGoogleChatSpaceHumanMembers(params: {
  account: ResolvedGoogleChatAccount;
  spaceName: string;
}): Promise<GoogleChatUser[]> {
  const key = `${params.account.accountId}\0${params.spaceName}`;
  const now = Date.now();
  const cached = humanMembersCache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.humans;
  }
  const memberships = await listGoogleChatSpaceMembers(params);
  const humans = memberships
    .filter(
      (membership) =>
        membership.member?.type?.toUpperCase() === "HUMAN" &&
        (membership.state === undefined || membership.state.toUpperCase() === "JOINED"),
    )
    .map((membership) => membership.member as GoogleChatUser);
  humanMembersCache.delete(key);
  humanMembersCache.set(key, { expiresAt: now + MEMBERS_CACHE_TTL_MS, humans });
  if (humanMembersCache.size > MEMBERS_CACHE_MAX_ENTRIES) {
    const oldest = humanMembersCache.keys().next().value;
    if (oldest !== undefined) {
      humanMembersCache.delete(oldest);
    }
  }
  return humans;
}

export function clearGoogleChatSpaceMembersCacheForTest(): void {
  humanMembersCache.clear();
}

/**
 * Classifies an inbound space. A DIRECT_MESSAGE space with no 1:1 app DM marker
 * is a group when it has more than one human member. Payloads without any type
 * metadata keep their historical group default.
 */
export async function resolveGoogleChatInboundIsGroup(params: {
  account: ResolvedGoogleChatAccount;
  space: GoogleChatSpace;
  logVerbose: (message: string) => void;
}): Promise<boolean> {
  const { account, space } = params;
  const chatType = resolveGoogleChatSpaceChatType(space);
  if (chatType) {
    return chatType === "group";
  }
  if (!isGoogleChatDirectMessageSpace(space) || !space.name) {
    return true;
  }
  try {
    const humans = await getGoogleChatSpaceHumanMembers({ account, spaceName: space.name });
    return humans.length > 1;
  } catch (error) {
    params.logVerbose(
      `googlechat: member lookup failed for ${space.name}; treating it as a direct message: ${formatErrorMessage(error)}`,
    );
    return false;
  }
}

/**
 * Labels an unnamed DM or group chat with its human members, such as
 * "DM: Alice, Bob". Named spaces and legacy payloads return undefined.
 */
export async function resolveGoogleChatMemberLabel(params: {
  account: ResolvedGoogleChatAccount;
  space: GoogleChatSpace;
  logVerbose: (message: string) => void;
}): Promise<string | undefined> {
  const { account, space } = params;
  const spaceType = (space.spaceType ?? "").toUpperCase();
  if (space.displayName || !space.name) {
    return undefined;
  }
  if (spaceType !== "DIRECT_MESSAGE" && spaceType !== "GROUP_CHAT") {
    return undefined;
  }
  try {
    const humans = await getGoogleChatSpaceHumanMembers({ account, spaceName: space.name });
    const names = humans.flatMap((human) => human.displayName?.trim() || []);
    if (names.length === 0) {
      return undefined;
    }
    return `${spaceType === "DIRECT_MESSAGE" ? "DM" : "Group chat"}: ${names.join(", ")}`;
  } catch (error) {
    params.logVerbose(
      `googlechat: member lookup failed for ${space.name}; using the space id as its label: ${formatErrorMessage(error)}`,
    );
    return undefined;
  }
}
