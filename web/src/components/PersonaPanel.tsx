import type { FaultName, FaultsSnapshot, Persona } from "../types";
import { FAULT_NAMES } from "../types";

interface PersonaPanelProps {
  personas: Persona[];
  selectedCustomerId: string | null;
  onSelectPersona: (persona: Persona) => void;
  faults: FaultsSnapshot;
  onToggleFault: (name: FaultName, enabled: boolean) => void;
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
            return (
              <li key={name} className="fault-row">
                <label>
                  <input
                    type="checkbox"
                    checked={enabled}
                    disabled={faultsBusy}
                    onChange={(event) => onToggleFault(name, event.target.checked)}
                  />
                  <span>{faultLabel(name)}</span>
                </label>
                {state?.remaining !== undefined && <span className="fault-remaining">{state.remaining} left</span>}
              </li>
            );
          })}
        </ul>
      </section>
    </aside>
  );
}
