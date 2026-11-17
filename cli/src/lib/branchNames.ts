/** Branch names belong to workspaces, outside the session core. */
/** Two plain words for a branch nothing has named yet — plumbing, like the worktree's folder: the
 *  agent or the person names the real branch when there is something to push. Mirrors
 *  desktop/lib/core/git_worktree.dart. */
export const PLACEHOLDER_ADJECTIVES = [
  'amber', 'bold', 'brave', 'brisk', 'calm', 'clever', 'cosmic', 'crisp', 'dapper', 'eager', 'fancy', 'gentle',
  'glad', 'golden', 'happy', 'hidden', 'jolly', 'keen', 'kind', 'lively', 'lucky', 'merry', 'misty', 'noble',
  'polite', 'proud', 'quick', 'quiet', 'rapid', 'rosy', 'royal', 'rustic', 'shiny', 'silent', 'silver', 'sleek',
  'smart', 'snowy', 'solar', 'spry', 'steady', 'sunny', 'swift', 'tidy', 'vivid', 'warm', 'witty', 'zesty',
] as const
export const PLACEHOLDER_NOUNS = [
  'badger', 'beacon', 'birch', 'bison', 'canyon', 'cedar', 'comet', 'coral', 'crane', 'delta', 'falcon', 'fern',
  'finch', 'fjord', 'fox', 'gecko', 'glacier', 'harbor', 'hawk', 'heron', 'ibis', 'island', 'koala', 'lagoon',
  'lark', 'lynx', 'maple', 'meadow', 'meteor', 'moose', 'nebula', 'otter', 'owl', 'panda', 'pebble', 'pine',
  'puffin', 'quartz', 'raven', 'reef', 'river', 'robin', 'sparrow', 'spruce', 'tiger', 'walrus', 'willow', 'zebra',
] as const

/** `brave-otter`: the branch a new worktree starts on until its session has a name, one none of
 *  `taken` (branch names, with or without `refs/heads/`) already uses. */
