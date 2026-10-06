const prefix = 'harness.web.v1.';
const get = (key: string) => localStorage.getItem(prefix + key);
const set = (key: string, value: string) => localStorage.setItem(prefix + key, value);

export function rememberHubReturn() {
  const path = window.location.pathname + window.location.search;
  sessionStorage.setItem('harness.hub.returnTo', path === '/hub' || path.startsWith('/hub/') ? path : '/hub');
}

/** The same origin-local session and Web Lock used by Flutter's BrowserAuth. */
export async function refreshHubSession(failedToken: string): Promise<boolean> {
  if (!navigator.locks) return false;
  const generation = get('auth_generation');
  return navigator.locks.request('harness.web.v1.auth', async () => {
    if (get('auth_generation') !== generation) return false;
    const current = get('auth_access_token');
    if (!current) return false;
    if (`Bearer ${current}` !== failedToken) return true;
    const refreshToken = get('auth_refresh_token');
    if (!refreshToken) return false;
    const autonomousEnv = get('auth_autonomous_env') === 'stag' ? 'stag' : 'prod';
    const clientId = get('auth_sso_client_id');
    const response = await fetch('/api/community/session/refresh', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store',
      body: JSON.stringify({ refreshToken, autonomousEnv, ...(clientId ? { clientId } : {}) }),
    });
    const body = await response.json();
    if (get('auth_generation') !== generation || get('auth_access_token') !== current) return false;
    if (response.status === 401 || body.error?.code === 'REFRESH_TOKEN_INVALID') {
      for (const key of ['auth_access_token', 'auth_refresh_token', 'auth_autonomous_env', 'auth_access_token_expires_at', 'auth_sso_client_id']) localStorage.removeItem(prefix + key);
      set('auth_generation', crypto.randomUUID());
      window.dispatchEvent(new Event('harness-session'));
      return false;
    }
    if (!response.ok || !body.success || !body.data?.token) throw new Error('Could not renew your sign-in. Please try again.');
    set('auth_access_token', body.data.token);
    if (body.data.refreshToken) set('auth_refresh_token', body.data.refreshToken);
    set('auth_autonomous_env', autonomousEnv);
    if (body.data.expiresIn > 0) set('auth_access_token_expires_at', String(Date.now() + body.data.expiresIn * 1000));
    else localStorage.removeItem(prefix + 'auth_access_token_expires_at');
    return true;
  });
}
