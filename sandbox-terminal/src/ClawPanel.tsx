/**
 * Dr Claw panel — the helper on your computer, and the one approval for each batch.
 *
 * Nothing runs until you tap Run on the card. The card lists every step in plain
 * English with a risk label. One tap covers the whole batch; Stop interrupts it.
 */

import { useState } from 'react';
import {
  classifyAction, describeAction, worstLevel, clawPairStart, clawRemoveDevice,
  type ClawAction, type ClawJob, type ClawLevel, type ClawStatus, type ClawWorkflow,
} from './claw.js';

export interface ClawPending { actions: ClawAction[]; errors: string[]; workflowId?: string; workflowName?: string; revisionOf?: string }
export interface ClawRunState { job: ClawJob | null; starting: boolean; error: string }

interface Props {
  open: boolean;
  onClose: () => void;
  status: ClawStatus | null;
  statusError: string;
  onRefresh: () => void;
  pending: ClawPending | null;
  onRun: () => void;
  onDecline: () => void;
  run: ClawRunState | null;
  onStop: () => void;
  onDismissRun: () => void;
  workflows: ClawWorkflow[];
  onSaveWorkflow: (name: string, actions: ClawAction[]) => Promise<void>;
  onRunWorkflow: (id: string) => void;
  onSetAutoRun: (id: string, autoRun: boolean) => void;
  onDeleteWorkflow: (id: string) => void;
  onSuggest: (id: string) => void;
}

const LEVEL: Record<ClawLevel, { label: string; color: string }> = {
  safe: { label: 'safe', color: '#34D399' },
  caution: { label: 'caution', color: '#FBBF24' },
  danger: { label: 'careful', color: '#FB7185' },
  blocked: { label: 'refused', color: '#9CA3AF' },
};

const btn = (primary = false): React.CSSProperties => ({
  background: primary ? 'var(--accent)' : 'transparent', color: primary ? '#0B0D12' : 'var(--text-muted)',
  border: primary ? 'none' : '1px solid var(--border)', borderRadius: 'var(--radius)',
  padding: '7px 16px', cursor: 'pointer', fontFamily: 'inherit', fontSize: 14, fontWeight: primary ? 700 : 400,
});

