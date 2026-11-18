// The mockup's own data (diego-1tap.html: APPS, AGENTS, NOTICES0) as a BarModel, for the pages' golden tests and the
// app's HARNESS_MAX_FIXTURE mode. A fixed clock: 18 Nov 2026, 14:32.
import '../link/bar_link.dart';
import '../model/bar_model.dart';
import '../model/types.dart';

final DateTime kFixtureNow = DateTime(2026, 11, 18, 14, 32, 5);

/// The Orca ring (Overview's five cells), the apps, the inbox; Overview up.
BarModel mockupModel({String app = 'orca', DateTime? now}) {
  final t = now ?? kFixtureNow;
  final m = BarModel(link: NullLink(), clock: () => t);
  m
    ..connected = true
    ..computer = 'MacBook Pro'
    ..offersNew = true
    ..appsKnown = true
    ..shownApp = app
    ..page = BarPage.overview;
  m.apps.addAll(const [
    AppInfo(id: 'harness', name: 'Harness', count: 3, waiting: 1),
    AppInfo(id: 'orca', name: 'Orca', count: 5, waiting: 1),
    AppInfo(id: 'herdr', name: 'herdr', count: 2),
    AppInfo(id: 'vscode', name: 'VS Code', count: 1),
  ]);
  m.agents.addAll(app == 'harness' ? _harness(t) : _orca(t));
  for (final a in m.agents.where((a) => a.state == AgentState.asking)) {
    m.asks[a.id] = _askOf(a, t);
  }
  m.inbox.addAll([
    Notice(agentId: 'landing-hero', name: 'landing-hero', engine: 'codex', app: 'Orca', kind: AttnKind.ask,
        text: 'Both hero versions build. Keep the dark gradient, or switch to the product photo?',
        at: t.subtract(const Duration(minutes: 1))),
    Notice(agentId: 'flaky-e2e', name: 'flaky-e2e', engine: 'claude', app: 'Orca', kind: AttnKind.done,
        text: 'Found it: the checkout test raced the cart request. It now waits for the response, and 50 runs in a '
            'row pass.',
        at: t.subtract(const Duration(minutes: 2))),
    Notice(agentId: 'api-docs', name: 'api-docs', engine: 'codex', app: 'VS Code', kind: AttnKind.failed,
        text: 'The docs build stopped: 3 links point at pages that no longer exist.',
        at: t.subtract(const Duration(minutes: 9)), unread: false),
    Notice(agentId: 'release-notes', name: 'release-notes', engine: 'claude', app: 'herdr', kind: AttnKind.done,
        text: 'Release notes for 0.9 are drafted: 14 fixes, 3 features, and one breaking change called out at the top.',
        at: t.subtract(const Duration(minutes: 12)), unread: false),
    Notice(agentId: 'css-cleanup', name: 'css-cleanup', engine: 'claude', app: 'VS Code', kind: AttnKind.done,
        text: 'Removed 212 unused rules. The build is 18 KB smaller.',
        at: t.subtract(const Duration(hours: 3)), unread: false),
  ]);
  return m;
}

Ask _askOf(Agent a, DateTime t) => Ask(
      agentId: a.id,
      requestId: 'req-${a.id}',
      text: a.said,
      items: [
        AskItem(key: 'choice', q: a.said, options: a.id == 'landing-hero' ? const ['Gradient', 'Photo'] : const ['Bump to 4', 'Keep 3'])
      ],
      path: a.caps.answer ? AskPath.plain : AskPath.shown,
      app: a.caps.answer ? '' : 'Orca',
      since: a.since,
    );

const _orcaCaps = Caps(status: true, voice: true, focus: false, answer: false);

List<Agent> _orca(DateTime t) => [
      Agent(id: 'auth-refactor', name: 'auth-refactor', engine: 'claude', host: 'orca', caps: _orcaCaps,
          state: AgentState.working, verb: 'Editing', activity: 'session.ts',
          steps: const [
            TurnStep('Thinking', 'How to retry the token refresh once', think: true),
            TurnStep('Reading', 'session.ts, refresh.ts and 4 tests'),
            TurnStep('Editing', 'session.ts'),
          ],
          since: t.subtract(const Duration(seconds: 252)), turnStarted: t.subtract(const Duration(seconds: 252))),
      Agent(id: 'landing-hero', name: 'landing-hero', engine: 'codex', host: 'orca', caps: _orcaCaps,
          state: AgentState.asking,
          said: 'Both hero versions build. Keep the dark gradient, or switch to the product photo?',
          since: t.subtract(const Duration(seconds: 61)), turnStarted: t.subtract(const Duration(seconds: 61))),
      Agent(id: 'flaky-e2e', name: 'flaky-e2e', engine: 'claude', host: 'orca', caps: _orcaCaps,
          state: AgentState.done,
          said: 'Found it: the checkout test raced the cart request. It now waits for the response, and 50 runs in a '
              'row pass.',
          since: t.subtract(const Duration(minutes: 2))),
      Agent(id: 'rate-limiter', name: 'rate-limiter', engine: 'codex', host: 'orca', caps: _orcaCaps,
          state: AgentState.working, verb: 'Planning', activity: '4 steps, starting with the middleware',
          steps: const [TurnStep('Planning', '4 steps, starting with the middleware', think: true)],
          since: t.subtract(const Duration(seconds: 534)), turnStarted: t.subtract(const Duration(seconds: 534))),
      Agent(id: 'docs-sweep', name: 'docs-sweep', engine: 'muse', host: 'orca', caps: _orcaCaps,
          state: AgentState.idle, since: t.subtract(const Duration(hours: 1))),
    ];

List<Agent> _harness(DateTime t) => [
      Agent(id: 'firmware-max', name: 'firmware-max', engine: 'claude', host: 'harness',
          state: AgentState.working, verb: 'Building', activity: 'idf.py build, 61%',
          steps: const [
            TurnStep('Reading', 'cable_client.c and ui_lanes.c'),
            TurnStep('Editing', 'ui_lanes.c'),
            TurnStep('Building', 'idf.py build, 61%'),
          ],
          since: t.subtract(const Duration(seconds: 190)), turnStarted: t.subtract(const Duration(seconds: 190))),
      Agent(id: 'harness-cli', name: 'harness-cli', engine: 'claude', host: 'harness',
          state: AgentState.asking, said: 'Bump the cable protocol to 4, or keep 3 and add a field?',
          since: t.subtract(const Duration(minutes: 1)), turnStarted: t.subtract(const Duration(minutes: 1))),
      Agent(id: 'docs', name: 'docs', engine: 'muse', host: 'harness', state: AgentState.done,
          said: 'The setup guide now covers the menu-bar app and the one cable.',
          since: t.subtract(const Duration(minutes: 5))),
    ];
