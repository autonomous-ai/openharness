// The Machines view's Subscriptions block shows on every machine row, to every member: a Mac with a Harness Team
// account shows its owner's allowances, the ones its agents spend; an engine without a figure says why instead.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/status_line_style.dart';
import 'package:harness/super_tabs/machines.dart';
import 'package:harness/widgets/desktop_chrome.dart';

import 'support/super_tab_fixture.dart';

const _offlineAge = 10 * 60 * 1000;

Map<String, dynamic> _quota(
  String engine, {
  int? used,
  bool known = true,
  Duration resetsIn = const Duration(hours: 2),
}) => {
  'engine': engine,
  'known': known,
  'windows': [
    if (used != null)
      {
        'name': '5-hour',
        'usedPercent': used,
        'resetsAt': DateTime.now().add(resetsIn).millisecondsSinceEpoch,
      },
  ],
};

Map<String, dynamic> _pool(
  String id, {
  List<String> engines = const ['claude', 'codex'],
  List<Map<String, dynamic>> quotas = const [],
  Map<String, String>? reasons,
  Map<String, bool>? installed,
  String? host,
  int age = 0,
}) => {
  'machineId': id,
  'name': id,
  'contributorId': 'peer',
  'scope': 'swarm',
  'cwd': '/swarm',
  'engines': engines,
  'maxAgents': 4,
  'paused': false,
  'observation': {
    'receivedAt': DateTime.now().millisecondsSinceEpoch - age,
    'quotas': quotas,
    'quotaReasons': ?reasons,
    if (installed != null)
      'readiness': {
        'engines': [
          for (final e in installed.entries)
            {'engine': e.key, 'installed': e.value, 'signedIn': e.value},
        ],
      },
  },
  'hostMachineId': ?host,
  'teamWork': {'allowed': true},
};

/// The owner's Swarm with a teammate, `peer`, whose machines are [machines]; the owner reads them, expanded.
Future<dynamic> _mount(
  WidgetTester tester,
  List<Map<String, dynamic>> machines,
) async {
  final server = ConversationServer();
  (server.state['people'] as List).add({
    'id': 'peer',
    'email': 'peer@example.com',
    'role': 'collaborator',
  });
  server.state['machines'] = machines;
  final c = server.controller(account: 'owner');
  await c.refresh();
  for (final m in machines) {
    if (m['hostMachineId'] == null) c.toggleMachineExpanded(m['machineId']);
  }
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: SuperTabMachines(controller: c, onAddAgent: (_) {}),
      ),
    ),
  );
  await tester.pumpAndSettle();
  return c;
}

Future<void> _unmount(WidgetTester tester, dynamic c) async {
  await tester.pumpWidget(const SizedBox());
  await c.flush();
  c.dispose();
}

Finder _card(String id, String engine) =>
    find.byKey(ValueKey('super-machine-allowance-$id-$engine'));

String? _figure(WidgetTester tester, String id, String engine) => tester
    .widget<Text>(find.byKey(ValueKey('super-machine-figure-$id-$engine')))
    .data;

Color? _figureInk(WidgetTester tester, String id, String engine) => tester
    .widget<Text>(find.byKey(ValueKey('super-machine-figure-$id-$engine')))
    .style
    ?.color;

Finder _inCard(String id, String engine, String text) =>
    find.descendant(of: _card(id, engine), matching: find.text(text));

