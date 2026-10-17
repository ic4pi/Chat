/**
 * Plan — the build checklist, readable at a glance. Done items are crossed
 * out. The orchestrator keeps it current; you can tick items by hand too.
 */

import { parsePlan, togglePlanLine } from './buildPlan.js';

interface Props {
  open: boolean;
  onClose: () => void;
  plan: string;
  onChange: (md: string) => void;
}

export function PlanPanel({ open, onClose, plan, onChange }: Props) {
  if (!open) return null;
  const p = parsePlan(plan);
  const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;

  return (
    <div className="ws-backdrop" onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 100, display: 'flex', justifyContent: 'flex-end' }}>
      <div className="ws-panel" role="dialog" aria-modal="true" aria-label="Build plan"
        onClick={e => e.stopPropagation()}
        style={{ width: 'min(420px, 100vw)', height: '100%', background: 'var(--surface)',
          borderLeft: '1px solid var(--border)', overflowY: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '14px 20px', borderBottom: '1px solid var(--border)', position: 'sticky', top: 0,
          background: 'var(--surface)', zIndex: 1 }}>
          <strong style={{ fontSize: 16, color: 'var(--text)' }}>Build plan</strong>
          <button type="button" className="ws-btn" onClick={onClose} aria-label="Close plan"
            style={{ background: 'transparent', color: 'var(--text-muted)', border: '1px solid var(--border)',
              borderRadius: 'var(--radius)', width: 28, height: 28, cursor: 'pointer', fontSize: 16, lineHeight: 1 }}>
            ×
          </button>
        </div>

        {!p.total ? (
          <p style={{ padding: '16px 20px', fontSize: 14, color: 'var(--text-dim)', lineHeight: 1.5 }}>
            No plan yet. Ask the orchestrator to plan a build — it writes the checklist here and ticks it off as work lands.
          </p>
        ) : (
          <>
            <div style={{ padding: '14px 20px 4px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: 'var(--text-muted)', marginBottom: 6 }}>
                <span>{p.done} of {p.total} done</span><span>{pct}%</span>
              </div>
              <div style={{ height: 6, background: 'var(--bg)', borderRadius: 3, overflow: 'hidden' }}>
                <div style={{ width: `${pct}%`, height: '100%', background: 'var(--accent)' }} />
              </div>
            </div>
            {p.groups.map((g, gi) => {
              const gd = g.items.filter(i => i.done).length;
              return (
                <section key={gi} style={{ padding: '14px 20px', borderBottom: '1px solid var(--border)' }}>
                  {g.name && (
                    <h3 style={{ margin: '0 0 8px', fontSize: 14, fontWeight: 700, color: 'var(--text)',
                      textDecoration: gd === g.items.length ? 'line-through' : 'none' }}>
                      {g.name} <span style={{ fontWeight: 400, color: 'var(--text-dim)' }}>{gd}/{g.items.length}</span>
                    </h3>
                  )}
                  {g.items.map(it => (
                    <label key={it.line} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '5px 0',
                      fontSize: 14, cursor: 'pointer', lineHeight: 1.4,
                      color: it.done ? 'var(--text-dim)' : 'var(--text)',
                      textDecoration: it.done ? 'line-through' : 'none' }}>
                      <input type="checkbox" checked={it.done}
                        onChange={() => onChange(togglePlanLine(plan, it.line))}
                        style={{ accentColor: 'var(--accent)', width: 16, height: 16, marginTop: 2, cursor: 'pointer' }} />
                      <span>{it.text}</span>
                    </label>
                  ))}
                </section>
              );
            })}
            <div style={{ padding: '14px 20px' }}>
              <button type="button" className="ws-btn" onClick={() => onChange('')}
                style={{ background: 'transparent', color: 'var(--text-dim)', border: '1px solid var(--border)',
                  borderRadius: 'var(--radius)', padding: '6px 12px', fontSize: 13, cursor: 'pointer' }}>
                Clear plan
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
