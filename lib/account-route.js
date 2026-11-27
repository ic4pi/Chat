// The /api/account handler, built around its dependencies so the tests can run it on a fake database.
// Routes are listed in api/account.js.

import { clearSessionCookie, readSessionToken, sessionCookie } from './accounts.js';
import { isAdminSecret } from './access.js';
import { isBlocked, noteFailure, sendBlocked } from './throttle.js';
import { sendEmail as realSendEmail } from './email.js';

export function makeAccountRoute({ accountsApi, resolveOwner, emailAccount, sendEmail = realSendEmail }) {
  const json = (res, code, body) => { res.setHeader('Cache-Control', 'no-store'); return res.status(code).json(body); };
  const fail = (res, err) => json(res, err.status || 500, { error: err.status ? err.message : 'Something went wrong. Try again.' });

  return async function handler(req, res) {
    if (!accountsApi) return json(res, 503, { error: 'Accounts need the database (Supabase) to be configured.' });
    const op = String(req.query?.op || '');
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const token = readSessionToken(req);

    try {
      if (op === 'me' && req.method === 'GET') {
        return json(res, 200, { account: await accountsApi.accountFromToken(token) });
      }
      if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });

      if (op === 'signup') {
        if (await isBlocked(req, 'signup', { max: 10 })) return sendBlocked(res);
        await noteFailure(req, 'signup');   // every attempt counts: 10 new accounts per address per 15 minutes
        const account = await accountsApi.signup({ email: body.email, password: body.password });
        res.setHeader('Set-Cookie', sessionCookie(await accountsApi.createSession(account.id)));
        return json(res, 200, { account });
      }

      if (op === 'login') {
        if (await isBlocked(req, 'login')) return sendBlocked(res);
        const account = await accountsApi.login({ email: body.email, password: body.password });
        if (!account) {
          await noteFailure(req, 'login');
          return json(res, 401, { error: 'Wrong email or password.' });
        }
        res.setHeader('Set-Cookie', sessionCookie(await accountsApi.createSession(account.id)));
        return json(res, 200, { account });
      }

      if (op === 'logout') {
        await accountsApi.endSession(token);
        res.setHeader('Set-Cookie', clearSessionCookie());
        return json(res, 200, { ok: true });
      }

      if (op === 'reset-request') {
        if (await isBlocked(req, 'reset', { max: 5 })) return sendBlocked(res);
        await noteFailure(req, 'reset');
        const started = await accountsApi.startReset(body.email);
        if (started) {
          const mail = await emailAccount().catch(() => null);
          if (!mail) return json(res, 503, { error: 'Email is not set up on this site yet, so a reset link cannot be sent.' });
          const base = (process.env.SITE_URL || `https://${req.headers.host}`).replace(/\/$/, '');
          await sendEmail({
            apiKey: mail.resendApiKey, from: mail.fromEmail, to: started.account.email,
            subject: 'Reset your password',
            text: `Someone asked to reset the password for this account.\n\nOpen this link within an hour to choose a new one:\n${base}/?reset=${encodeURIComponent(started.token)}\n\nIf it wasn't you, ignore this email: nothing changes.`,
          }).catch((err) => console.error('reset email failed:', err.message));
        }
        return json(res, 200, { ok: true });   // same answer whether or not the account exists
      }

      if (op === 'reset') {
        if (await isBlocked(req, 'reset-token', { max: 10 })) return sendBlocked(res);
        try { await accountsApi.finishReset(body.token, body.password); }
        catch (err) { await noteFailure(req, 'reset-token'); throw err; }
        return json(res, 200, { ok: true });
      }

      if (op === 'claim-owner') {
        const account = await accountsApi.accountFromToken(token);
        if (!account) return json(res, 401, { error: 'Sign in first.' });
        if (await isBlocked(req, 'claim')) return sendBlocked(res);
        const secret = `${String(body.adminUser || '').trim()}:${String(body.adminPassword || '').trim()}`;
        if (!isAdminSecret(secret) && !(!process.env.ADMIN_USERNAME && isAdminSecret(body.adminPassword))) {
          await noteFailure(req, 'claim');
          return json(res, 403, { error: 'Those are not the admin username and password.' });
        }
        await accountsApi.markOwner(account.id);
        await resolveOwner(req, res).catch(() => null);   // links this device's existing memory to the account
        return json(res, 200, { account: await accountsApi.accountFromToken(token) });
      }

      return json(res, 404, { error: 'Unknown operation.' });
    } catch (err) {
      if (!err.status) console.error('account op failed:', op, err);
      return fail(res, err);
    }
  }
}
