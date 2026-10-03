/// What the sample's harnesses say: the sessions they open on, the work the busy one never
/// finishes, and the replies any of them gives to whatever it is asked.
///
/// Paths are `~/code/…` throughout — a sample has no home folder of its own, and a real one
/// written here would be somebody's.
library;

import 'sample_harness.dart';
import 'sample_screen.dart';

Duration _ms(int milliseconds) => Duration(milliseconds: milliseconds);

EmitStep say(String text, [int ms = 1100]) => EmitStep(SayEntry(text), _ms(ms));

EmitStep tool(
  String name,
  String arg,
  List<String> out, {
  int ms = 1500,
  ToolOutcome outcome = ToolOutcome.ok,
}) => EmitStep(ToolEntry(name, arg, out, outcome), _ms(ms));

EmitStep diff(String file, List<DiffLine> lines, [int ms = 1600]) =>
    EmitStep(DiffEntry(file, lines), _ms(ms));

EmitStep todos(List<Todo> items, [int ms = 900]) =>
    EmitStep(TodoEntry(items), _ms(ms));

VerbStep verb(String word, [int ms = 300]) => VerbStep(word, _ms(ms));

/// The last words of a turn: said, then the turn ends on them.
List<SampleStep> finish(String reply, [int ms = 1000]) => [
  say(reply, ms),
  DoneStep(reply, _ms(250)),
];

// ── the five harnesses ─────────────────────────────────────────────────────────────────────────

/// A computer in the sample.
typedef SampleComputer = ({String id, String name});

const sampleStudio = (id: 'sample-studio', name: 'studio');
const sampleLaptop = (id: 'sample-laptop', name: 'laptop');
const sampleComputers = [sampleStudio, sampleLaptop];

/// How a harness starts: which computer, what the machine says about it, what is on its screen,
/// and what it is doing.
class SampleSeed {
  const SampleSeed({
    required this.computer,
    required this.agent,
    required this.transcript,
    this.loop,
    this.ask,
    this.then,
    this.finished,
  });

  final SampleComputer computer;
  final Map<String, dynamic> agent;
  final List<SampleEntry> transcript;

  /// Busy forever.
  final SampleLoop? loop;

  /// Stopped on a question, and what it does with the answer.
  final SampleAsk? ask;
  final List<SampleStep> Function(int answer)? then;

  /// Its last turn just ended, saying this — news nobody has read yet.
  final String? finished;
}

Map<String, dynamic> sampleAgentJson({
  required String id,
  required String name,
  required String engine,
  required String project,
  required String branch,
  required DateTime updatedAt,
  String? title,
}) => {
  'id': id,
  'name': name,
  'engine': engine,
  'engineDisplayName': engine == 'codex' ? 'Codex' : 'Claude Code',
  'sessionId': 'session-$id',
  'status': 'active',
  'title': ?title,
  'updatedAt': updatedAt.toUtc().toIso8601String(),
  'project': {
    'name': project,
    'cwd': '~/code/$project',
    'root': '~/code/$project',
    'branch': branch,
  },
  'terminal': {'available': true},
};

