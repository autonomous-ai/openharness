import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/local_key_value_store.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/first_arrival.dart';
import 'package:harness/state/session_content_search.dart';
import 'package:harness/state/swarm_navigation.dart';

class _MemoryStore implements LocalKeyValueStore {
  final values = <String, String>{};
  @override
  Future<String?> read(String key) async => values[key];
  @override
  Future<void> write(String key, String value) async => values[key] = value;
  @override
  Future<void> delete(String key) async => values.remove(key);
}

final _base = DateTime(2026, 10, 8, 12);

/// A conversation last active [minutesAgo] minutes before noon.
ArrivalSession _s(String engine, String id, int minutesAgo) => ArrivalSession(
  engine: engine,
  sessionId: id,
  cwd: '/work/$id',
  lastAt: _base.subtract(Duration(minutes: minutesAgo)),
);

List<List<String>> _ids(List<List<ArrivalSession>> tabs) => [
  for (final tab in tabs) [for (final session in tab) session.sessionId],
];

SessionContentHit _hit(
  String sessionId, {
  String engine = 'claude',
  bool open = false,
  String? openIn,
  int minutesAgo = 0,
  String? cwd,
  bool external = true,
}) => SessionContentHit(
  machineId: 'local',
  agentId: external ? '' : 'agent-$sessionId',
  sessionId: sessionId,
  field: 'name',
  snippet: '',
  together: false,
  score: 1,
  lastAt: _base.subtract(Duration(minutes: minutesAgo)),
  external: external
      ? ExternalSessionRef(
          sessionId: sessionId,
          engine: engine,
          cwd: cwd ?? '/work/$sessionId',
          origin: 'terminal',
          title: 'Title $sessionId',
          open: open,
          openIn: openIn,
        )
      : null,
);

