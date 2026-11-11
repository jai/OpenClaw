import { describe, expect, it, vi } from "vitest";
import {
  findGoogleChatProgressActivity,
  registerGoogleChatProgressActivity,
} from "./progress-activity.js";

const SESSION = "agent:main:googlechat:group:spaces/aaa";

function activity(threadName?: string, sessionKey = SESSION) {
  return {
    accountId: "default",
    spaceId: "spaces/AAA",
    messageName: `spaces/AAA/messages/activity-${threadName ?? "top"}-${sessionKey}`,
    ...(threadName ? { threadName } : {}),
    sessionKey,
    update: vi.fn(async () => true),
  };
}

const find = (params: { threadName?: string; sessionKey?: string; accountId?: string }) =>
  findGoogleChatProgressActivity({
    accountId: params.accountId ?? "default",
    spaceId: "spaces/AAA",
    threadName: params.threadName,
    sessionKey: params.sessionKey ?? SESSION,
  });

describe("Google Chat progress activity registry", () => {
  it("matches the same account, space and delivered thread", () => {
    const threaded = activity("spaces/AAA/threads/t1");
    const unregister = registerGoogleChatProgressActivity(threaded);
    expect(find({ threadName: "spaces/AAA/threads/t1" })).toBe(threaded);
    expect(find({ threadName: "spaces/AAA/threads/t1", sessionKey: SESSION.toUpperCase() })).toBe(
      threaded,
    );
    expect(find({ threadName: "spaces/AAA/threads/other" })).toBeUndefined();
    expect(find({ threadName: "spaces/AAA/threads/t1", accountId: "work" })).toBeUndefined();
    expect(find({ threadName: "spaces/AAA/threads/t1", sessionKey: "agent:other" })).toBe(threaded);
    expect(find({})).toBeUndefined();
    unregister();
    expect(find({ threadName: "spaces/AAA/threads/t1" })).toBeUndefined();
  });

  it("folds without a session when the thread matches", () => {
    const threaded = activity("spaces/AAA/threads/t1");
    const unregister = registerGoogleChatProgressActivity(threaded);
    expect(
      findGoogleChatProgressActivity({
        accountId: "default",
        spaceId: "spaces/AAA",
        threadName: "spaces/AAA/threads/t1",
      }),
    ).toBe(threaded);
    unregister();
  });

  it("matches a top-level activity only for a threadless send", () => {
    const top = activity();
    const unregister = registerGoogleChatProgressActivity(top);
    expect(find({})).toBe(top);
    unregister();
  });

  it("keeps concurrent turns in one thread on their own activity", () => {
    const first = activity("spaces/AAA/threads/t1", "agent:a");
    const second = activity("spaces/AAA/threads/t1", "agent:b");
    const a = registerGoogleChatProgressActivity(first);
    const b = registerGoogleChatProgressActivity(second);
    expect(find({ threadName: "spaces/AAA/threads/t1", sessionKey: "agent:a" })).toBe(first);
    expect(find({ threadName: "spaces/AAA/threads/t1", sessionKey: "agent:b" })).toBe(second);
    a();
    b();
  });
});