List<SampleSeed> sampleSeeds(DateTime now) => [
  SampleSeed(
    computer: sampleStudio,
    agent: sampleAgentJson(
      id: 'sample-fix-login',
      name: 'fix-login',
      engine: 'claude',
      project: 'web',
      branch: 'fix/login-refresh',
      title: 'Sessions log out after an hour',
      updatedAt: now.subtract(const Duration(seconds: 5)),
    ),
    transcript: const [
      UserEntry(
        'sessions log users out after exactly an hour — fix it and add a test',
      ),
      SayEntry(
        "I'll reproduce it first. An hour is the access token's lifetime, so "
        'the refresh path is the first suspect.',
      ),
      ToolEntry('Read', 'src/auth/session.ts', ['Read 142 lines']),
      ToolEntry('Search', 'pattern: "refreshToken", path: "src"', [
        'Found 6 files',
      ]),
    ],
    loop: _FixLoginLoop(),
  ),
  SampleSeed(
    computer: sampleStudio,
    agent: sampleAgentJson(
      id: 'sample-refactor-db',
      name: 'refactor-db',
      engine: 'claude',
      project: 'api',
      branch: 'refactor/db-sessions',
      title: 'Split the sessions table',
      updatedAt: now.subtract(const Duration(minutes: 2)),
    ),
    transcript: const [
      UserEntry('split the sessions table so tokens live in their own table'),
      SayEntry(
        "I'll split `sessions` into `sessions` and `session_tokens`, keep a "
        'view so current queries still work, then move the repository layer '
        'over.',
      ),
      ToolEntry('Read', 'db/schema.sql', ['Read 311 lines']),
      ToolEntry('Write', 'db/migrations/0042_split_sessions.sql', [
        'Wrote 38 lines to db/migrations/0042_split_sessions.sql',
      ]),
      SayEntry(
        'The migration is written. Next it runs against the dev database.',
      ),
    ],
    ask: migrationAsk,
    then: _afterMigrationAnswer,
  ),
  SampleSeed(
    computer: sampleStudio,
    agent: sampleAgentJson(
      id: 'sample-api-tests',
      name: 'api-tests',
      engine: 'codex',
      project: 'api',
      branch: 'main',
      title: 'Fix the flaky API tests',
      updatedAt: now.subtract(const Duration(minutes: 9)),
    ),
    transcript: const [
      BannerEntry('~/code/api'),
      UserEntry('run the API tests and fix anything flaky'),
      SayEntry("I'll run the suite first to see what fails."),
      ToolEntry('Bash', 'npm test -- api', [
        'FAIL tests/rate-limit.test.ts',
        '  ● resets the window after 60s',
        'Tests: 1 failed, 57 passed, 58 total',
      ], ToolOutcome.failed),
      ToolEntry('Read', 'tests/rate-limit.test.ts', [
        'Read src/middleware/rateLimit.ts',
      ]),
      SayEntry(
        'The test sleeps on a real 60s timer and races the clock. Switching it '
        'to fake timers.',
      ),
      DiffEntry('tests/rate-limit.test.ts', [
        DiffLine(18, '-', '  await sleep(60_000);'),
        DiffLine(18, '+', '  jest.useFakeTimers();'),
        DiffLine(19, '+', '  jest.advanceTimersByTime(60_000);'),
      ]),
      ToolEntry('Bash', 'for i in 1 2 3 4 5; do npm test -- api; done', [
        'Tests: 58 passed, 58 total  (×5)',
      ]),
      SayEntry(_apiTestsReply),
    ],
    finished: _apiTestsReply,
  ),
  SampleSeed(
    computer: sampleLaptop,
    agent: sampleAgentJson(
      id: 'sample-docs-site',
      name: 'docs-site',
      engine: 'claude',
      project: 'docs',
      branch: 'main',
      title: 'Dark mode toggle in the docs header',
      updatedAt: now.subtract(const Duration(minutes: 34)),
    ),
    transcript: const [
      UserEntry('add a dark-mode toggle to the docs header'),
      SayEntry("I'll add the toggle to the header and remember the choice."),
      DiffEntry('src/components/Header.astro', [
        DiffLine(12, ' ', '<nav class="links">'),
        DiffLine(13, '+', '  <ThemeToggle />'),
        DiffLine(14, ' ', '</nav>'),
      ]),
      ToolEntry('Bash', 'npm run build', ['✓ 214 pages built in 6.1s']),
      SayEntry(
        'Done — the header has a sun/moon toggle, the choice is saved in '
        '`localStorage`, and it follows the system setting until someone '
        'picks.',
      ),
    ],
  ),
  SampleSeed(
    computer: sampleLaptop,
    agent: sampleAgentJson(
      id: 'sample-mobile-ui',
      name: 'mobile-ui',
      engine: 'codex',
      project: 'mobile',
      branch: 'feat/find-rows',
      title: 'Machine names in Find',
      updatedAt: now.subtract(const Duration(hours: 2)),
    ),
    transcript: const [
      BannerEntry('~/code/mobile'),
      UserEntry('make the Find list show the machine name under each harness'),
      DiffEntry('lib/phone/find_row.dart', [
        DiffLine(41, '-', '  Text(agent.name),'),
        DiffLine(41, '+', '  Column(children: ['),
        DiffLine(42, '+', '    Text(agent.name),'),
        DiffLine(43, '+', '    Text(machine.name, style: dim),'),
        DiffLine(44, '+', '  ]),'),
      ]),
      ToolEntry('Bash', 'flutter test test/find_test.dart', [
        '00:03 +18: All tests passed!',
      ]),
      SayEntry(
        'Each row in Find now shows its machine under the name, dimmed, and '
        'the tests cover it.',
      ),
    ],
  ),
];

const _apiTestsReply =
    'All 58 API tests pass, five runs in a row. The flake was the rate-limit '
    'test sleeping on a real clock; it uses fake timers now.';

