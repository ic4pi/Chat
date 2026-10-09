/**
 * "Who builds this?" — shown under a persona's brief before any code is
 * written. Pick the team, the builder and the fixer, and optionally a second
 * builder to compare two versions side by side (off unless you ask for it —
 * a simple site doesn't need two).
 */

import { useState } from 'react';
import { PRESETS, costStars, isUncensoredModel, stars, type PresetId, type SeatModel, type TeamSeats } from './codingTeam.js';
import type { CatalogModel } from './providerPrefs.js';

export interface BuildChoiceSeats {
  builder: SeatModel;
  fixer: SeatModel;
  second: SeatModel | null;
}

/** A model one of the teams uses, labelled for the menu. */
export interface TeamOption extends SeatModel { label: string }

interface Props {
  seats: TeamSeats;
  /** Every team's models — offered first in each menu. */
  teamOptions?: TeamOption[];
  /** Each team's cost, ⭐ to ⭐⭐⭐⭐, shown in the Team menu. */
  teamStars?: Partial<Record<PresetId, number>>;
  /** Set when paid seats are standing in with free models. */
  lockedNote?: string;
  preset: PresetId | 'custom';
  catalogs: Record<string, CatalogModel[]>;
  unlocked: boolean;
  /** Pre-tick "second version" — you asked for two. */
  wantCompare?: boolean;
  /** Your named teams, with their cost rating. */
  savedTeams?: Array<{ id: string; name: string; stars: number }>;
  /** The saved team the seats came from, if they still match it. */
  savedId?: string | null;
  onPreset: (id: PresetId) => void;
  onSavedTeam?: (id: string) => void;
  /** Keep these seats (with this Build and Fix) as a named team. */
  onSaveTeam?: (name: string, seats: TeamSeats) => void;
  onBuild: (choice: BuildChoiceSeats) => void;
}

const key = (s: SeatModel) => `${s.provider}::${s.model}`;
const parse = (k: string): SeatModel => {
  const i = k.indexOf('::');
  return { provider: k.slice(0, i), model: k.slice(i + 2) };
};

const PROVIDER_GROUPS: Array<{ provider: string; label: string; keep: (m: CatalogModel) => boolean }> = [
  { provider: 'venice', label: 'Venice — uncensored', keep: () => true },
  { provider: 'openrouter', label: 'OpenRouter — free', keep: m => m.free !== false },
  { provider: 'openrouter', label: 'OpenRouter — coders (paid)', keep: m => m.free === false && (m.categories || []).includes('coder') },
];

function SeatSelect({ value, catalogs, unlocked, onChange, testId, teamOptions = [] }: {
  value: SeatModel; catalogs: Record<string, CatalogModel[]>; unlocked: boolean;
  onChange: (s: SeatModel) => void; testId: string; teamOptions?: TeamOption[];
}) {
  const inTeams = teamOptions.some(o => key(o) === key(value));
  const known = inTeams || PROVIDER_GROUPS.some(g => (catalogs[g.provider] || []).some(m => g.keep(m) && m.id === value.model && g.provider === value.provider));
  return (
    <select data-testid={testId} value={key(value)} onChange={e => onChange(parse(e.target.value))}
      style={{ background: '#12151D', color: '#ECEEF3', border: '1px solid #232838', borderRadius: 4,
        padding: '5px 6px', fontFamily: 'inherit', fontSize: 14, minWidth: 0, flex: '1 1 220px', maxWidth: 440 }}>
      {!known && <option value={key(value)}>{value.model}</option>}
      {teamOptions.length > 0 && (
        <optgroup label="Team picks">
          {teamOptions.map(o => {
            const meta = (catalogs[o.provider] || []).find(m => m.id === o.model);
            const locked = !!meta && meta.free === false && !unlocked;
            return <option key={`team:${key(o)}`} value={key(o)} disabled={locked}>{o.label}{locked ? ' 🔒' : ''}</option>;
          })}
        </optgroup>
      )}
      {PROVIDER_GROUPS.filter(g => !teamOptions.length || g.provider === 'venice' || g.label.includes('free')).map(g => {
        const list = (catalogs[g.provider] || []).filter(g.keep);
        if (!list.length) return null;
        return (
          <optgroup key={g.label} label={g.label}>
            {list.map(m => {
              const locked = m.free === false && !unlocked;
              return (
                <option key={`${g.provider}:${m.id}`} value={key({ provider: g.provider, model: m.id })} disabled={locked}>
                  {m.name || m.id}{locked ? ' 🔒' : ''}
                </option>
              );
            })}
          </optgroup>
        );
      })}
    </select>
  );
}

function Tag({ seat, catalogs }: { seat: SeatModel; catalogs: Record<string, CatalogModel[]> }) {
  const open = isUncensoredModel(seat.provider, seat.model);
  const meta = (catalogs[seat.provider] || []).find(m => m.id === seat.model);
  return (
    <span style={{ fontSize: 12, color: open ? '#34D399' : '#FFB86B', whiteSpace: 'nowrap' }}>
      {open ? 'uncensored' : 'filtered'} · {stars(costStars(seat.provider, meta))}
    </span>
  );
}

