import { expect, test } from "bun:test";
import {
  FEED_SSE_EVENT_TYPES,
  ownReactionsBySignalId,
  reactionParentSignalId,
} from "../src/v2/feedModel.ts";

test("maps caller reactions through parent_signal_id when signal_id is null", () => {
  const events = [
    {
      kind: "signal",
      signal_id: "sig-1",
      reaction_id: null,
      from_address: "peer",
      payload: { token: "ETHUSDT", direction: "long" },
      created_at: "2026-05-19T00:00:00.000Z",
    },
    {
      kind: "reaction",
      signal_id: null,
      reaction_id: "react-1",
      parent_signal_id: "sig-1",
      from_address: "me",
      payload: { value: "+1" },
      created_at: "2026-05-19T00:00:01.000Z",
    },
  ];

  const mapped = ownReactionsBySignalId(events, "me");

  expect(mapped.get("sig-1")?.reaction_id).toBe("react-1");
});

test("ignores reactions from other agents", () => {
  const events = [
    {
      kind: "reaction",
      signal_id: null,
      reaction_id: "react-peer",
      parent_signal_id: "sig-1",
      from_address: "peer",
      payload: { value: "+1" },
      created_at: "2026-05-19T00:00:01.000Z",
    },
  ];

  expect(ownReactionsBySignalId(events, "me").size).toBe(0);
});

test("keeps legacy reaction events that still carry signal_id", () => {
  const event = {
    kind: "reaction",
    signal_id: "sig-legacy",
    reaction_id: "react-legacy",
    from_address: "me",
    payload: { value: "-1" },
    created_at: "2026-05-19T00:00:01.000Z",
  };

  expect(reactionParentSignalId(event)).toBe("sig-legacy");
  expect(ownReactionsBySignalId([event], "me").has("sig-legacy")).toBe(true);
});

test("listens to every user-scope feed event the backend can push", () => {
  expect(FEED_SSE_EVENT_TYPES).toContain("friend_request");
  expect(FEED_SSE_EVENT_TYPES).toContain("friend_accepted");
  expect(FEED_SSE_EVENT_TYPES).toContain("friend_removed");
  expect(FEED_SSE_EVENT_TYPES).toContain("channel_invited");
  expect(FEED_SSE_EVENT_TYPES).toContain("channel_created");
});

test("listens to channel rename and system broadcast events", () => {
  expect(FEED_SSE_EVENT_TYPES).toContain("channel_renamed");
  expect(FEED_SSE_EVENT_TYPES).toContain("system");
});
