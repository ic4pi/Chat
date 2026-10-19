// A tiny in-memory stand-in for the Supabase query builder: just the calls the
// Claw routes make. Rows get ids/timestamps like the real tables.
import { randomUUID } from 'node:crypto';

export function makeFakeDb(clock = () => Date.now()) {
  const tables = {};
  const t = (n) => (tables[n] ||= []);
  const nowIso = () => new Date(clock()).toISOString();

  function builder(table) {
    const q = { op: 'select', filters: [], order: null, limit: null, patch: null, row: null, wantRows: false };
    const apply = () => {
      let rows = t(table).filter((r) => q.filters.every((f) => f(r)));
      if (q.order) rows = rows.slice().sort((a, b) => (a[q.order.col] < b[q.order.col] ? -1 : a[q.order.col] > b[q.order.col] ? 1 : 0) * (q.order.asc ? 1 : -1));
      if (q.limit != null) rows = rows.slice(0, q.limit);
      return rows;
    };
    const exec = () => {
      if (q.op === 'insert') {
        const row = { ...q.row };
        if (table !== 'claw_pair_codes' && !row.id) row.id = randomUUID();
        if (!row.created_at) row.created_at = nowIso();
        if (table === 'claw_jobs') { row.updated_at ||= nowIso(); row.results ??= null; row.device_id ??= null; }
        if (table === 'claw_devices') { row.last_seen_at ??= null; }
        if (table === 'claw_devices' && t(table).some((r) => r.token_hash === row.token_hash)) return { data: null, error: { message: 'duplicate token' } };
        t(table).push(row);
        return { data: q.wantRows ? [row] : null, error: null };
      }
      if (q.op === 'update') {
        const rows = apply();
        for (const r of rows) Object.assign(r, q.patch);
        return { data: q.wantRows ? rows.map((r) => ({ ...r })) : null, error: null };
      }
      if (q.op === 'delete') {
        const rows = new Set(apply());
        tables[table] = t(table).filter((r) => !rows.has(r));
        return { data: null, error: null };
      }
      return { data: apply().map((r) => ({ ...r })), error: null };
    };
    const api = {
      select() { if (q.op === 'insert' || q.op === 'update') q.wantRows = true; return api; },
      insert(row) { q.op = 'insert'; q.row = row; return api; },
      update(patch) { q.op = 'update'; q.patch = patch; return api; },
      delete() { q.op = 'delete'; return api; },
      eq(c, v) { q.filters.push((r) => r[c] === v); return api; },
      lt(c, v) { q.filters.push((r) => r[c] != null && r[c] < v); return api; },
      in(c, vs) { q.filters.push((r) => vs.includes(r[c])); return api; },
      order(col, { ascending = true } = {}) { q.order = { col, asc: ascending }; return api; },
      limit(n) { q.limit = n; return api; },
      maybeSingle() { const r = exec(); return Promise.resolve({ data: Array.isArray(r.data) ? (r.data[0] || null) : r.data, error: r.error }); },
      single() { const r = exec(); return Promise.resolve({ data: Array.isArray(r.data) ? (r.data[0] || null) : r.data, error: r.error }); },
      then(res, rej) { return Promise.resolve(exec()).then(res, rej); },
    };
    return api;
  }
  return { from: builder, tables };
}