export function placeholderBranch(taken: Iterable<string>, pick = (n: number) => Math.floor(Math.random() * n)): string {
  const names = new Set([...taken].map(name => name.replace(/^refs\/heads\//, '')))
  const draw = () => `${PLACEHOLDER_ADJECTIVES[pick(PLACEHOLDER_ADJECTIVES.length)]}-${PLACEHOLDER_NOUNS[pick(PLACEHOLDER_NOUNS.length)]}`
  let name = draw()
  for (let tries = 0; tries < 16 && names.has(name); tries++) name = draw()
  const base = name
  for (let suffix = 2; names.has(name); suffix++) name = `${base}-${suffix}`
  return name
}

/** The folder a worktree on `branch` is checked out in, under its repository: the branch's last part.
 *  Nobody needs to see it, and it keeps its name when the branch is renamed. */
export function worktreeFolderName(branch: string): string {
  const name = (branch.split('/').pop() ?? '').replace(/[^A-Za-z0-9._-]+/g, '').replace(/^[.-]+/, '')
  return name ? name.slice(0, 64) : 'worktree'
}

/** Words a branch name can do without: they join a title's words, point at something, or grade it —
 *  none of them tell branches apart. Measured against this repo's session and PR titles. */
const BRANCH_FILLER = new Set([
  // Joining words.
  'a', 'an', 'the', 'and', 'or', 'but', 'so', 'of', 'to', 'for', 'in', 'on', 'at', 'by', 'with', 'from',
  'into', 'onto', 'as', 'is', 'are', 'be', 'up', 'about', 'after', 'before', 'then', 'than', 'via', 'per',
  'out', 'off', 'over', 'under', 'through', 'across', 'between', 'without', 'instead', 'not', 'only',
  // Pointing words, people and questions.
  'this', 'that', 'these', 'those', 'it', 'its', 'my', 'me', 'our', 'we', 'us', 'your', 'you', 'i',
  'they', 'them', 'their', 'what', 'how', 'why', 'when', 'where', 'which', 'who', 'can', 'should',
  'will', 'would', 'may', 'ok', 'okay', 'please', 'lets', 'just', 'also', 'now', 'here', 'there',
  'all', 'any', 'some', 'every', 'each', 'more', 'most', 'very', 'whether', 'whose', 'another', 'other',
  'never', 'no', 'longer', 'own', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight',
  'nine', 'ten',
  // Grading words.
  'simple', 'basic', 'quick', 'small', 'latest', 'exact', 'exactly', 'extra', 'bold', 'iconic', 'better',
])

/** What a title's first word usually is, and what every branch would otherwise start with. The PR title
 *  keeps the verb; the branch keeps what it is about. */
const BRANCH_VERBS = new Set([
  'fix', 'add', 'update', 'make', 'improve', 'refine', 'build', 'rebuild', 'implement', 'support', 'handle',
  'remove', 'change', 'move', 'allow', 'create', 'use', 'show', 'hide', 'let', 'set', 'get', 'enable',
  'disable', 'rename', 'refactor', 'clean', 'debug', 'investigate', 'review', 'help', 'write', 'rewrite',
  'test', 'discuss', 'explore', 'plan', 'research', 'try', 'check', 'catch', 'look', 'pull', 'push', 'run',
  'open', 'close', 'start', 'stop', 'keep', 'give', 'guide', 'simplify', 'tighten', 'restore', 'reject',
  'prevent', 'measure', 'defer', 'reduce', 'retire', 'preserve', 'detect', 'expose', 'guard', 'surface',
  'reorganize', 'organize', 'respond', 'reply', 'return', 'provide', 'greet', 'define', 'choose', 'study',
  'diagnose', 'summarize', 'clarify', 'explain', 'document', 'describe', 'compare', 'find', 'ask',
  'answer', 'draft', 'prepare', 'generate', 'tune', 'polish', 'redesign', 'migrate', 'upgrade', 'bump',
  'drop', 'delete', 'replace', 'revert', 'wire', 'port', 'sync', 'load', 'save', 'install', 'uninstall',
  'publish', 'deploy', 'speed', 'trim', 'shorten', 'split', 'merge', 'center', 'align', 'unpack', 'say',
  'read', 'mark', 'name', 'tell', 'avoid', 'reuse', 'reveal', 'adopt', 'treat', 'refresh', 'recover',
  'unify', 'activate', 'record', 'unblock', 'lead', 'ship', 'select',
])

/** Words that say what kind of thing a change touches, not which: `login page` is the login, `onboarding
 *  experience` is onboarding. As a second word they add length and no meaning. */
const BRANCH_GENERIC = new Set([
  'page', 'pages', 'screen', 'screens', 'view', 'views', 'flow', 'flows', 'experience', 'ui', 'ux',
  'issue', 'issues', 'bug', 'bugs', 'problem', 'problems', 'error', 'errors', 'fix', 'fixes',
  'feature', 'features', 'support', 'setup', 'logic', 'code', 'handling', 'behavior', 'behaviour',
  'stuff', 'thing', 'things', 'work', 'change', 'changes', 'update', 'updates', 'improvement',
  'improvements', 'cleanup', 'polish', 'tweak', 'tweaks', 'part', 'section',
])

/** The names a session's branch may take, best first: as few words as carry the meaning — one or two
 *  — then, only for a clash, the fuller two-word name and then a third word of the title.
 *  `Harness monitor DDOS requests` → `harness-monitor`, then `harness-monitor-ddos`; `Fix the login
 *  page` → `login`, then `login-page`; `Onboarding` → `onboarding`. Filler words, a leading verb and
 *  lone numbers go first (a title that is only a verb keeps it). Each word is capped at 24
 *  characters. Empty when nothing meaningful is left, and the placeholder branch stays. */
export function sessionBranchNames(title: string | null | undefined): string[] {
  // NFKD splits `é` into `e` and its accent; the accent goes, or it would split the word in two.
  // A commit-style `feat(desktop):` names the kind of change, which the branch leaves to the PR.
  const words = (title ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/^\s*(feat|fix|perf|test|tests|docs|doc|ci|chore|refactor|style|build|revert|wip)(\([^)]*\))?!?:\s*/, '')
    // The first sentence: a title that runs on (`Look at my Chrome. Open the file…`) is a prompt.
    .split(/[.!?](?:\s|$)/)[0]!
    // `sign-in`, `8-bit`, `autonomous-code`: a two-part hyphenated word is one word and stays whole —
    // split, `sign-in came` loses its `in` and names the branch `sign-came`. Longer chains split.
    .split(/[^a-z0-9-]+/).flatMap(token => {
      const parts = token.split('-').filter(Boolean)
      return parts.length === 2 ? [parts.join('-')] : parts
    })
    .filter((word, i, all) => word && word !== all[i - 1])
  const meaningful = words.filter(word => !BRANCH_FILLER.has(word))
  while (meaningful.length > 1 && BRANCH_VERBS.has(meaningful[0]!)) meaningful.shift()
  // A lone number (`0` of 0.3.1, `2` of "Part 2") says nothing beside a word that does.
  const worded = meaningful.filter(word => !/^\d+$/.test(word))
  const cap = (word: string) => word.split('-').map(part => part.slice(0, 24)).join('-')
  const source = (worded.length ? worded : meaningful).map(cap)
  if (!source.length) return []
  const first = source[0]!
  // The words after the first, one at a time: `app auto-opening` goes on with `auto`, and `desktop
  // on-screen` with `screen` — never a filler half.
  const after = source.slice(1).flatMap(word => word.split('-')).filter(part => !BRANCH_FILLER.has(part))
  // A clash's third word says what sets this session apart, so a generic one is passed over.
  const third = (base: string, rest: string[]) => {
    const word = rest.find(part => !BRANCH_GENERIC.has(part))
    return word ? [`${base}-${word}`] : []
  }
  // A hyphenated pair already is two words.
  if (first.includes('-')) return [first, ...third(first, after)]
  const [second, ...more] = after
  if (!second) return [first]
  const two = `${first}-${second}`
  return [...BRANCH_GENERIC.has(second) ? [first] : [], two, ...third(two, more)]
}