/// The question `refactor-db` is stopped on.
const migrationAsk = SampleAsk(
  title: 'Bash command',
  command: 'psql "\$DATABASE_URL" -f db/migrations/0042_split_sessions.sql',
  purpose: 'Apply the sessions split to the dev database',
  options: [
    'Yes',
    "Yes, and don't ask again for psql commands in ~/code/api",
    'No, and tell Claude what to do differently (esc)',
  ],
);

List<SampleStep> _afterMigrationAnswer(int answer) {
  const command =
      'psql "\$DATABASE_URL" -f db/migrations/0042_split_sessions.sql';
  if (answer >= 2) {
    return [
      tool(
        'Bash',
        command,
        ['User declined to run this command'],
        ms: 500,
        outcome: ToolOutcome.declined,
      ),
      ...finish(
        "Okay — I won't touch the database. What should I do instead? I can "
        'run it against a throwaway copy first, or leave the migration for you '
        'to review.',
      ),
    ];
  }
  return [
    tool('Bash', command, [
      'BEGIN',
      'CREATE TABLE',
      'INSERT 0 18244',
      'ALTER TABLE',
      'CREATE VIEW',
      'COMMIT',
    ], ms: 1200),
    verb('Refactoring'),
    say(
      'Migration applied: 18,244 tokens moved into `session_tokens`, and the '
      '`sessions_v1` view keeps old queries working.',
      1300,
    ),
    diff('src/db/sessions.ts', const [
      DiffLine(27, '-', "  return db.one('sessions', id);"),
      DiffLine(27, '+', "  const row = await db.one('sessions', id);"),
      DiffLine(28, '+', "  row.tokens = await db.many('session_tokens',"),
      DiffLine(29, '+', '    { sessionId: id });'),
    ]),
    verb('Testing'),
    tool('Bash', 'npm test -- db', [
      'PASS src/db/sessions.test.ts (14 tests)',
      'Tests: 14 passed, 14 total',
    ], ms: 1800),
    ...finish(
      'Split done: tokens live in `session_tokens`, the repository reads the '
      'new tables, and all 14 db tests pass.',
    ),
  ];
}

/// `fix-login`'s work, which never runs out: four stretches of it, round and round.
class _FixLoginLoop implements SampleLoop {
  int _chapter = 0;

  @override
  List<SampleStep> next() {
    final chapter = _chapters[_chapter % _chapters.length];
    _chapter++;
    return chapter();
  }

