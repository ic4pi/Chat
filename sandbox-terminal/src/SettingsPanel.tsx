/**
 * SettingsPanel — everything that used to be three separate toggle buttons
 * (Keys / Roles / Slices), each popping open its own cramped inline strip
 * squeezed into the toolbar row. One button opens this instead: a proper
 * overlay drawer with real room to read and click things.
 */

import React from 'react';
import { ChunkModelPanel, type GenerateChunkResult } from './ChunkModelPanel.js';
import { PROVIDER_LIST, type ProviderId } from './providerPrefs.js';

interface Props {
  open: boolean;
  onClose: () => void;
  keys: Record<string, string>;
  onKeySave: (providerId: ProviderId, value: string) => void;
  roleSummary: { write: string; review: string; plan: string };
  autoApplyOn: boolean;
  setAutoApplyOn: (v: boolean) => void;
  autoRun: boolean;
  setAutoRun: (v: boolean) => void;
  autoVerifyOn: boolean;
  setAutoVerifyOn: (v: boolean) => void;
  sandboxReady: boolean;
  contextText: string;
  onSliceComplete: (results: GenerateChunkResult[], combined: string) => void;
  /** The coding team: seats per phase, preset, ask-before-build. */
  teamSection?: React.ReactNode;
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)' }}>
      <h3 style={{ margin: '0 0 4px', fontSize: 15, fontWeight: 700, color: 'var(--text)', letterSpacing: '.01em' }}>
        {title}
      </h3>
      {hint && (
        <p style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--text-dim)', lineHeight: 1.5 }}>{hint}</p>
      )}
      {children}
    </section>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '8px 0', fontSize: 14, color: 'var(--text-muted)', cursor: 'pointer', userSelect: 'none' }}>
      {label}
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)}
        style={{ accentColor: 'var(--accent)', width: 16, height: 16, cursor: 'pointer' }} />
    </label>
  );
}

export function SettingsPanel(props: Props) {
  const { open, onClose, keys, onKeySave, roleSummary,
    autoApplyOn, setAutoApplyOn, autoRun, setAutoRun, autoVerifyOn, setAutoVerifyOn,
    sandboxReady, contextText, onSliceComplete, teamSection } = props;

  if (!open) return null;

  return (
    <div
      className="ws-backdrop"
      style={{ position: 'fixed', inset: 0, zIndex: 100, display: 'flex', justifyContent: 'flex-end' }}
      onClick={onClose}
    >
      <div
        className="ws-panel"
        role="dialog" aria-modal="true" aria-label="Workspace settings"
        onClick={e => e.stopPropagation()}
        style={{ width: 'min(420px, 100vw)', height: '100%', background: 'var(--surface)',
          borderLeft: '1px solid var(--border)', overflowY: 'auto', display: 'flex', flexDirection: 'column' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '14px 20px', borderBottom: '1px solid var(--border)', position: 'sticky', top: 0,
          background: 'var(--surface)', zIndex: 1 }}>
          <strong style={{ fontSize: 16, color: 'var(--text)' }}>Settings</strong>
          <button type="button" className="ws-btn" onClick={onClose} aria-label="Close settings"
            style={{ background: 'transparent', color: 'var(--text-muted)', border: '1px solid var(--border)',
              borderRadius: 'var(--radius)', width: 28, height: 28, cursor: 'pointer', fontSize: 16, lineHeight: 1 }}>
            ×
          </button>
        </div>

        {teamSection && (
          <Section title="Coding team" hint="One agent per coding phase. Your persona plans the brief; these build, review and fix it.">
            {teamSection}
          </Section>
        )}
        <Section title="API keys" hint="Stay in this browser only. Used when set; otherwise the server's own key is used.">
          <div style={{ display: 'grid', gap: 10 }}>
            {PROVIDER_LIST.map(p => (
              <label key={p.id} style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13, color: 'var(--text-muted)' }}>
                {p.label}
                <input type="password" autoComplete="off" className="ws-input"
                  value={keys[p.id] || ''}
                  placeholder={`${p.label} API key`}
                  onChange={e => onKeySave(p.id, e.target.value)}
                  style={{ background: 'var(--bg)', color: 'var(--text)', border: '1px solid var(--border)',
                    borderRadius: 'var(--radius)', padding: '7px 10px', fontFamily: 'inherit', fontSize: 14 }} />
              </label>
            ))}
          </div>
        </Section>

        <Section title="Role models" hint="Pick a role up top, then change provider/model — that assignment is saved per role.">
          <div style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.8 }}>
            <div>Write &nbsp;<code style={{ color: 'var(--text)' }}>{roleSummary.write}</code></div>
            <div>Review &nbsp;<code style={{ color: 'var(--text)' }}>{roleSummary.review}</code></div>
            <div>Plan &nbsp;<code style={{ color: 'var(--text)' }}>{roleSummary.plan}</code></div>
          </div>
        </Section>

        <Section title="Automation">
          <Toggle label="Auto-save to sandbox" checked={autoApplyOn} onChange={setAutoApplyOn} />
          <Toggle label="Auto-run code snippets" checked={autoRun} onChange={setAutoRun} />
          <Toggle label="Auto-test after saves" checked={autoVerifyOn} onChange={setAutoVerifyOn} />
        </Section>

        <Section title="Per-chunk models" hint="Assign a different model per code slice (HTML, CSS, JS…), then generate.">
          <ChunkModelPanel
            sandboxReady={sandboxReady}
            contextText={contextText}
            onComplete={onSliceComplete}
          />
        </Section>
      </div>
    </div>
  );
}
