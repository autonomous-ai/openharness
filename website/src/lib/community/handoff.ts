const idPattern = /^(?:starter-[a-z0-9-]{1,80}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/;
const requestPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export function desktopForkLink(id: string, request: string): string {
  if (!idPattern.test(id) || !requestPattern.test(request)) throw new Error('Invalid fork link.');
  return `harness://fork/${id}?request=${request}`;
}

/** Reuse an unfinished handoff when returning from installing or signing in. */
export function forkRequestId(id: string): string {
  const key = `harness.fork.${id}`;
  try {
    const saved = sessionStorage.getItem(key);
    if (saved && requestPattern.test(saved)) return saved;
    const value = crypto.randomUUID(); sessionStorage.setItem(key, value); return value;
  } catch { return crypto.randomUUID(); }
}
