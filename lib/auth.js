'use strict';
// Supabase Auth (GoTrue) adapter. Passwords go straight to Supabase; this server never stores or logs them.
// Identity is verified by asking Supabase Auth about the bearer token (no local JWT secret is needed or read).
const { ApiError, e } = require('./errors');

function createSupabaseAuth({ url, anonKey, fetchImpl, timeoutMs = 8000 }) {
  const base = new URL(url);
  const doFetch = fetchImpl || require('node-fetch');

  async function request(path, { method = 'GET', body, token } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await doFetch(new URL(path, base).toString(), {
        method,
        headers: { 'Content-Type': 'application/json', apikey: anonKey, Authorization: `Bearer ${token || anonKey}` },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal
      });
      let data = null;
      try { data = await res.json(); } catch (_) { /* empty or non-JSON */ }
      if (res.status >= 500 || res.status === 429) throw e.unavailable('auth_unavailable', 'Authentication service unavailable.');
      if (res.status >= 200 && res.status < 300 && path !== '/auth/v1/logout?scope=local' && !data) throw e.unavailable('auth_unavailable', 'Authentication service unavailable.');
      return { status: res.status, data };
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw e.unavailable('auth_unavailable', 'Authentication service unavailable.');
    } finally {
      clearTimeout(timer);
    }
  }

  const sessionOf = d => ({
    access_token: d.access_token, refresh_token: d.refresh_token, token_type: 'bearer',
    expires_in: d.expires_in, expires_at: d.expires_at
  });
  const userOf = u => ({ id: u.id, email: u.email, ...(u.user_metadata && u.user_metadata.over_18 === true ? { over_18: true } : {}) });
  const errorCode = r => (r.data && typeof r.data.error_code === 'string' ? r.data.error_code : '');

  return {
    async signUp({ email, password, fullName, over18ConfirmedAt }) {
      const data = { ...(fullName ? { full_name: fullName } : {}), over_18: true, over_18_confirmed_at: over18ConfirmedAt };
      const r = await request('/auth/v1/signup', { method: 'POST', body: { email, password, data } });
      if (r.status >= 400) {
        if (errorCode(r) === 'weak_password') throw new ApiError(400, 'weak_password', 'Password is too weak.');
        throw new ApiError(400, 'signup_failed', 'Sign-up could not be completed.');
      }
      const d = r.data || {};
      if (d.access_token) return { user: userOf(d.user || {}), session: sessionOf(d), confirmation_required: false };
      return { user: userOf(d.user || d), session: null, confirmation_required: true };
    },
    async signIn({ email, password }) {
      const r = await request('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password } });
      if (r.status >= 400) {
        if (errorCode(r) === 'email_not_confirmed') throw e.forbidden('email_not_confirmed', 'Email address not confirmed.');
        throw e.unauthorized('invalid_credentials', 'Email or password is incorrect.');
      }
      return { user: userOf(r.data.user || {}), session: sessionOf(r.data) };
    },
    async refresh({ refreshToken }) {
      const r = await request('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: refreshToken } });
      if (r.status >= 400) throw e.unauthorized('invalid_refresh_token', 'Session expired. Please sign in again.');
      return { user: userOf(r.data.user || {}), session: sessionOf(r.data) };
    },
    // Supabase recover email. Always resolves for any account state (unknown email included); only an operational failure throws.
    async requestPasswordReset({ email, redirectTo }) {
      const r = await request('/auth/v1/recover?redirect_to=' + encodeURIComponent(redirectTo), { method: 'POST', body: { email } });
      if (r.status >= 400) throw e.unavailable('recovery_unavailable', 'Password recovery is unavailable. Please try again later.');
    },
    // Logged-in (or recovery-session) password change: PUT /user with the caller's own bearer. Returns nothing from the provider.
    async updatePassword(accessToken, password) {
      const r = await request('/auth/v1/user', { method: 'PUT', body: { password }, token: accessToken });
      if (r.status === 401 || r.status === 403) throw e.unauthorized('invalid_token', 'Invalid or expired token.');
      if (r.status >= 400) {
        if (errorCode(r) === 'weak_password') throw new ApiError(400, 'weak_password', 'Password is too weak.');
        if (errorCode(r) === 'same_password') throw new ApiError(400, 'same_password', 'Choose a different password from your current one.');
        throw new ApiError(400, 'password_update_failed', 'Password could not be changed.');
      }
    },
    async signOut(accessToken) {
      const r = await request('/auth/v1/logout?scope=local', { method: 'POST', token: accessToken });
      if (r.status === 401 || r.status === 403) throw e.unauthorized('invalid_token', 'Invalid or expired token.');
      if (r.status >= 400) throw e.unavailable('auth_unavailable', 'Authentication service unavailable.');
    },
    // -> { id, email } for a valid human account; throws 401 for bad tokens, 503 when Auth is unreachable.
    async verify(accessToken) {
      const r = await request('/auth/v1/user', { token: accessToken });
      if (r.status === 401 || r.status === 403 || r.status === 404) throw e.unauthorized('invalid_token', 'Invalid or expired token.');
      if (r.status >= 400 || !r.data) throw e.unavailable('auth_unavailable', 'Authentication service unavailable.');
      const u = r.data;
      if (typeof u.id !== 'string' || u.aud !== 'authenticated' || u.is_anonymous === true) throw e.forbidden('unsupported_account', 'This account type is not supported.');
      if (typeof u.email !== 'string' || !u.email) throw e.forbidden('unsupported_account', 'An email address is required.');
      return { id: u.id.toLowerCase(), email: u.email };
    }
  };
}

module.exports = { createSupabaseAuth };