  static final _chapters = <List<SampleStep> Function()>[
    () => [
      verb('Tracing', 900),
      say(
        'Found it: `ensureSession` checks `expiresAt` but never refreshes, so '
        'an expired access token signs the user out instead of being renewed.',
        1800,
      ),
      todos(const [
        Todo('Reproduce the one-hour logout', done: true),
        Todo('Refresh the token before it expires'),
        Todo('Retry a 401 once after refreshing'),
        Todo('Cover both with tests'),
      ]),
      diff('src/auth/session.ts', const [
        DiffLine(41, '-', '  if (expired(session)) return signOut();'),
        DiffLine(41, '+', '  if (expiresSoon(session)) {'),
        DiffLine(42, '+', '    session = await refresh(session);'),
        DiffLine(43, '+', '  }'),
      ], 2200),
      diff('src/api/client.ts', const [
        DiffLine(88, '+', '  if (res.status === 401 && !retried) {'),
        DiffLine(89, '+', '    await session.refresh();'),
        DiffLine(90, '+', '    return send(req, { retried: true });'),
        DiffLine(91, '+', '  }'),
      ], 2000),
      verb('Testing', 600),
      tool(
        'Bash',
        'npm test -- auth',
        [
          'FAIL src/auth/session.test.ts',
          '  ● refreshes a token about to expire',
          '    Expected: 200  Received: 401',
        ],
        ms: 2600,
        outcome: ToolOutcome.failed,
      ),
      say(
        "One failure — the test's fake clock never fires the refresh timer. "
        'Fixing the helper, not the code.',
        1600,
      ),
      diff('test/helpers/clock.ts', const [
        DiffLine(12, ' ', '  now += ms;'),
        DiffLine(13, '+', '  jest.runOnlyPendingTimers();'),
      ]),
      tool('Bash', 'npm test -- auth', [
        'PASS src/auth/session.test.ts (12 tests)',
        'PASS src/api/client.test.ts (9 tests)',
        'Tests: 21 passed, 21 total',
      ], ms: 2600),
      todos(const [
        Todo('Reproduce the one-hour logout', done: true),
        Todo('Refresh the token before it expires', done: true),
        Todo('Retry a 401 once after refreshing', done: true),
        Todo('Cover both with tests', done: true),
      ]),
      say(
        'Sessions now refresh five minutes before they expire, and a 401 '
        'retries once after a refresh. All 21 auth tests pass.',
        1400,
      ),
      const DoneStep(
        'Sessions refresh before they expire; all 21 auth tests pass.',
        Duration(milliseconds: 100),
      ),
    ],
    () => [
      verb('Reading', 2400),
      say(
        'Next: "Remember me" still loses the session after a browser restart. '
        'Checking the cookie flags.',
        1500,
      ),
      tool('Read', 'src/auth/cookies.ts', ['Read 64 lines']),
      say(
        'The refresh cookie has no `Max-Age`, so it dies with the browser. It '
        'gets the refresh token\'s 30 days when "Remember me" is on.',
        1800,
      ),
      diff('src/auth/cookies.ts', const [
        DiffLine(23, '-', "  res.cookie('rt', token, { httpOnly: true });"),
        DiffLine(23, '+', "  res.cookie('rt', token, { httpOnly: true,"),
        DiffLine(24, '+', '    maxAge: remember ? THIRTY_DAYS : undefined });'),
      ]),
      verb('Testing', 500),
      tool('Bash', 'npm test -- cookies', [
        'PASS src/auth/cookies.test.ts (7 tests)',
      ], ms: 2200),
      tool('Bash', 'npx playwright test login.spec.ts', [
        'Running 4 tests using 2 workers',
        '4 passed (9.8s)',
      ], ms: 2800),
      say(
        '"Remember me" now survives a restart, and the Playwright login flow '
        'passes end to end.',
        1300,
      ),
    ],
    () => [
      verb('Tidying', 2000),
      tool('Bash', 'npm run lint -- src/auth', ['✓ No problems'], ms: 1600),
      tool('Bash', 'git diff --stat', [
        'src/api/client.ts     |  6 ++++-',
        'src/auth/cookies.ts   |  3 +-',
        'src/auth/session.ts   | 11 +++++---',
        'test/helpers/clock.ts |  2 +-',
        '4 files changed, 17 insertions(+), 5 deletions(-)',
      ], ms: 1400),
      say('Running the whole suite once more before handing this back.', 1300),
      verb('Testing', 400),
      tool('Bash', 'npm test', [
        'Test Suites: 38 passed, 38 total',
        'Tests:       412 passed, 412 total',
        'Time:        21.4 s',
      ], ms: 3000),
    ],
    () => [
      verb('Pondering', 1800),
      say(
        'One more case: two tabs refreshing at once. The second refresh would '
        'spend a token the first already rotated.',
        1700,
      ),
      diff('src/auth/session.ts', const [
        DiffLine(58, '+', '  // One refresh at a time, shared by every tab.'),
        DiffLine(59, '+', '  return (inflight ??= doRefresh(session)'),
        DiffLine(60, '+', '    .finally(() => (inflight = null)));'),
      ]),
      verb('Testing', 500),
      tool('Bash', 'npm test -- auth --testNamePattern tabs', [
        'PASS src/auth/session.test.ts',
        '  ✓ two tabs share one refresh (41 ms)',
      ], ms: 2400),
      say('Covered. Going round once more to re-check the whole flow.', 1300),
    ],
  ];
}

// ── replies ────────────────────────────────────────────────────────────────────────────────────

/// Where each sample project's work happens — what a reply reads, edits and runs, and what the
/// run prints.
class _Place {
  const _Place({
    required this.file,
    required this.testFile,
    required this.test,
    required this.passed,
    required this.failed,
    required this.edit,
    required this.passes,
  });

  final String file;
  final String testFile;

  /// The command that checks the work.
  final String test;

  /// What that command prints when all is well, and when it is not.
  final String passed;
  final List<String> failed;

  /// A small edit to [file].
  final List<DiffLine> edit;

  /// "All is well", in words: `all 21 tests pass`.
  final String passes;
}

