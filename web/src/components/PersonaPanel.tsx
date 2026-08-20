import { useState } from "react";
import type { FaultName, FaultsSnapshot, Persona } from "../types";
import { FAULT_NAMES } from "../types";

interface PersonaPanelProps {
  personas: Persona[];
  selectedCustomerId: string | null;
  onSelectPersona: (persona: Persona) => void;
  faults: FaultsSnapshot;
  onToggleFault: (name: FaultName, enabled: boolean) => Promise<void>;
  onClearFaults: () => void;
  faultsBusy: boolean;
}

function faultLabel(name: FaultName): string {
  return name.replace(/_/g, " ");
}

export function PersonaPanel({
  personas,
  selectedCustomerId,
  onSelectPersona,
  faults,
  onToggleFault,
  onClearFaults,
  faultsBusy,
}: PersonaPanelProps) {
  // Track which individual fault is mid-flight so the checkbox reflects a
  // pending state and only shows as applied once the server ack (setFault)
  // resolves, rather than trusting the browser's optimistic native toggle.
  const [pendingFaults, setPendingFaults] = useState<Set<FaultName>>(new Set());

  async function handleToggle(name: FaultName, checked: boolean) {
    setPendingFaults((prev) => new Set(prev).add(name));
    try {
      await onToggleFault(name, checked);
    } finally {
      setPendingFaults((prev) => {
        const next = new Set(prev);
        next.delete(name);
        return next;
      });
    }
  }

  return (
    <aside className="panel persona-panel">
      <section>
        <h2>Persona</h2>
        <select
          className="persona-select"
          value={selectedCustomerId ?? ""}
          onChange={(event) => {
            const persona = personas.find((p) => p.customerId === event.target.value);
            if (persona) onSelectPersona(persona);
          }}
        >
          <option value="" disabled>
            Select a persona...
          </option>
          {personas.map((persona) => (
            <option key={persona.customerId} value={persona.customerId}>
              {persona.name} ({persona.label})
            </option>
          ))}
        </select>
      </section>

      <section className="fault-section">
        <div className="fault-header">
          <h2>Fault toggles</h2>
          <button type="button" className="secondary-button" onClick={onClearFaults} disabled={faultsBusy}>
            Clear all
          </button>
        </div>
        <p className="fault-caption">Demo-only fault injection; unauthenticated in this single-tenant demo.</p>
        <ul className="fault-list">
          {FAULT_NAMES.map((name) => {
            const state = faults[name];
            const enabled = state?.enabled ?? false;
            const pending = pendingFaults.has(name);
            const inputId = `fault-toggle-${name}`;
            return (
              <li key={name} className="fault-row">
                <label htmlFor={inputId}>
                  <input
                    id={inputId}
                    type="checkbox"
                    checked={enabled}
                    disabled={faultsBusy || pending}
                    aria-busy={pending}
                    onChange={(event) => {
                      void handleToggle(name, event.target.checked);
                    }}
                  />
                  <span>{faultLabel(name)}</span>
                </label>
                {pending ? (
                  <span className="fault-remaining">updating...</span>
                ) : (
                  state?.remaining !== undefined && <span className="fault-remaining">{state.remaining} left</span>
                )}
              </li>
            );
          })}
        </ul>
      </section>
    </aside>
  );
}
