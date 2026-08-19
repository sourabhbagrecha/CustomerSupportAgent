import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  clearFaults,
  getFaults,
  getPendingApproval,
  getPersonas,
  getThreadState,
  getThreads,
  resolveApproval,
  sendChatMessage,
  setFault,
} from "./api";
import { AuditPanel } from "./components/AuditPanel";
import { Chat } from "./components/Chat";
import { HistoryPanel } from "./components/HistoryPanel";
import { PersonaPanel } from "./components/PersonaPanel";
import { TracePanel } from "./components/TracePanel";
import type {
  ApprovalRow,
  ChatMessage,
  ChatResponse,
  FaultName,
  FaultsSnapshot,
  Persona,
  ThreadSummary,
} from "./types";
import { useEvents } from "./useEvents";

function messageFrom(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

export function App() {
  const [tab, setTab] = useState<"console" | "audit">("console");
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [faults, setFaults] = useState<FaultsSnapshot>({});
  const [faultsBusy, setFaultsBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [selectedPersona, setSelectedPersona] = useState<Persona | null>(null);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [pendingApproval, setPendingApproval] = useState<ApprovalRow | null>(null);
  const [sending, setSending] = useState(false);
  const [resolvingApproval, setResolvingApproval] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);

  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const { events, streamingReply } = useEvents(threadId);
  const lastHandledInterruptId = useRef<number | null>(null);

  const refreshThreads = useCallback(() => {
    setHistoryLoading(true);
    getThreads()
      .then((res) => setThreads(res.threads))
      .catch((err: unknown) => setLoadError(messageFrom(err, "Failed to load conversation history.")))
      .finally(() => setHistoryLoading(false));
  }, []);

  useEffect(() => {
    Promise.all([getPersonas(), getFaults()])
      .then(([personasRes, faultsRes]) => {
        setPersonas(personasRes.personas);
        setFaults(faultsRes.faults);
      })
      .catch((err: unknown) => setLoadError(messageFrom(err, "Failed to load personas/faults from the server.")));
    refreshThreads();
  }, [refreshThreads]);

  // Robustness per the UI spec: hydrate from server state whenever a thread
  // becomes active, even though a freshly generated threadId will usually
  // come back empty.
  useEffect(() => {
    if (!threadId) return;
    let cancelled = false;
    getThreadState(threadId)
      .then((state) => {
        if (cancelled) return;
        if (state.messages.length > 0) setMessages(state.messages);
        if (state.pendingApproval) setPendingApproval(state.pendingApproval);
      })
      .catch(() => {
        // Fresh thread with nothing to hydrate yet; not an error worth surfacing.
      });
    return () => {
      cancelled = true;
    };
  }, [threadId]);

  // The agent pauses at an issue_refund/issue_credit interrupt() before the
  // POST /api/chat response even returns, so a `guardrail` event with
  // payload.stage === "interrupt" is a reliable live trigger to reveal the
  // approval banner (see also the direct fetch in handleSend below, which
  // covers the same case without waiting on the SSE round trip).
  useEffect(() => {
    if (!threadId) return;
    const interruptEvent = [...events]
      .reverse()
      .find((event) => event.type === "guardrail" && event.payload.stage === "interrupt");
    if (!interruptEvent || interruptEvent.id === lastHandledInterruptId.current) return;
    lastHandledInterruptId.current = interruptEvent.id;
    getPendingApproval(threadId)
      .then((res) => setPendingApproval(res.approval))
      .catch((err: unknown) => setChatError(messageFrom(err, "Failed to load the pending approval.")));
  }, [events, threadId]);

  function handleSelectPersona(persona: Persona) {
    setSelectedPersona(persona);
    setThreadId(`${persona.customerId}_${Date.now()}`);
    setMessages([]);
    setPendingApproval(null);
    setChatError(null);
    lastHandledInterruptId.current = null;
  }

  function handleSelectThread(thread: ThreadSummary) {
    const persona =
      personas.find((p) => p.customerId === thread.customerId) ??
      (thread.customerId
        ? { customerId: thread.customerId, name: thread.personaName ?? thread.customerId, label: thread.personaLabel ?? "" }
        : null);
    setSelectedPersona(persona);
    setThreadId(thread.threadId);
    setMessages([]);
    setPendingApproval(null);
    setChatError(null);
    lastHandledInterruptId.current = null;
  }

  async function handleToggleFault(name: FaultName, enabled: boolean) {
    setFaultsBusy(true);
    try {
      const res = await setFault(name, enabled);
      setFaults(res.faults);
    } catch (err) {
      setLoadError(messageFrom(err, "Failed to update fault."));
    } finally {
      setFaultsBusy(false);
    }
  }

  async function handleClearFaults() {
    setFaultsBusy(true);
    try {
      const res = await clearFaults();
      setFaults(res.faults);
    } catch (err) {
      setLoadError(messageFrom(err, "Failed to clear faults."));
    } finally {
      setFaultsBusy(false);
    }
  }

  async function handleSend(text: string) {
    if (!threadId || !selectedPersona) return;
    setSending(true);
    setChatError(null);
    setMessages((prev) => [...prev, { role: "customer", content: text }]);
    try {
      const res = await sendChatMessage(threadId, selectedPersona.customerId, text);
      if (res.status === "awaiting_approval" && res.reply === null) {
        const pending = await getPendingApproval(threadId);
        setPendingApproval(pending.approval);
      } else if (res.reply !== null) {
        setMessages((prev) => [...prev, { role: "agent", content: res.reply as string }]);
      }
    } catch (err) {
      setChatError(messageFrom(err, "Failed to send message."));
    } finally {
      setSending(false);
      refreshThreads();
    }
  }

  async function handleApprovalDecision(decision: "approve" | "reject") {
    if (!threadId || !pendingApproval) return;
    setResolvingApproval(true);
    setChatError(null);
    try {
      const res = await resolveApproval(threadId, pendingApproval.id, decision);
      setPendingApproval(null);
      if (res.reply !== null) {
        setMessages((prev) => [...prev, { role: "agent", content: res.reply as string }]);
      }
    } catch (err) {
      setChatError(messageFrom(err, "Failed to resolve approval."));
    } finally {
      setResolvingApproval(false);
      refreshThreads();
    }
  }

  // Called after the audit tab resolves an approval that may belong to any
  // thread. The reply only belongs in the transcript when the resolved thread
  // is the one currently selected here.
  function handleAuditResolved(resolvedThreadId: string, result: ChatResponse) {
    if (resolvedThreadId === threadId) {
      setPendingApproval(null);
      if (result.reply !== null) {
        setMessages((prev) => [...prev, { role: "agent", content: result.reply as string }]);
      }
    }
    refreshThreads();
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1>Support Agent Console</h1>
        <nav className="app-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "console"}
            className={`app-tab${tab === "console" ? " app-tab-active" : ""}`}
            onClick={() => setTab("console")}
          >
            Console
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "audit"}
            className={`app-tab${tab === "audit" ? " app-tab-active" : ""}`}
            onClick={() => setTab("audit")}
          >
            Audit
          </button>
        </nav>
      </header>
      {loadError && <div className="inline-error app-load-error">{loadError}</div>}
      {/* The console unmounts rather than hiding when the audit tab is active.
          That is safe because the SSE route replays a thread's stored events on
          reconnect, so the trace panel rebuilds losslessly, and messages live
          here in App and survive regardless. Only the live typing cursor
          resets. Do not "optimize" this into a CSS-hidden layout. */}
      {tab === "console" ? (
        <div className="app-layout">
          <HistoryPanel
            threads={threads}
            selectedThreadId={threadId}
            onSelectThread={handleSelectThread}
            loading={historyLoading}
          />
          <PersonaPanel
            personas={personas}
            selectedCustomerId={selectedPersona?.customerId ?? null}
            onSelectPersona={handleSelectPersona}
            faults={faults}
            onToggleFault={handleToggleFault}
            onClearFaults={handleClearFaults}
            faultsBusy={faultsBusy}
          />
          <Chat
            personaLabel={selectedPersona ? `${selectedPersona.name} (${selectedPersona.label})` : null}
            messages={messages}
            pendingApproval={pendingApproval}
            sending={sending}
            resolvingApproval={resolvingApproval}
            streamingReply={streamingReply}
            error={chatError}
            onSend={handleSend}
            onApprovalDecision={handleApprovalDecision}
          />
          <TracePanel events={events} />
        </div>
      ) : (
        <AuditPanel onResolved={handleAuditResolved} />
      )}
    </div>
  );
}