export function BuildPicker({ seats, teamOptions, teamStars = {}, lockedNote, preset, catalogs, unlocked, wantCompare,
  savedTeams = [], savedId, onPreset, onSavedTeam, onSaveTeam, onBuild }: Props) {
  const [builder, setBuilder] = useState<SeatModel>(seats.build);
  const [fixer, setFixer] = useState<SeatModel>(seats.fix);
  const [compare, setCompare] = useState(!!wantCompare);
  // A different take than the builder by default — the review seat's model.
  const [second, setSecond] = useState<SeatModel>(
    key(seats.review) !== key(seats.build) ? seats.review : seats.plan,
  );

  const row = (label: string, hint: string, control: React.ReactNode, tag?: React.ReactNode) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <span style={{ width: 52, fontSize: 13, fontWeight: 700, color: '#C9CEDA' }} title={hint}>{label}</span>
      {control}
      {tag}
    </div>
  );

  return (
    <div data-testid="build-picker" style={{ marginTop: 8, padding: '10px 12px', borderRadius: 6,
      border: '1px solid rgba(255,61,142,.45)', background: 'rgba(255,61,142,.05)', display: 'flex',
      flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 13, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#FF9FC4' }}>
          Who builds this?
        </strong>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 13, color: '#9198AA' }}>Team</span>
        <select data-testid="team-preset" value={preset !== 'custom' ? preset : savedId && savedTeams.some(t => t.id === savedId) ? `saved:${savedId}` : ''}
          onChange={e => {
            const v = e.target.value;
            if (v.startsWith('saved:')) onSavedTeam?.(v.slice(6));
            else if (v) onPreset(v as PresetId);
          }}
          title={preset === 'custom' ? 'Your own seats' : PRESETS[preset].blurb}
          style={{ background: '#12151D', color: '#ECEEF3', border: '1px solid #232838', borderRadius: 4,
            padding: '3px 6px', fontFamily: 'inherit', fontSize: 14, maxWidth: '100%' }}>
          {preset === 'custom' && !(savedId && savedTeams.some(t => t.id === savedId)) && <option value="">Custom</option>}
          <optgroup label="Teams">
            {(Object.keys(PRESETS) as PresetId[]).map(id => (
              <option key={id} value={id}>{PRESETS[id].label}{teamStars[id] ? ` ${stars(teamStars[id]!)}` : ''}</option>
            ))}
          </optgroup>
          {savedTeams.length > 0 && (
            <optgroup label="Your teams">
              {savedTeams.map(t => <option key={t.id} value={`saved:${t.id}`}>{t.name} {stars(t.stars)}</option>)}
            </optgroup>
          )}
        </select>
      </div>
      {lockedNote && (
        <div data-testid="locked-note" style={{ fontSize: 13, color: '#FFB86B', lineHeight: 1.4 }}>{lockedNote}</div>
      )}
      {row('Build', 'Writes the code and all the content in it',
        <SeatSelect testId="seat-build" value={builder} catalogs={catalogs} unlocked={unlocked} onChange={setBuilder} teamOptions={teamOptions} />,
        <Tag seat={builder} catalogs={catalogs} />)}
      {row('Fix', 'Repairs what auto-test catches; hands back to the builder if it refuses',
        <SeatSelect testId="seat-fix" value={fixer} catalogs={catalogs} unlocked={unlocked} onChange={setFixer} teamOptions={teamOptions} />,
        <Tag seat={fixer} catalogs={catalogs} />)}
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, color: '#C9CEDA', cursor: 'pointer' }}>
        <input type="checkbox" data-testid="compare-toggle" checked={compare} onChange={e => setCompare(e.target.checked)} />
        Also build a second version to compare side by side
      </label>
      {compare && row('Build 2', 'A second builder for Compare',
        <SeatSelect testId="seat-second" value={second} catalogs={catalogs} unlocked={unlocked} onChange={setSecond} teamOptions={teamOptions} />,
        <Tag seat={second} catalogs={catalogs} />)}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <button type="button" data-testid="build-go"
          onClick={() => onBuild({ builder, fixer, second: compare ? second : null })}
          style={{ background: '#FF3D8E', color: '#0B0D12', border: 'none', borderRadius: 4, padding: '6px 16px',
            fontFamily: 'inherit', fontSize: 15, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0 }}>
          {compare ? 'Build both' : 'Build it'}
        </button>
        {onSaveTeam && (
          <button type="button" data-testid="team-save"
            title="Keep these seats as a named team — saved on this device and the server"
            onClick={() => {
              const current = savedTeams.find(t => t.id === savedId)?.name || '';
              const name = window.prompt('Name this team', current)?.trim();
              if (name) onSaveTeam(name, { ...seats, build: builder, fix: fixer });
            }}
            style={{ background: 'transparent', color: '#FF9FC4', border: '1px solid rgba(255,61,142,.45)', borderRadius: 4,
              padding: '5px 10px', fontFamily: 'inherit', fontSize: 14, cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0 }}>
            ★ Save team
          </button>
        )}
        <span style={{ fontSize: 12, color: '#656C7E', flex: '1 1 220px' }}>
          {preset !== 'custom' ? PRESETS[preset].blurb
            : savedTeams.find(t => t.id === savedId) ? `Your team “${savedTeams.find(t => t.id === savedId)!.name}”.` : 'Your own seats.'}
        </span>
      </div>
    </div>
  );
}
