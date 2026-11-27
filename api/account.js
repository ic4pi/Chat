// /api/account — sign up, sign in, sign out, password reset, and "I am the owner".
//
//   GET  ?op=me                              → { account } (null when signed out)
//   POST ?op=signup        { email, password }
//   POST ?op=login         { email, password }
//   POST ?op=logout
//   POST ?op=reset-request { email }         → emails a one-hour link (always answers "sent")
//   POST ?op=reset         { token, password }
//   POST ?op=claim-owner   { adminUser, adminPassword }   (signed in) → marks THIS account the owner
//
// Same-origin only (no CORS headers): the session is an HttpOnly SameSite=Lax cookie.
// The logic lives in lib/account-route.js so the tests can run it on a fake database.

import { accountsApi, resolveOwner } from '../lib/hub.js';
import { makeAccountRoute } from '../lib/account-route.js';
import { emailAccount } from '../lib/lead-ops.js';

export default makeAccountRoute({ accountsApi, resolveOwner, emailAccount });