void main() {
  group('recentTabs', () {
    test(
      'both agents: the latest of each side by side, then the next three',
      () {
        final tabs = recentTabs([
          _s('claude', 'c1', 1),
          _s('claude', 'c2', 2),
          _s('claude', 'c3', 3),
          _s('codex', 'x1', 4),
          _s('claude', 'c4', 5),
          _s('codex', 'x2', 6),
          _s('claude', 'c5', 7),
        ]);
        expect(_ids(tabs), [
          ['c1', 'x1'],
          // c2, c3 and c4 are all Claude Code: the third gives way to the latest Codex left.
          ['c2', 'c3', 'x2'],
        ]);
      },
    );

    test('the first tab is ordered by activity whichever agent leads', () {
      final tabs = recentTabs([
        _s('claude', 'c1', 9),
        _s('codex', 'x1', 1),
        _s('codex', 'x2', 2),
      ]);
      expect(_ids(tabs), [
        ['x1', 'c1'],
        ['x2'],
      ]);
    });

    test(
      'the second tab keeps its own order when it already mixes the agents',
      () {
        final tabs = recentTabs([
          _s('claude', 'c1', 1),
          _s('codex', 'x1', 2),
          _s('codex', 'x2', 3),
          _s('claude', 'c2', 4),
          _s('codex', 'x3', 5),
          _s('claude', 'c3', 6),
        ]);
        expect(_ids(tabs), [
          ['c1', 'x1'],
          ['x2', 'c2', 'x3'],
        ]);
      },
    );

    test('one agent only: its two most recent, then the next three', () {
      final tabs = recentTabs([
        for (var i = 1; i <= 7; i++) _s('codex', 'x$i', i),
      ]);
      expect(_ids(tabs), [
        ['x1', 'x2'],
        ['x3', 'x4', 'x5'],
      ]);
    });

    test('a few conversations fill what they can', () {
      expect(_ids(recentTabs([_s('claude', 'c1', 1)])), [
        ['c1'],
      ]);
      expect(_ids(recentTabs([_s('claude', 'c1', 1), _s('codex', 'x1', 2)])), [
        ['c1', 'x1'],
      ]);
      expect(_ids(recentTabs(const [])), isEmpty);
    });

    test(
      'order in, order out: an unsorted list is sorted by last activity',
      () {
        final tabs = recentTabs([
          _s('claude', 'c3', 30),
          _s('claude', 'c1', 10),
          _s('claude', 'c2', 20),
        ]);
        expect(_ids(tabs), [
          ['c1', 'c2'],
          ['c3'],
        ]);
      },
    );
  });

  test('never starts two of one engine at once', () {
    final waves = oneOfEachEngine([
      _s('claude', 'c1', 1),
      _s('claude', 'c2', 2),
      _s('codex', 'x1', 3),
      _s('claude', 'c3', 4),
    ]);
    expect(_ids(waves), [
      ['c1', 'x1'],
      ['c2'],
      ['c3'],
    ]);
    expect(oneOfEachEngine(const []), isEmpty);
  });

  group('planFirstArrival', () {
    test('conversations win, whatever is installed', () {
      final plan = planFirstArrival(
        newUser: false,
        sessions: [_s('claude', 'c1', 1)],
        installed: const {'claude', 'codex', 'opencode'},
      );
      expect(_ids(plan.tabs), [
        ['c1'],
      ]);
      expect(plan.fresh, isEmpty);
    });

    test(
      'a new user gets OpenCode, Codex and Claude Code, OpenCode typed into',
      () {
        final plan = planFirstArrival(
          newUser: true,
          sessions: const [],
          installed: const {},
        );
        expect(plan.fresh, ['opencode', 'codex', 'claude']);
        expect(plan.typesStarterTask, isTrue);
      },
    );

    test('agents but no conversations: a fresh pane on each of Claude Code and Codex', () {
      expect(
        planFirstArrival(
          newUser: false,
          sessions: const [],
          installed: const {'claude', 'codex', 'opencode'},
        ).fresh,
        ['claude', 'codex'],
      );
      expect(
        planFirstArrival(
          newUser: false,
          sessions: const [],
          installed: const {'codex'},
        ).fresh,
        ['codex'],
      );
      final claude = planFirstArrival(
        newUser: false,
        sessions: const [],
        installed: const {'claude'},
      );
      expect(claude.fresh, ['claude']);
      expect(claude.typesStarterTask, isFalse);
    });

    test(
      'agents nobody has signed in to: OpenCode leads, they sit beside it',
      () {
        final codex = planFirstArrival(
          newUser: false,
          sessions: const [],
          installed: const {'codex'},
          signedOut: const {'codex'},
        );
        expect(codex.fresh, ['opencode', 'codex']);
        expect(codex.typesStarterTask, isTrue);
        expect(
          planFirstArrival(
            newUser: false,
            sessions: const [],
            installed: const {'claude', 'codex'},
            signedOut: const {'claude', 'codex'},
          ).fresh,
          ['opencode', 'codex', 'claude'],
        );
        // One signed in is enough to start on: no OpenCode.
        expect(
          planFirstArrival(
            newUser: false,
            sessions: const [],
            installed: const {'claude', 'codex'},
            signedOut: const {'codex'},
          ).fresh,
          ['claude', 'codex'],
        );
        // Their conversations still come first.
        expect(
          planFirstArrival(
            newUser: false,
            sessions: [_s('codex', 'x1', 1)],
            installed: const {'codex'},
            signedOut: const {'codex'},
          ).fresh,
          isEmpty,
        );
      },
    );

    test('OpenCode alone gets OpenCode with the starter task', () {
      final plan = planFirstArrival(
        newUser: false,
        sessions: const [],
        installed: const {'opencode'},
      );
      expect(plan.fresh, ['opencode']);
      expect(plan.typesStarterTask, isTrue);
    });

    test('nothing to open leaves the New Harness box', () {
      expect(
        planFirstArrival(
          newUser: false,
          sessions: const [],
          installed: const {},
        ).isEmpty,
        isTrue,
      );
    });
  });

  group('sessionsFromHits', () {
    test('keeps Claude Code and Codex conversations nothing is running', () {
      final sessions = sessionsFromHits([
        _hit('old', minutesAgo: 30),
        _hit('new', engine: 'codex', minutesAgo: 1),
        _hit('running', open: true, openIn: 'app'),
        _hit('in-terminal', open: true, openIn: 'terminal'),
        _hit('other-engine', engine: 'gemini'),
        _hit('harness-own', external: false),
        _hit('gone', cwd: '/gone'),
        _hit('old', minutesAgo: 30),
      ], folderExists: (path) => path != '/gone');
      expect([for (final s in sessions) s.sessionId], ['new', 'old']);
      expect(sessions.first.engine, 'codex');
      expect(sessions.first.title, 'Title new');
      expect(sessions.first.cwd, '/work/new');
    });
  });

  group('FirstArrival', () {
    // Production order: setup's begin runs before the signed-in restore.
    test(
      'runs only on a computer setup has just reached, and only once',
      () async {
        final store = _MemoryStore();
        final existing = FirstArrival(store);
        await existing.restore();
        expect(existing.pending, isFalse, reason: 'an existing install');

        final fresh = FirstArrival(store)..begin(downloads: true);
        await fresh.restore();
        expect(fresh.pending, isTrue);
        expect(store.values[FirstArrival.key], 'new');

        // A relaunch before the workspace opened still owes it.
        final again = FirstArrival(store);
        await again.restore();
        expect(again.pending, isTrue);
      },
    );

    test(
      'a spent mark stays spent, even when setup runs again first',
      () async {
        final store = _MemoryStore()..values[FirstArrival.key] = 'done';
        final arrival = FirstArrival(store)..begin(downloads: false);
        await arrival.restore();
        expect(arrival.pending, isFalse);
        expect(store.values[FirstArrival.key], 'done');
      },
    );

    test('spends the mark when the computer never answers, so it never fires later', () async {
      final store = _MemoryStore();
      final arrival = FirstArrival(store)..begin(downloads: true);
      await arrival.restore();
      final app = AppNotifier(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
      );
      addTearDown(app.dispose);
      expect(await arrival.run(app, machineWait: Duration.zero), isFalse);
      expect(arrival.pending, isFalse);
      await Future<void>.delayed(Duration.zero);
      expect(store.values[FirstArrival.key], 'done');
      expect(await arrival.run(app, machineWait: Duration.zero), isFalse);
    });

    test('a second call joins the run under way', () async {
      final arrival = FirstArrival(_MemoryStore())..begin(downloads: true);
      await arrival.restore();
      final app = AppNotifier(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
      );
      addTearDown(app.dispose);
      final first = arrival.run(
        app,
        machineWait: const Duration(milliseconds: 300),
      );
      expect(arrival.running, isTrue);
      expect(arrival.pending, isFalse);
      // The workspace's call, with none of its own settings: it waits for the same run.
      final joined = arrival.run(app);
      expect(await Future.wait([first, joined]), [false, false]);
      expect(arrival.running, isFalse);
      expect(await arrival.run(app), isFalse, reason: 'spent');
    });

    test('the person taking over first stops it and spends the mark', () async {
      final arrival = FirstArrival(_MemoryStore())..begin(downloads: true);
      await arrival.restore();
      final app = AppNotifier(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
      );
      addTearDown(app.dispose);
      expect(
        await arrival.run(
          app,
          stillCurrent: () => false,
          machineWait: Duration.zero,
        ),
        isFalse,
      );
      expect(arrival.pending, isFalse);
    });
  });

  test("OpenCode's home screen is recognised by its prompt hints", () {
    expect(
      FirstArrival.openCodeReady('Installing OpenCode…  about 10 s'),
      isFalse,
    );
    expect(FirstArrival.openCodeReady(''), isFalse);
    expect(
      FirstArrival.openCodeReady(
        '  Build  · claude-sonnet\n   ctrl+p commands',
      ),
      isTrue,
    );
    expect(FirstArrival.openCodeReady('Ask anything... "Fix a TODO"'), isTrue);
    // Another agent's or a shell's screen never passes.
    expect(
      FirstArrival.openCodeReady(
        '? for shortcuts  shift+tab to cycle  /agents',
      ),
      isFalse,
    );
    expect(
      FirstArrival.openCodeReady('admin@mac ~ % ls table stable'),
      isFalse,
    );
  });
}
