import type { SocialState } from './types';
import { refreshHubSession } from './session';

/** Read the existing Harness web session; the community does not mint a second identity. */
export function sessionHeaders(): Record<string, string> {
  try {
    const token = localStorage.getItem('harness.web.v1.auth_access_token');
    const env = localStorage.getItem('harness.web.v1.auth_autonomous_env');
    return { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'x-autonomous-env': env === 'stag' ? 'stag' : 'prod' };
  } catch { return {}; }
}

export class CommunityError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

export async function communityRequest<T>(path: string, options: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const headers = sessionHeaders();
  const request: RequestInit = {
    method: options.method || 'GET', signal: options.signal,
    headers: { ...headers, ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}), cache: 'no-store',
  };
  let response = await fetch(`/api/community/${path}`, request);
  if (response.status === 401 && headers.Authorization && await refreshHubSession(headers.Authorization)) {
    Object.assign(headers, sessionHeaders());
    response = await fetch(`/api/community/${path}`, { ...request, headers: { ...request.headers, ...headers } });
  }
  // An expired workspace sign-in must not hide public projects. Private following
  // views and all writes still require an authenticated request.
  if (response.status === 401 && request.method === 'GET' && headers.Authorization && path.startsWith('harnesses') && !new URLSearchParams(path.split('?')[1]).has('following') && !new URLSearchParams(path.split('?')[1]).has('mine')) {
    delete headers.Authorization;
    response = await fetch(`/api/community/${path}`, { ...request, headers });
  }
  const body = await response.json();
  if (!response.ok || !body.success) throw new CommunityError(body.error?.message || 'The community is temporarily unavailable. Try again.', response.status);
  return body.data as T;
}

export const emptySocial: SocialState = { likes: 0, liked: false, following: false, comments: [], signedIn: false, mine: false };