function Copyable({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'stretch', margin: '4px 0' }}>
      <code style={{ flex: 1, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius)',
        padding: '6px 8px', fontSize: 12, color: 'var(--text)', wordBreak: 'break-all', userSelect: 'all' }}>{text}</code>
      <button type="button" className="ws-btn" style={{ ...btn(), padding: '0 10px' }}
        onClick={() => { void navigator.clipboard?.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500); }}>
        {done ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

function SaveWorkflow({ actions, onSave, label, defaultName = '' }: { actions: ClawAction[]; onSave: (name: string, actions: ClawAction[]) => Promise<void>; label: string; defaultName?: string }) {
  const [name, setName] = useState(defaultName);
  const [msg, setMsg] = useState('');
  if (!actions.length) return null;
  const save = async () => {
    if (!name.trim()) { setMsg('Give it a name first.'); return; }
    try { await onSave(name.trim(), actions); setMsg(`Saved as “${name.trim()}”.`); setName(''); }
    catch (e) { setMsg(e instanceof Error ? e.message : String(e)); }
  };
  return (
    <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px dashed var(--border)' }}>
      <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 6 }}>{label}</div>
      <div style={{ display: 'flex', gap: 6 }}>
        <input data-testid="claw-wf-name" value={name} onChange={e => setName(e.target.value)} placeholder="Name, e.g. Morning check" maxLength={60}
          style={{ flex: 1, background: 'var(--bg)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '6px 8px', fontSize: 13, fontFamily: 'inherit' }} />
        <button type="button" data-testid="claw-wf-save" className="ws-btn" onClick={() => void save()} style={{ ...btn(), padding: '6px 12px', fontSize: 13 }}>Save workflow</button>
      </div>
      {msg && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>{msg}</div>}
    </div>
  );
}

export function ClawPanel(p: Props) {
  const { open, onClose, status, statusError, onRefresh, pending, onRun, onDecline, run, onStop, onDismissRun,
    workflows, onSaveWorkflow, onRunWorkflow, onSetAutoRun, onDeleteWorkflow, onSuggest } = p;
  const [code, setCode] = useState<{ code: string; expiresAt: string } | null>(null);
  const [codeError, setCodeError] = useState('');
  if (!open) return null;

  const online = !!status?.online;
  const device = status?.devices.find(d => d.online) || status?.devices[0];
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const running = !!run?.job && (run.job.status === 'approved' || run.job.status === 'running');
  const blockedCount = pending ? pending.actions.filter(a => classifyAction(a).level === 'blocked').length : 0;
  const worst = pending ? worstLevel(pending.actions) : 'safe';

  const getCode = async () => {
    setCodeError('');
    try { setCode(await clawPairStart()); } catch (e) { setCodeError(e instanceof Error ? e.message : String(e)); }
  };

  return (
    <div className="ws-backdrop" onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 100, display: 'flex', justifyContent: 'flex-end' }}>
      <div className="ws-panel" role="dialog" aria-modal="true" aria-label="Dr Claw" onClick={e => e.stopPropagation()}
        style={{ width: 'min(460px, 100vw)', height: '100%', background: 'var(--surface)',
          borderLeft: '1px solid var(--border)', overflowY: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 20px',
          borderBottom: '1px solid var(--border)', position: 'sticky', top: 0, background: 'var(--surface)', zIndex: 1 }}>
          <strong style={{ fontSize: 16, color: 'var(--text)' }}>Dr Claw · your computer</strong>
          <button type="button" className="ws-btn" onClick={onClose} aria-label="Close Dr Claw"
            style={{ background: 'transparent', color: 'var(--text-muted)', border: '1px solid var(--border)',
              borderRadius: 'var(--radius)', width: 28, height: 28, cursor: 'pointer', fontSize: 16, lineHeight: 1 }}>×</button>
        </div>

        <div data-testid="claw-status" style={{ padding: '12px 20px', borderBottom: '1px solid var(--border)', fontSize: 14 }}>
          <span style={{ color: online ? '#34D399' : 'var(--text-dim)' }}>{online ? '● Helper online' : '○ Helper not running'}</span>
          {device?.workdir && <span style={{ color: 'var(--text-dim)' }}> · folder {device.workdir}</span>}
          <button type="button" className="ws-btn" onClick={onRefresh} style={{ ...btn(), marginLeft: 8, padding: '2px 8px', fontSize: 12 }}>Refresh</button>
          {statusError && <div style={{ color: '#FB7185', fontSize: 12, marginTop: 4 }}>{statusError}</div>}
        </div>

        {pending && !run && (
          <section data-testid="claw-card" style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)' }}>
            <h3 style={{ margin: '0 0 4px', fontSize: 15, color: 'var(--text)' }}>
              Run plan — {pending.actions.length} step{pending.actions.length === 1 ? '' : 's'} on your computer
            </h3>
            <div style={{ fontSize: 13, color: LEVEL[worst].color, marginBottom: 10 }}>
              {worst === 'danger' ? 'Some steps change or delete things — read them.' : worst === 'blocked' ? 'Some steps will be refused.' : 'Nothing here deletes or installs anything.'}
            </div>
            <ol style={{ margin: '0 0 12px', paddingLeft: 20, fontSize: 14, color: 'var(--text)', lineHeight: 1.5 }}>
              {pending.actions.map((a, i) => {
                const c = classifyAction(a);
                return (
                  <li key={i} style={{ marginBottom: 6, opacity: c.level === 'blocked' ? 0.6 : 1 }}>
                    <span style={{ wordBreak: 'break-word' }}>{describeAction(a)}</span>{' '}
                    <span style={{ fontSize: 11, border: `1px solid ${LEVEL[c.level].color}`, color: LEVEL[c.level].color,
                      borderRadius: 3, padding: '0 5px', whiteSpace: 'nowrap' }}>{LEVEL[c.level].label}</span>
                    {c.reasons.length > 0 && <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>{c.reasons.join(' · ')}</div>}
                  </li>
                );
              })}
            </ol>
            {pending.errors.length > 0 && (
              <div style={{ fontSize: 12, color: '#FBBF24', marginBottom: 10 }}>
                Some lines could not be read and were left out: {pending.errors.join(' | ')}
              </div>
            )}
            {blockedCount > 0 && <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 10 }}>
              {blockedCount} step{blockedCount === 1 ? ' is' : 's are'} never run, so this plan cannot be started as written — ask the orchestrator to redo it without them.
            </div>}
            {!online && <div style={{ fontSize: 13, color: '#FBBF24', marginBottom: 10 }}>Your helper is not running, so there is nothing to run this on. Start it first (setup is below).</div>}
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" data-testid="claw-run" className="ws-btn" disabled={!online || blockedCount > 0} onClick={onRun}
                style={{ ...btn(true), opacity: !online || blockedCount > 0 ? 0.45 : 1, cursor: !online || blockedCount > 0 ? 'default' : 'pointer' }}>Run</button>
              <button type="button" data-testid="claw-decline" className="ws-btn" onClick={onDecline} style={btn()}>Don't run</button>
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 10 }}>
              One tap runs the whole list. Command output is sent back here and to your orchestrator.
            </div>
            {pending.workflowId
              ? <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 8 }}>Saved workflow “{pending.workflowName}”.</div>
              : blockedCount === 0 && (pending.revisionOf
                ? <SaveWorkflow actions={pending.actions} onSave={onSaveWorkflow} defaultName={pending.revisionOf}
                    label={`This is the suggested new version of “${pending.revisionOf}”. Run it to test it, then save it under the same name to replace the old steps.`} />
                : <SaveWorkflow actions={pending.actions} onSave={onSaveWorkflow} label="Run this often? Save it as a workflow to run again with one tap." />)}
          </section>
        )}

        {run && (
          <section data-testid="claw-run" style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)' }}>
            <h3 style={{ margin: '0 0 8px', fontSize: 15, color: 'var(--text)' }}>
              {run.starting ? 'Starting…' : run.job ? ({ approved: 'Waiting for your helper…', running: 'Running…', done: 'Finished', failed: 'Finished with a problem', cancelled: 'Stopped' } as Record<string, string>)[run.job.status] : 'Run'}
            </h3>
            {run.error && <div style={{ color: '#FB7185', fontSize: 13, marginBottom: 8 }}>{run.error}</div>}
            {run.job && run.job.actions.map((a, i) => {
              const r = run.job?.results?.[i];
              return (
                <details key={i} style={{ marginBottom: 6, fontSize: 13 }} open={!!r && !r.ok}>
                  <summary style={{ cursor: 'pointer', color: r ? (r.ok ? '#34D399' : '#FB7185') : 'var(--text-muted)' }}>
                    {r ? (r.ok ? '✓ ' : '✗ ') : '… '}{describeAction(a)}
                  </summary>
                  {r?.error && <div style={{ color: '#FB7185', margin: '4px 0' }}>{r.error}</div>}
                  {r?.output && <pre style={{ margin: '4px 0', maxHeight: 200, overflow: 'auto', background: 'var(--bg)', border: '1px solid var(--border)',
                    borderRadius: 'var(--radius)', padding: 8, fontSize: 12, whiteSpace: 'pre-wrap', color: 'var(--text)' }}>{r.output}</pre>}
                </details>
              );
            })}
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              {running && <button type="button" data-testid="claw-stop" className="ws-btn" onClick={onStop} style={btn()}>Stop</button>}
              {!running && !run.starting && <button type="button" className="ws-btn" onClick={onDismissRun} style={btn()}>Done</button>}
            </div>
            {!running && !run.starting && run.job && run.job.status === 'done' && (
              <SaveWorkflow actions={run.job.actions} onSave={onSaveWorkflow} label="That worked. Save these steps as a workflow to run again later." />
            )}
          </section>
        )}

        <section data-testid="claw-workflows" style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)' }}>
          <h3 style={{ margin: '0 0 8px', fontSize: 15, color: 'var(--text)' }}>Saved workflows</h3>
          {workflows.length === 0 && <div style={{ fontSize: 13, color: 'var(--text-dim)' }}>None yet. After a run, save its steps here to run again with one tap, or let a persona run it for you.</div>}
          {workflows.map(w => {
            const worstW = worstLevel(w.actions);
            return (
              <div key={w.id} data-testid="claw-wf" style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: 10, marginBottom: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <strong style={{ flex: 1, fontSize: 14, color: 'var(--text)', wordBreak: 'break-word' }}>{w.name}</strong>
                  <span style={{ fontSize: 11, border: `1px solid ${LEVEL[worstW].color}`, color: LEVEL[worstW].color, borderRadius: 3, padding: '0 5px' }}>{LEVEL[worstW].label}</span>
                  <button type="button" data-testid="claw-wf-run" className="ws-btn" disabled={!online || running || !!pending}
                    onClick={() => onRunWorkflow(w.id)} style={{ ...btn(true), padding: '4px 12px', fontSize: 13, opacity: !online || running || pending ? 0.45 : 1 }}>Run</button>
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-dim)', margin: '4px 0' }}>
                  {w.actions.length} step{w.actions.length === 1 ? '' : 's'} · run {w.runCount} time{w.runCount === 1 ? '' : 's'}{w.lastRunAt ? ` · last ${new Date(w.lastRunAt).toLocaleDateString()}` : ''}
                </div>
                <details style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  <summary style={{ cursor: 'pointer' }}>See the steps</summary>
                  <ol style={{ margin: '4px 0', paddingLeft: 18 }}>{w.actions.map((a, i) => <li key={i} style={{ wordBreak: 'break-word' }}>{describeAction(a)}</li>)}</ol>
                </details>
                <label style={{ display: 'flex', gap: 6, alignItems: 'flex-start', fontSize: 12, color: 'var(--text-muted)', marginTop: 6, cursor: 'pointer' }}>
                  <input type="checkbox" data-testid="claw-wf-auto" checked={w.autoRun} onChange={e => onSetAutoRun(w.id, e.target.checked)} style={{ marginTop: 2 }} />
                  <span>Let my personas run this without asking me each time. <span style={{ color: 'var(--text-dim)' }}>The helper still refuses anything dangerous, and you can Stop any run.</span></span>
                </label>
                <button type="button" data-testid="claw-wf-suggest" className="ws-btn" onClick={() => onSuggest(w.id)}
                  style={{ ...btn(), padding: '2px 10px', fontSize: 12, marginTop: 6, marginRight: 6 }}>Suggest improvements</button>
                <button type="button" className="ws-btn" onClick={() => { if (window.confirm(`Delete the workflow “${w.name}”?`)) onDeleteWorkflow(w.id); }}
                  style={{ ...btn(), padding: '2px 10px', fontSize: 12, marginTop: 6 }}>Delete</button>
              </div>
            );
          })}
        </section>

        <section style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)' }}>
          <details open={!status || status.devices.length === 0}>
            <summary style={{ cursor: 'pointer', fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>Set up the helper (Mac or Linux)</summary>
            <ol style={{ paddingLeft: 20, fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.6 }}>
              <li>Needs Node 18 or newer (<code>node --version</code>). Open Terminal.</li>
              <li>Download it:<Copyable text={`curl -O ${origin}/claw/claw.mjs`} /></li>
              <li>
                Get a one-time code (good for 10 minutes):{' '}
                <button type="button" data-testid="claw-code" className="ws-btn" onClick={() => void getCode()} style={{ ...btn(), padding: '3px 10px' }}>Get code</button>
                {code && <div data-testid="claw-code-value" style={{ fontSize: 22, fontWeight: 700, letterSpacing: '0.12em', color: 'var(--text)', margin: '6px 0' }}>{code.code}</div>}
                {codeError && <div style={{ color: '#FB7185' }}>{codeError}</div>}
              </li>
              <li>Pair it (it creates <code>~/Jive-Workspace</code> as its folder):<Copyable text={`node claw.mjs pair ${code?.code || 'ABCD-EFGH'} --server ${origin}`} /></li>
              <li>Start it, and leave the window open:<Copyable text="node claw.mjs" /></li>
            </ol>
            <div style={{ fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.5 }}>
              The helper only does what you approve here, keeps files inside its folder, refuses dangerous commands on its own, and logs everything to <code>~/.jive-claw/log.jsonl</code>. Ctrl+C stops it.
            </div>
          </details>
        </section>

        {status && status.devices.length > 0 && (
          <section style={{ padding: '16px 20px' }}>
            <h3 style={{ margin: '0 0 8px', fontSize: 14, color: 'var(--text)' }}>Paired computers</h3>
            {status.devices.map(d => (
              <div key={d.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13, color: 'var(--text-muted)', marginBottom: 6 }}>
                <span>{d.online ? '● ' : '○ '}{d.label || 'My computer'}</span>
                <button type="button" className="ws-btn" onClick={() => { void clawRemoveDevice(d.id).then(onRefresh); }} style={{ ...btn(), padding: '2px 10px', fontSize: 12 }}>Remove</button>
              </div>
            ))}
          </section>
        )}
      </div>
    </div>
  );
}
