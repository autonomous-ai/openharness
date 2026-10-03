/** Process-monitor presentation. Unknown readings always sort last. */
export const ACTIVITY = {
  needsInput: ['?', 'Needs you'], failed: ['✗', 'Failed'], working: ['⠋', 'Working'],
  starting: ['◌', 'Starting'], done: ['✓', 'Done'], idle: ['', 'Idle'],
  stopped: ['×', 'Stopped'], offline: ['⊘', 'Offline'], unknown: ['—', 'Unknown'],
}
export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
export const COLUMNS = [
  { key: 'name', label: 'Harness', width: 230, required: true, group: 'Session' },
  { key: 'activity', label: 'Status', width: 112, group: 'Session' },
  { key: 'workspaceBytes', label: 'Workspace', width: 120, numeric: true, group: 'Resources', help: 'Disk space used by the entire working folder: a project, worktree or subfolder. Shared folders repeat per row. Delete lets you review worktree cleanup separately from session data. Main project folders are protected.' },
  { key: 'sessionBytes', label: 'Session data', width: 130, numeric: true, group: 'Resources', help: 'Conversation history and Harness checkpoints stored on disk. Database sizes estimate conversation content, not the whole shared database. Deleting only session data keeps workspace files. — means not measured.' },
  { key: 'rssBytes', label: 'RAM', width: 88, numeric: true, group: 'Resources', help: 'Resident memory, including child processes. Shared memory pages can overlap. Shared servers appear separately.' },
  { key: 'cpu', label: 'CPU %', width: 80, numeric: true, group: 'Resources', help: 'Interval CPU of this process tree. 100% is one core; multiple cores can exceed 100%.' },
  { key: 'gpuPercent', label: 'GPU %', width: 80, numeric: true, group: 'Resources', help: 'GPU use of this process tree: GPU time per interval on supported macOS drivers, utilization on Linux NVIDIA. Can exceed 100% across processes or devices. First samples and unavailable counters show —. Cloud model GPU usage is not reported.' },
  { key: 'engine', label: 'Agent', width: 118, group: 'Session' },
  { key: 'tokens', label: 'Tokens', width: 98, numeric: true, group: 'AI usage', help: 'Total conversation input and output, including cached input once. Reported by the owning agent; — means unreported.' },
  { key: 'machine', label: 'Machine', width: 120, group: 'Session' },
  { key: 'project', label: 'Project', width: 180, group: 'Session' },
  { key: 'branch', label: 'Branch', width: 180, group: 'Session' },
  { key: 'tokensPerMinute', label: 'Tokens/min', width: 110, numeric: true, group: 'AI usage', help: 'Change in total conversation tokens per minute across recent ledger updates. Includes input and cache; not model output speed.' },
  { key: 'lastActivity', label: 'Last active', width: 110, numeric: true, group: 'Session', help: 'Last conversation activity reported by the daemon, not a file modification time.' },
  { key: 'model', label: 'Model', width: 190, group: 'AI usage', optional: true },
  { key: 'inputTokens', label: 'Input tokens', width: 116, numeric: true, group: 'AI usage', optional: true, help: 'Conversation input, including cache reads and cache writes.' },
  { key: 'outputTokens', label: 'Output tokens', width: 124, numeric: true, group: 'AI usage', optional: true, help: 'Conversation output, including reasoning once.' },
  { key: 'cachedTokens', label: 'Cached input', width: 124, numeric: true, group: 'AI usage', optional: true, help: 'Input read from cache. A subset of Input tokens; do not add it again.' },
  { key: 'gpuMemoryBytes', label: 'GPU memory', width: 122, numeric: true, group: 'Resources', optional: true, help: 'Reported NVIDIA compute allocations in this process tree. — means unavailable, not zero. Shared model servers are not charged to every conversation.' },
  { key: 'diskReadBytesPerSecond', label: 'Disk read/s', width: 112, numeric: true, group: 'Resources', optional: true, help: 'Process-tree physical disk reads per second on Linux. macOS or restricted counters show —.' },
  { key: 'diskWriteBytesPerSecond', label: 'Disk write/s', width: 116, numeric: true, group: 'Resources', optional: true, help: 'Process-tree physical disk writes per second on Linux. Counter resets show —.' },
  { key: 'transcriptBytes', label: 'Transcript', width: 108, numeric: true, group: 'Resources', optional: true, help: 'Size of the conversation file, where the agent uses an individual transcript. Shared databases show —.' },
  { key: 'processCount', label: 'Processes', width: 100, numeric: true, group: 'Resources', optional: true },
  { key: 'createdAt', label: 'Started', width: 110, numeric: true, group: 'Session', optional: true, help: 'When this harness was registered, including time before a resume.' },
  { key: 'enginePid', label: 'PID', width: 80, numeric: true, group: 'Session', optional: true },
  { key: 'agentId', label: 'Harness ID', width: 220, group: 'Session', optional: true },
  { key: 'sessionId', label: 'Conversation ID', width: 220, group: 'Session', optional: true },
  { key: 'home', label: 'Folder', width: 240, group: 'Session', optional: true },
]
export const PRESETS = {
  overview: COLUMNS.filter(c => !c.optional).map(c => c.key),
  resources: ['name', 'activity', 'workspaceBytes', 'sessionBytes', 'rssBytes', 'cpu', 'gpuPercent', 'gpuMemoryBytes', 'diskReadBytesPerSecond', 'diskWriteBytesPerSecond', 'processCount', 'machine'],
  ai: ['name', 'activity', 'engine', 'machine', 'model', 'tokens', 'tokensPerMinute', 'inputTokens', 'outputTokens', 'cachedTokens', 'lastActivity'],
}
// Activity describes what an open harness is doing, not whether it is open.
// Saved harnesses appear only in the explicit Stopped harnesses view.
export const isLive = row => row.online !== false
  && !['stopped', 'offline', 'gone'].includes(row.state)
  && !['stopped', 'offline'].includes(row.activity)
  && (row.live ?? ['running', 'terminal', 'starting'].includes(row.state))
