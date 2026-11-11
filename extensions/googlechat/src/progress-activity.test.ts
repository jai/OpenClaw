import { describe, expect, it, vi } from "vitest";
import {
  findGoogleChatProgressActivity,
  registerGoogleChatProgressActivity,
} from "./progress-activity.js";

function activity(threadNames: string[], spaceId = "spaces/AAA") {
  return {
    accountId: "default",
    spaceId,
    messageName: `${spaceId}/messages/activity-${threadNames.join("-") || "top"}`,
    threadNames,
    update: vi.fn(async () => true),
  };
}

describe("Google Chat progress activity registry", () => {
  it("matches the activity in the same account, space and thread", () => {
    const threaded = activity(["spaces/AAA/threads/t1"]);
    const unregister = registerGoogleChatProgressActivity(threaded);
    expect(
      findGoogleChatProgressActivity({
        accountId: "default",
        spaceId: "spaces/AAA",
        threadName: "spaces/AAA/threads/t1",
      }),
    ).toBe(threaded);
    expect(
      findGoogleChatProgressActivity({
        accountId: "default",
        spaceId: "spaces/AAA",
        threadName: "spaces/AAA/threads/other",
      }),
    ).toBeUndefined();
    expect(
      findGoogleChatProgressActivity({
        accountId: "work",
        spaceId: "spaces/AAA",
        threadName: "spaces/AAA/threads/t1",
      }),
    ).toBeUndefined();
    expect(
      findGoogleChatProgressActivity({ accountId: "default", spaceId: "spaces/AAA" }),
    ).toBeUndefined();
    unregister();
    expect(
      findGoogleChatProgressActivity({
        accountId: "default",
        spaceId: "spaces/AAA",
        threadName: "spaces/AAA/threads/t1",
      }),
    ).toBeUndefined();
  });

  it("matches a top-level activity only for a threadless send", () => {
    const top = activity([]);
    const unregister = registerGoogleChatProgressActivity(top);
    expect(findGoogleChatProgressActivity({ accountId: "default", spaceId: "spaces/AAA" })).toBe(
      top,
    );
    unregister();
  });

  it("prefers the most recently registered activity in a thread", () => {
    const first = activity(["spaces/AAA/threads/t1"]);
    const second = {
      ...activity(["spaces/AAA/threads/t1"]),
      messageName: "spaces/AAA/messages/second",
    };
    const a = registerGoogleChatProgressActivity(first);
    const b = registerGoogleChatProgressActivity(second);
    expect(
      findGoogleChatProgressActivity({
        accountId: "default",
        spaceId: "spaces/AAA",
        threadName: "spaces/AAA/threads/t1",
      }),
    ).toBe(second);
    a();
    b();
  });
});
