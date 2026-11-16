import { isVercelCron } from '../lib/cron-auth.js';
let failed = 0; const ok = (n, c) => { console.log(`${c ? 'ok  ' : 'FAIL'} ${n}`); if (!c) failed++; };
const req = (h) => ({ headers: h });
ok('the real cron (Bearer CRON_SECRET) is accepted', isVercelCron(req({ authorization: 'Bearer s3cret-value' }), 's3cret-value'));
ok('a wrong secret is refused', !isVercelCron(req({ authorization: 'Bearer nope' }), 's3cret-value'));
ok('a forged x-vercel-cron header proves nothing', !isVercelCron(req({ 'x-vercel-cron': '1' }), 's3cret-value'));
ok('no header is refused', !isVercelCron(req({}), 's3cret-value'));
ok('with no CRON_SECRET configured nothing counts as cron', !isVercelCron(req({ authorization: 'Bearer ' }), '') && !isVercelCron(req({ authorization: 'Bearer undefined' }), undefined));
process.exit(failed ? 1 : 0);