const _places = <String, _Place>{
  'web': _Place(
    file: 'src/auth/session.ts',
    testFile: 'src/auth/session.test.ts',
    test: 'npm test -- auth',
    passed: 'Tests: 21 passed, 21 total',
    failed: [
      'FAIL src/auth/session.test.ts',
      '  ● keeps the session across a reload',
      'Tests: 1 failed, 20 passed, 21 total',
    ],
    edit: [
      DiffLine(64, '-', '  const ttl = 60 * 60;'),
      DiffLine(64, '+', '  const ttl = options.ttl ?? 60 * 60;'),
    ],
    passes: 'all 21 tests pass',
  ),
  'api': _Place(
    file: 'src/db/sessions.ts',
    testFile: 'tests/sessions.test.ts',
    test: 'npm test -- api',
    passed: 'Tests: 58 passed, 58 total',
    failed: [
      'FAIL tests/sessions.test.ts',
      '  ● returns null for an unknown id',
      'Tests: 1 failed, 57 passed, 58 total',
    ],
    edit: [
      DiffLine(33, '-', '  const limit = 20;'),
      DiffLine(33, '+', '  const limit = options.limit ?? 20;'),
    ],
    passes: 'all 58 tests pass',
  ),
  'docs': _Place(
    file: 'src/components/Header.astro',
    testFile: 'tests/header.test.ts',
    test: 'npm run build',
    passed: '✓ 214 pages built in 6.2s',
    failed: [
      '✗ src/pages/search.astro',
      '  Cannot read properties of undefined',
      'Build failed in 3.4s',
    ],
    edit: [
      DiffLine(13, ' ', '  <ThemeToggle />'),
      DiffLine(14, '+', '  <SearchBox />'),
    ],
    passes: 'the build passes',
  ),
  'mobile': _Place(
    file: 'lib/phone/find_row.dart',
    testFile: 'test/find_test.dart',
    test: 'flutter test',
    passed: '00:04 +19: All tests passed!',
    failed: [
      '00:03 +18 -1: a row shows its machine [E]',
      '  Expected: "studio"  Actual: null',
      '00:03 +18 -1: Some tests failed.',
    ],
    edit: [
      DiffLine(43, '-', '    Text(machine.name, style: dim),'),
      DiffLine(43, '+', '    Text(machine.displayName, style: dim),'),
    ],
    passes: 'all 19 tests pass',
  ),
};

const _anywhere = _Place(
  file: 'src/index.ts',
  testFile: 'test/index.test.ts',
  test: 'npm test',
  passed: 'Tests: 7 passed, 7 total',
  failed: [
    'FAIL test/index.test.ts',
    '  ● starts with no arguments',
    'Tests: 1 failed, 6 passed, 7 total',
  ],
  edit: [
    DiffLine(12, '-', 'const port = 3000;'),
    DiffLine(12, '+', 'const port = Number(process.env.PORT ?? 3000);'),
  ],
  passes: 'all 7 tests pass',
);

_Place _placeOf(SampleHarness harness) {
  final project = (harness.agent['project'] as Map?)?['name'] as String?;
  return _places[project] ?? _anywhere;
}

/// A task's name as a harness would be named for it — `Add a dark mode toggle` → `dark-mode-toggle`:
/// its first three words that say what, lowercased. Null when nothing is left.
String? sampleSlug(String task) {
  const skip = {
    'a',
    'an',
    'the',
    'to',
    'and',
    'of',
    'for',
    'in',
    'on',
    'with',
    'my',
    'our',
    'this',
    'that',
    'please',
    'add',
    'make',
    'create',
    'build',
    'write',
    'implement',
    'fix',
    'update',
    'change',
    'find',
    'run',
    'explain',
    'show',
    'me',
    'it',
    'some',
    'new',
  };
  final words = [
    for (final word in task.toLowerCase().split(RegExp(r'[^a-z0-9]+')))
      if (word.isNotEmpty && !skip.contains(word)) word,
  ];
  if (words.isEmpty) return null;
  return words.take(3).join('-');
}

bool _mentions(String text, List<String> words) =>
    words.any((word) => RegExp('\\b$word\\b').hasMatch(text));