export function visibleRows(rows, { query = '', filter = 'all', machine = 'all', sort = 'workspaceBytes', direction = -1 } = {}) {
  const q = query.trim().toLocaleLowerCase(), rank = Object.keys(ACTIVITY)
  return rows.filter(row => (filter === 'stopped' ? row.online !== false && row.state === 'stopped' : isLive(row)) && (machine === 'all' || row.machineId === machine)
    && (filter === 'all' || row.activity === filter)
    && (!q || [row.name, row.title, row.engine, row.machine, row.project, row.branch, row.model, row.agentId, row.sessionId, row.home]
      .some(v => String(v ?? '').toLocaleLowerCase().includes(q))))
    .sort((a, b) => {
      let av = a[sort], bv = b[sort]
      if (av == null && bv != null) return 1
      if (bv == null && av != null) return -1
      if (sort === 'activity') { av = rank.indexOf(av); bv = rank.indexOf(bv) }
      const compared = typeof av === 'number' && typeof bv === 'number' ? av - bv
        : String(av ?? '').localeCompare(String(bv ?? ''), undefined, { numeric: true })
      return compared * direction || a.id.localeCompare(b.id)
    })
}
export const number = n => n == null ? '—' : Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n)
export const memory = n => n == null ? '—' : n >= 1e9 ? Math.round(n / 1e9) + ' GB' : Math.round(n / 1e6) + ' MB'
export const bytes = n => n == null ? '—' : n >= 1e6 ? memory(n) : n >= 1e3 ? Math.round(n / 1e3) + ' KB' : Math.round(n) + ' B'
export const percent = n => n == null ? '—' : Math.round(n) + '%'
export const age = (stamp, now = Date.now()) => {
  if (stamp == null) return '—'
  const s = Math.max(0, (now - stamp) / 1000)
  return s < 60 ? 'now' : s < 3600 ? Math.floor(s / 60) + 'm ago' : s < 86400 ? Math.floor(s / 3600) + 'h ago' : Math.floor(s / 86400) + 'd ago'
}
export function formatValue(key, value) {
  if (['cpu', 'gpuPercent'].includes(key)) return percent(value)
  if (['rssBytes', 'sessionBytes', 'workspaceBytes', 'gpuMemoryBytes', 'transcriptBytes'].includes(key)) return bytes(value)
  if (key.endsWith('PerSecond')) return value == null ? '—' : bytes(value) + '/s'
  if (['tokens', 'inputTokens', 'outputTokens', 'cachedTokens', 'tokensPerMinute'].includes(key)) return number(value)
  if (['lastActivity', 'createdAt'].includes(key)) return age(value)
  return value ?? '—'
}
export function sumReading(rows, key) {
  const known = rows.map(r => r[key]).filter(n => typeof n === 'number' && Number.isFinite(n) && n >= 0)
  return { value: rows.length && !known.length ? null : known.reduce((a, b) => a + b, 0), partial: known.length < rows.length }
}
export function storageTotal(rows) {
  const included = [], known = rows.filter(r => r.workspaceBytes != null && (r.workspacePath || r.cwd))
    .sort((a, b) => (a.workspacePath || a.cwd).length - (b.workspacePath || b.cwd).length)
  for (const row of known) {
    const path = row.workspacePath || row.cwd
    if (!included.some(r => r.machineId === row.machineId && (path === r.path || path.startsWith(r.path + '/')))) included.push({ ...row, path })
  }
  return { value: included.length ? included.reduce((n, r) => n + r.workspaceBytes, 0) : rows.length ? null : 0,
    partial: known.length < rows.length }
}