void main() {
  testWidgets(
    "a teammate's Mac with a Harness Team account shows its owner's subscriptions, not the account's empty sign-in",
    (tester) async {
      final c = await _mount(tester, [
        _pool('mac', quotas: [_quota('claude', used: 38)]),
        // The Team account's own home holds no sign-in: its engines spend the owner's subscription.
        _pool(
          'mac-team',
          engines: ['claude'],
          quotas: [_quota('claude', known: false)],
          host: 'mac',
        ),
      ]);
      expect(c.snapshot!.subscriptionPoolOf('mac')['machineId'], 'mac');
      expect(_figure(tester, 'mac', 'claude'), '62%');
      await _unmount(tester, c);
    },
  );

  testWidgets('a machine signed out of an engine says why, in its own words', (
    tester,
  ) async {
    const why = 'No subscription sign-in is stored on this machine.';
    final c = await _mount(tester, [
      _pool(
        'm',
        engines: ['claude'],
        quotas: [_quota('claude', known: false)],
        reasons: {'claude': why},
      ),
    ]);
    expect(_figure(tester, 'm', 'claude'), '—');
    expect(_inCard('m', 'claude', why), findsOneWidget);
    await _unmount(tester, c);
  });

  testWidgets('an engine on an API key says it has no limits', (tester) async {
    final c = await _mount(tester, [
      _pool('m', engines: ['codex'], quotas: [_quota('codex')]),
    ]);
    expect(_figure(tester, 'm', 'codex'), '—');
    expect(_inCard('m', 'codex', 'API key · no limits'), findsOneWidget);
    await _unmount(tester, c);
  });

  testWidgets(
    'an older Harness that sends no reason asks for an update, also for an engine it did not report',
    (tester) async {
      final c = await _mount(tester, [
        _pool('m', quotas: [_quota('claude', known: false)]),
      ]);
      const update = 'Update Harness on this machine to see it';
      expect(_inCard('m', 'claude', update), findsOneWidget);
      expect(_inCard('m', 'codex', update), findsOneWidget);
      await _unmount(tester, c);
    },
  );

  testWidgets(
    'an offline machine keeps its last figures and says when they were read',
    (tester) async {
      final c = await _mount(tester, [
        _pool(
          'm',
          engines: ['claude'],
          quotas: [_quota('claude', used: 38)],
          age: _offlineAge,
        ),
      ]);
      expect(_figure(tester, 'm', 'claude'), '62%');
      expect(find.textContaining('offline, read 10 min ago'), findsOneWidget);
      await _unmount(tester, c);
    },
  );

  testWidgets(
    'an offline machine whose window reset since it was read keeps its last figure, muted, and says when it was read',
    (tester) async {
      final c = await _mount(tester, [
        _pool(
          'm',
          engines: ['claude'],
          // Read ten minutes ago; the 5-hour window it read has reset since (a Mac offline overnight).
          quotas: [
            _quota('claude', used: 38, resetsIn: const Duration(hours: -3)),
          ],
          age: _offlineAge,
        ),
      ]);
      expect(_figure(tester, 'm', 'claude'), '62%');
      expect(_inCard('m', 'claude', 'Waiting for a new reading'), findsNothing);
      expect(find.textContaining('offline, read 10 min ago'), findsOneWidget);
      await _unmount(tester, c);
    },
  );

  testWidgets(
    'a current reading whose window reset since says it waits for a new reading, with no figure',
    (tester) async {
      final c = await _mount(tester, [
        _pool(
          'm',
          engines: ['claude'],
          quotas: [
            _quota('claude', used: 38, resetsIn: const Duration(minutes: -1)),
          ],
        ),
      ]);
      expect(_figure(tester, 'm', 'claude'), '—');
      expect(
        _inCard('m', 'claude', 'Waiting for a new reading'),
        findsOneWidget,
      );
      expect(find.textContaining('left now'), findsOneWidget);
      await _unmount(tester, c);
    },
  );

  testWidgets(
    'an offline figure is muted, even a low one; a current low one keeps its warning tone',
    (tester) async {
      final c = await _mount(tester, [
        _pool(
          'old',
          engines: ['claude'],
          quotas: [_quota('claude', used: 95)],
          age: _offlineAge,
        ),
        _pool('now', engines: ['claude'], quotas: [_quota('claude', used: 95)]),
        _pool(
          'fine',
          engines: ['claude'],
          quotas: [_quota('claude', used: 10)],
        ),
      ]);
      expect(_figure(tester, 'old', 'claude'), '5%');
      expect(
        _figureInk(tester, 'old', 'claude'),
        statusLineInkOnSurface(DesktopChrome.muted, DesktopChrome.surface),
      );
      // Current readings keep their ink: critical red below 10%, the plain foreground otherwise.
      expect(
        _figureInk(tester, 'now', 'claude'),
        isNot(_figureInk(tester, 'old', 'claude')),
      );
      expect(
        _figureInk(tester, 'fine', 'claude'),
        statusLineInkOnSurface(DesktopChrome.foreground, DesktopChrome.surface),
      );
      await _unmount(tester, c);
    },
  );

  testWidgets(
    'a machine with neither Claude nor Codex still shows the block, saying so',
    (tester) async {
      final c = await _mount(tester, [
        _pool('m', engines: ['opencode']),
      ]);
      expect(find.text('Subscriptions'), findsOneWidget);
      expect(
        find.text('No Claude or Codex allowance reported for this machine'),
        findsOneWidget,
      );
      await _unmount(tester, c);
    },
  );

  testWidgets(
    'an offline machine with no Claude or Codex reading says it is not read yet, with offline beside the heading',
    (tester) async {
      final c = await _mount(tester, [
        _pool('m', engines: ['opencode'], age: _offlineAge),
      ]);
      expect(find.textContaining('Subscriptions · offline'), findsOneWidget);
      expect(
        find.text('Not read yet. Shows when the machine is back online'),
        findsOneWidget,
      );
      expect(
        find.text('No Claude or Codex allowance reported for this machine'),
        findsNothing,
      );
      await _unmount(tester, c);
    },
  );

  testWidgets(
    'a machine whose list still names a retired engine shows its Claude and Codex cards from what is installed',
    (tester) async {
      final c = await _mount(tester, [
        _pool(
          'm',
          engines: ['opencode'],
          installed: {'claude': true, 'codex': true, 'opencode': true},
          age: _offlineAge,
        ),
        _pool(
          'half',
          engines: ['opencode'],
          installed: {'claude': true, 'codex': false},
        ),
        _pool(
          'live',
          engines: ['opencode'],
          installed: {'claude': true, 'codex': true},
          quotas: [_quota('claude', used: 38)],
        ),
      ]);
      expect(_card('m', 'claude'), findsOneWidget);
      expect(_card('m', 'codex'), findsOneWidget);
      const unread = 'Not read yet. Shows when the machine is back online';
      expect(_inCard('m', 'claude', unread), findsOneWidget);
      expect(
        find.text('No Claude or Codex allowance reported for this machine'),
        findsNothing,
      );
      // Only what is installed: Codex is not on this one.
      expect(_card('half', 'claude'), findsOneWidget);
      expect(_card('half', 'codex'), findsNothing);
      // A reading it did send still shows, beside the installed engine that sent none.
      expect(_figure(tester, 'live', 'claude'), '62%');
      expect(_card('live', 'codex'), findsOneWidget);
      await _unmount(tester, c);
    },
  );

  testWidgets(
    'an offline machine that lists Claude and Codex but sent no reading and no install report says it is not read yet, never to update',
    (tester) async {
      final c = await _mount(tester, [_pool('m', age: _offlineAge)]);
      const unread = 'Not read yet. Shows when the machine is back online';
      expect(_inCard('m', 'claude', unread), findsOneWidget);
      expect(_inCard('m', 'codex', unread), findsOneWidget);
      expect(find.textContaining('Update Harness'), findsNothing);
      await _unmount(tester, c);
    },
  );

  testWidgets(
    'a machine the Swarm cannot be read for does not claim to have no allowance',
    (tester) async {
      final server = ConversationServer();
      (server.state['people'] as List).add({
        'id': 'peer',
        'email': 'peer@example.com',
        'role': 'collaborator',
      });
      server.state['machines'] = [
        _pool('m', engines: ['opencode']),
      ];
      final c = server.controller(account: 'owner');
      await c.refresh();
      c.toggleMachineExpanded('m');
      server.failReads = true;
      await c.refresh();
      expect(c.backendUnreachable, isTrue);
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SuperTabMachines(controller: c, onAddAgent: (_) {}),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(
        find.text('No Claude or Codex allowance reported for this machine'),
        findsNothing,
      );
      expect(find.text('Not read yet'), findsOneWidget);
      await _unmount(tester, c);
    },
  );
}