/// What any sample harness does when asked [text]: it says what it is on, in its own style,
/// then does a little work that fits the words, and says what came of it.
List<SampleStep> sampleReply(SampleHarness harness, String text) {
  final place = _placeOf(harness);
  final lower = text.toLowerCase();
  final branch =
      (harness.agent['project'] as Map?)?['branch'] as String? ?? 'main';
  // What it is on, in a few words of its own — never the person's words said back to them. An
  // agent repeating what it was told read as a script, the one thing the sample must not.
  List<SampleStep> onIt(String line) => [verb('Thinking', 200), say(line, 900)];

  if (_mentions(lower, ['stop', 'wait', 'pause', 'cancel', 'hold'])) {
    // Asked to stop, the busy harness stops being busy too.
    harness.dropQueuedWork();
    return [
      verb('Stopping', 200),
      ...finish(
        'Stopped — nothing is running now. Say when to pick it back up.',
        700,
      ),
    ];
  }
  if (_mentions(lower, ['diff', 'changes', 'changed'])) {
    return [
      ...onIt('Here is what changed.'),
      tool('Bash', 'git diff --stat', [
        '${place.file} | 9 ++++++---',
        '${place.testFile} | 14 ++++++++++++++',
        '2 files changed, 20 insertions(+), 3 deletions(-)',
      ]),
      diff(place.file, const [
        DiffLine(41, '-', '  return cached;'),
        DiffLine(41, '+', '  if (cached && !cached.stale) return cached;'),
        DiffLine(42, '+', '  return (cached = await load());'),
      ]),
      ...finish(
        'That is the whole diff: `${place.file}` and a new test beside it. '
        'Nothing is committed yet.',
      ),
    ];
  }
  if (_mentions(lower, ['commit', 'push'])) {
    return [
      ...onIt('Committing it.'),
      tool('Bash', 'git add -A && git commit -m "Refresh before expiry"', [
        '[$branch 3f9c2e1] Refresh before expiry',
        '2 files changed, 20 insertions(+), 3 deletions(-)',
      ]),
      ...finish('Committed as `3f9c2e1` on `$branch`. Not pushed.'),
    ];
  }
  if (_mentions(lower, ['left', 'status', 'remaining', 'progress', 'next'])) {
    return [
      ...onIt('Here is where it stands.'),
      todos(const [
        Todo('Reproduce the bug', done: true),
        Todo('Fix it', done: true),
        Todo('Add a regression test'),
        Todo('Update the changelog'),
      ]),
      ...finish(
        'Two things left: a regression test and the changelog entry. Both '
        'are small.',
      ),
    ];
  }
  if (_mentions(lower, ['tests?', 'fails?', 'failing', 'broken', 'fix'])) {
    final adding = _mentions(lower, ['add', 'write', 'new']);
    if (adding) {
      return [
        ...onIt('Adding tests for it.'),
        tool('Read', place.file, ['Read 96 lines']),
        tool('Write', place.testFile, ['Wrote 34 lines to ${place.testFile}']),
        verb('Testing', 300),
        tool('Bash', place.test, [place.passed], ms: 2000),
        ...finish('Added three tests in `${place.testFile}`; ${place.passes}.'),
      ];
    }
    return [
      ...onIt('Running the tests first.'),
      verb('Testing', 300),
      tool(
        'Bash',
        place.test,
        place.failed,
        ms: 1800,
        outcome: ToolOutcome.failed,
      ),
      tool('Read', place.file, ['Read 96 lines']),
      diff(place.file, place.edit),
      tool('Bash', place.test, [place.passed], ms: 1800),
      ...finish(
        'Fixed the one failure, in `${place.file}` — ${place.passes} now.',
      ),
    ];
  }
  // Something new to build: a file named for it, wired in where the project's work lives.
  if (sampleSlug(text) case final slug?) {
    final ext = place.file.contains('.') ? place.file.split('.').last : 'ts';
    // At the project's top level (`src/`, `lib/`), not in whatever folder the project's usual
    // work happens to live: a new feature is not a database file.
    final dir = place.file.contains('/') ? place.file.split('/').first : 'src';
    final file = '$dir/$slug.$ext';
    final camel = slug
        .split('-')
        .indexed
        .map(
          (part) => part.$1 == 0
              ? part.$2
              : '${part.$2[0].toUpperCase()}${part.$2.substring(1)}',
        )
        .join();
    return [
      ...onIt('Building `$slug`.'),
      tool('Read', place.file, ['Read 96 lines']),
      tool('Write', file, ['Wrote 42 lines to $file']),
      diff(place.file, [DiffLine(3, '+', "import { $camel } from './$slug';")]),
      verb('Testing', 300),
      tool('Bash', place.test, [place.passed], ms: 1700),
      ...finish(
        'Done — added `$file` and wired it into `${place.file}`; '
        '${place.passes}.',
      ),
    ];
  }
  return [
    ...onIt('On it.'),
    tool('Read', place.file, ['Read 96 lines']),
    diff(place.file, place.edit),
    verb('Testing', 300),
    tool('Bash', place.test, [place.passed], ms: 1700),
    ...finish('Done — changed `${place.file}`, and ${place.passes}.'),
  ];
}
