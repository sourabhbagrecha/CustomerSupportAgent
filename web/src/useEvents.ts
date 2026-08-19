import { useEffect, useState } from "react";
import type { AgentEvent, AgentStreamEvent } from "./types";

// Wraps a single EventSource per active threadId (GET /api/events/:threadId).
// The server replays all past events for the thread on connect, then streams
// new ones live; heartbeat comment lines are ignored automatically by
// EventSource. One connection is opened per threadId and closed on switch
// or unmount.
//
// The same connection also carries named "token" events: ephemeral text
// deltas for the in-flight LLM reply (see server/src/events/emitter.ts). The
// buffer resets on "start" (fired at the top of every model attempt, so a
// retry/failover naturally clears stale partial text) and grows on "delta".
// It is never cleared on "end": the caller only renders it while the turn is
// still in flight, and the authoritative POST /api/chat response replaces it
// in the committed message list once the turn completes.
export function useEvents(threadId: string | null): { events: AgentEvent[]; streamingReply: string } {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [streamingReply, setStreamingReply] = useState("");

  useEffect(() => {
    setEvents([]);
    setStreamingReply("");
    if (!threadId) return;

    const source = new EventSource(`/api/events/${encodeURIComponent(threadId)}`);
    source.onmessage = (message) => {
      try {
        const parsed = JSON.parse(message.data) as AgentEvent;
        setEvents((prev) => [...prev, parsed]);
      } catch {
        // Ignore any line that isn't valid JSON (defensive; the server only
        // ever writes JSON data lines or comment-only heartbeats).
      }
    };
    source.addEventListener("token", (message) => {
      try {
        const parsed = JSON.parse((message as MessageEvent<string>).data) as AgentStreamEvent;
        if (parsed.type === "start") setStreamingReply("");
        else if (parsed.type === "delta") setStreamingReply((prev) => prev + parsed.text);
      } catch {
        // Same defensive ignore as above.
      }
    });

    return () => source.close();
  }, [threadId]);

  return { events, streamingReply };
}
