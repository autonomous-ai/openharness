import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/agent_messages/shared_tabs_model.dart' show memberDeskTabId;
import 'package:harness/agent_messages/shared_tab_dialogs.dart';
import 'package:harness/agent_messages/shared_tab_errors.dart';
import 'package:harness/agent_messages/shared_tabs.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/sharing/share_harness_dialog.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/swarm.dart';
import 'package:harness/ws/ws_conn.dart';

import 'swarm_state_test.dart' show createApp, MemoryStore;

const _tab = 'aaaaaaaaaaaaaaaaaaaaaaaa';

Map<String, dynamic> _shares({
  required String owner,
  String? deskTab,
  List<Map<String, dynamic>> invites = const [],
}) => {
  'api': 2,
  'me': {'accountId': 'bob', 'email': 'bob@example.com', 'machineId': 'm'},
  'rosters': [
    {
      'sharedTabId': _tab,
      'tabId': deskTab,
      'version': 3,
      'name': 'app',
      'owner': {
        'accountId': owner,
        'email': '$owner@example.com',
        'machineId': 'ma',
        'machinePublicKey': 'k',
      },
      'leader': null,
      'members': [],
      'invites': invites,
      'harnesses': [],
    },
  ],
  'invites': [],
  'alerts': [],
  'pending': [],
  'notices': [],
  'untrusted': [],
  'activity': [],
};

/// A daemon that records every `agent_messages` ask and answers from a script.
class _Daemon extends WsConn {
  _Daemon()
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'm',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );

  final asked = <Map<String, dynamic>>[];
  Map<String, dynamic> shares = _shares(owner: 'bob');
  Map<String, dynamic> Function(Map<String, dynamic>)? answer;
  WsRequestFailure? fail;

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    if (type != 'agent_messages') return const {};
    final action = payload['action'];
    if (action == 'shares') return shares;
    asked.add(payload);
    if (fail != null) throw fail!;
    return answer?.call(payload) ?? const {};
  }

  List<String> get actions => [for (final p in asked) p['action'] as String];
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late _Daemon daemon;
  late AppNotifier app;

  Future<void> open(WidgetTester tester) async {
    tester.view.physicalSize = const Size(1000, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    daemon = _Daemon();
    app = createApp(store: MemoryStore(), connectionForTest: (_) => daemon, connected: true);
    app.machineStates['m']!.localOnly = true;
    addTearDown(app.dispose);
    await tester.runAsync(() => app.sharedTabs.refresh());
  }

  Future<void> pumpHost(
    WidgetTester tester,
    Future<void> Function(BuildContext, AppNotifier) show,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        home: Scaffold(
          body: Builder(
            builder: (context) => TextButton(
              onPressed: () => show(context, app),
              child: const Text('Open'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('Open'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
  }

  Future<void> settle(WidgetTester tester) async {
    for (var i = 0; i < 6; i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 10)));
      await tester.pump(const Duration(milliseconds: 50));
    }
  }

  Future<void> typeEmails(WidgetTester tester, String text) async {
    await tester.tap(find.byKey(const ValueKey('share-field-people')));
    await tester.pump();
    await tester.enterText(find.byType(TextField), text);
    await tester.pump();
  }

  testWidgets('the first invitation shares the tab, then invites', (tester) async {
    await open(tester);
    app.swarms.add(Swarm(id: 'swarm-3', name: 'app'));
    daemon.answer = (p) => switch (p['action']) {
      'share_tab' => {'sharedTabId': 's1'},
      'share_invite' => {'invited': ['carol@example.com'], 'refused': []},
      _ => const {},
    };
    await pumpHost(tester, (c, a) => showInvitePeople(c, a, 'swarm-3'));
    await settle(tester);
    await typeEmails(tester, 'carol@example.com');
    await tester.tap(find.byKey(const ValueKey('share-choice-1')));
    await settle(tester);
    expect(daemon.asked, [
      {'action': 'share_tab', 'tabId': 'swarm-3', 'name': 'app'},
      {'action': 'share_invite', 'sharedTabId': 's1', 'emails': ['carol@example.com'], 'days': 30},
    ]);
    expect(find.text('1 person invited.'), findsOneWidget);
  });

  testWidgets('a shared tab invites without sharing again, lists pending invitations without Revoke', (tester) async {
    await open(tester);
    daemon.shares = _shares(
      owner: 'bob',
      deskTab: 'swarm-3',
      invites: [
        {'email': 'dave@example.com', 'expiresAt': '2026-11-01T00:00:00.000Z'},
      ],
    );
    await tester.runAsync(() => app.sharedTabs.refresh());
    daemon.answer = (p) => {
      'invited': ['carol@example.com'],
      'refused': [
        {'email': 'eve@example.com', 'error': 'TAB_FULL'},
      ],
    };
    await pumpHost(tester, (c, a) => showInvitePeople(c, a, 'swarm-3'));
    await settle(tester);
    await tester.tap(find.byKey(const ValueKey('share-field-people')));
    await tester.pump();
    expect(find.text('dave@example.com'), findsOneWidget);
    expect(find.textContaining('Remove'), findsNothing);
    await tester.enterText(find.byType(TextField), 'carol@example.com, eve@example.com');
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('share-choice-1')));
    await settle(tester);
    expect(daemon.actions, ['share_invite']);
    expect(daemon.asked.single['sharedTabId'], _tab);
    expect(find.text('eve@example.com: A shared tab holds 32 harnesses and 8 people.'), findsOneWidget);
  });

  testWidgets('a failing action shows its text in the form', (tester) async {
    await open(tester);
    daemon.fail = const WsRequestFailure(
      responseType: 'agent_messages_result',
      code: 'SHARED_TABS_UNSUPPORTED',
    );
    app.swarms.add(Swarm(id: 'swarm-3', name: 'app'));
    await pumpHost(tester, (c, a) => showInvitePeople(c, a, 'swarm-3'));
    await settle(tester);
    await typeEmails(tester, 'carol@example.com');
    await tester.tap(find.byKey(const ValueKey('share-choice-1')));
    await settle(tester);
    expect(find.text('Shared tabs aren\'t available on the Harness service yet.'), findsOneWidget);
  });

  testWidgets('tab mode has no Copy, Access or Comments, and refuses a ninth address', (tester) async {
    var invites = 0;
    tester.view.physicalSize = const Size(1000, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        home: Scaffold(
          body: ShareHarnessDialog(
            name: 'app',
            tabMode: true,
            manage: (action, payload) async {
              if (action == 'invite') invites++;
              return {'collaboration': true, 'shares': <Map<String, dynamic>>[]};
            },
          ),
        ),
      ),
    );
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.text('Copy link'), findsNothing);
    expect(find.byKey(const ValueKey('share-field-access')), findsNothing);
    expect(find.byKey(const ValueKey('share-field-comments')), findsNothing);
    await tester.tap(find.text('Options'));
    await tester.pump();
    expect(find.byKey(const ValueKey('share-field-comments')), findsNothing);
    await tester.tap(find.byKey(const ValueKey('share-field-people')));
    await tester.pump();
    final nine = [for (var i = 0; i < 9; i++) 'p$i@example.com'].join(', ');
    await tester.enterText(find.byType(TextField), nine);
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('share-choice-1')));
    await tester.pump();
    expect(invites, 0);
    expect(find.text('Enter up to 8 valid email addresses, separated by commas.'), findsOneWidget);
    await tester.enterText(find.byType(TextField), nine.split(', ').take(8).join(', '));
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('share-choice-1')));
    await tester.pump();
    expect(invites, 1);
  });

  testWidgets('a pending invitation has Revoke, which sends its id', (tester) async {
    await open(tester);
    daemon.shares = _shares(owner: 'bob', deskTab: 'swarm-3');
    ((daemon.shares['rosters'] as List).first as Map)['pendingInvites'] = [
      {'id': 'inv1', 'email': 'dave@example.com', 'expiresAt': '2026-11-01T00:00:00.000Z'},
    ];
    await tester.runAsync(() => app.sharedTabs.refresh());
    await pumpHost(tester, (c, a) => showInvitePeople(c, a, 'swarm-3'));
    await settle(tester);
    await tester.tap(find.byKey(const ValueKey('share-field-people')));
    await tester.pump();
    expect(find.text('dave@example.com'), findsOneWidget);
    await tester.tap(find.text('Revoke dave@example.com'));
    await settle(tester);
    expect(daemon.asked, [
      {'action': 'share_revoke', 'inviteId': 'inv1'},
    ]);
  });

  testWidgets('refused addresses stay in the field', (tester) async {
    await open(tester);
    daemon.shares = _shares(owner: 'bob', deskTab: 'swarm-3');
    await tester.runAsync(() => app.sharedTabs.refresh());
    daemon.answer = (p) => {
      'invited': ['carol@example.com'],
      'refused': [
        {'email': 'eve@example.com', 'error': 'TAB_FULL'},
      ],
    };
    await pumpHost(tester, (c, a) => showInvitePeople(c, a, 'swarm-3'));
    await settle(tester);
    await typeEmails(tester, 'carol@example.com, eve@example.com');
    await tester.tap(find.byKey(const ValueKey('share-choice-1')));
    await settle(tester);
    expect(tester.widget<TextField>(find.byType(TextField)).controller!.text, 'eve@example.com');
  });

  testWidgets('a share_tab answer without an id fails and sends no invitation', (tester) async {
    await open(tester);
    app.swarms.add(Swarm(id: 'swarm-3', name: 'app'));
    daemon.answer = (p) => const {};
    await pumpHost(tester, (c, a) => showInvitePeople(c, a, 'swarm-3'));
    await settle(tester);
    await typeEmails(tester, 'carol@example.com');
    await tester.tap(find.byKey(const ValueKey('share-choice-1')));
    await settle(tester);
    expect(daemon.actions, ['share_tab']);
    expect(find.text('Something went wrong. Try again in a moment.'), findsOneWidget);
  });

  testWidgets('MACHINE_AWAY names the owner\'s own computer', (tester) async {
    await open(tester);
    daemon.shares = _shares(owner: 'bob', deskTab: 'swarm-3');
    ((daemon.shares['rosters'] as List).first as Map)['owner']['machineId'] = 'm';
    await tester.runAsync(() => app.sharedTabs.refresh());
    await pumpHost(tester, (c, a) => confirmStopSharing(c, a, 'swarm-3'));
    daemon.fail = const WsRequestFailure(responseType: 'agent_messages_result', code: 'MACHINE_AWAY');
    await tester.tap(find.byKey(const Key('shared-tab-confirm')));
    await settle(tester);
    expect(find.text('Test host is away. Try again when it\'s on.'), findsOneWidget);
  });

  group('confirmations', () {
    Future<void> shared(WidgetTester tester, String owner, Future<void> Function(BuildContext, AppNotifier) show) async {
      await open(tester);
      daemon.shares = _shares(owner: owner, deskTab: owner == 'bob' ? 'swarm-3' : null);
      await tester.runAsync(() => app.sharedTabs.refresh());
      await pumpHost(tester, show);
    }

    testWidgets('Stop Sharing asks first, then share_stop', (tester) async {
      await shared(tester, 'bob', (c, a) => confirmStopSharing(c, a, 'swarm-3'));
      expect(find.text('Stop sharing "app"?'), findsOneWidget);
      expect(find.text('Everyone in it loses its harnesses\' terminals and messages.'), findsOneWidget);
      expect(daemon.asked, isEmpty);
      await tester.tap(find.byKey(const Key('shared-tab-confirm')));
      await settle(tester);
      expect(daemon.asked, [
        {'action': 'share_stop', 'sharedTabId': _tab},
      ]);
      expect(find.text('Stop sharing "app"?'), findsNothing);
    });

    testWidgets('Cancel asks nothing', (tester) async {
      await shared(tester, 'bob', (c, a) => confirmStopSharing(c, a, 'swarm-3'));
      await tester.tap(find.text('Cancel'));
      await settle(tester);
      expect(daemon.asked, isEmpty);
      expect(find.text('Stop sharing "app"?'), findsNothing);
    });

    testWidgets('Leave asks first, then share_leave', (tester) async {
      await shared(tester, 'alice', (c, a) => confirmLeaveTab(c, a, memberDeskTabId(_tab)));
      expect(find.text('Leave "app"?'), findsOneWidget);
      expect(find.text('Your harnesses leave the tab. alice@example.com can invite you again.'), findsOneWidget);
      await tester.tap(find.byKey(const Key('shared-tab-confirm')));
      await settle(tester);
      expect(daemon.asked, [
        {'action': 'share_leave', 'sharedTabId': _tab},
      ]);
    });

    testWidgets('Move here explains and calls share_move', (tester) async {
      await shared(tester, 'bob', (c, a) => confirmMoveHere(c, a, 'swarm-3'));
      expect(
        find.textContaining('Members whose computers can\'t confirm the move will be asked to trust this computer.'),
        findsOneWidget,
      );
      daemon.answer = (_) => {'sharedTabId': _tab, 'version': 4};
      await tester.tap(find.byKey(const Key('shared-tab-confirm')));
      await settle(tester);
      expect(daemon.asked, [
        {'action': 'share_move', 'sharedTabId': _tab},
      ]);
    });

    testWidgets('a refusal shows its text and the dialog stays open', (tester) async {
      await shared(tester, 'bob', (c, a) => confirmMoveHere(c, a, 'swarm-3'));
      daemon.fail = const WsRequestFailure(responseType: 'agent_messages_result', code: 'NOT_OWNER');
      await tester.tap(find.byKey(const Key('shared-tab-confirm')));
      await settle(tester);
      expect(find.text('Only the computer that shares this tab can change it.'), findsOneWidget);
      expect(find.byKey(const Key('shared-tab-confirm')), findsOneWidget);
    });

    testWidgets('a hostile tab name is one plain, ellipsized line', (tester) async {
      await open(tester);
      daemon.shares = _shares(owner: 'alice');
      ((daemon.shares['rosters'] as List).first as Map)['name'] = '\u202Eevil\n${'x' * 200}';
      await tester.runAsync(() => app.sharedTabs.refresh());
      await pumpHost(tester, (c, a) => confirmLeaveTab(c, a, memberDeskTabId(_tab)));
      // Capped at 40 characters (C5): a 200-character name cannot make the title unbounded.
      final title = find.text('Leave "evil ${'x' * 34}…"?');
      expect(title, findsOneWidget);
      final text = tester.widget<Text>(title);
      expect(text.overflow, TextOverflow.ellipsis);
      expect(text.maxLines, 2);
      expect(find.textContaining('\u202E'), findsNothing);
      expect(tester.takeException(), isNull);
    });
  });

  for (final (code, text) in [
    ('MACHINE_AWAY', 'Bob\'s laptop is away. Try again when it\'s on.'),
    ('TAB_FULL', 'A shared tab holds 32 harnesses and 8 people.'),
    ('RATE_LIMITED', 'This tab sent 120 messages in 10 minutes. Try again in a few minutes.'),
    ('TOO_LARGE', 'That message is too long for a shared tab.'),
    ('SHARED_TABS_UNSUPPORTED', 'Shared tabs aren\'t available on the Harness service yet.'),
    ('DAEMON_TOO_OLD', 'Update Harness on this computer to share tabs.'),
    ('UNKNOWN_ACTION', 'Update Harness on this computer to share tabs.'),
    ('UNSUPPORTED', 'Update Harness on this computer to share tabs.'),
    ('NOT_OWNER', 'Only the computer that shares this tab can change it.'),
    ('SHARED_ELSEWHERE', 'This tab is already shared from another of your computers. Change it there.'),
    ('RELAY_TAKEN', 'This tab is connected from another place; messages wait here.'),
  ]) {
    test('$code reads "$text"', () {
      expect(
        sharedTabErrorText(SharedTabsFailure(code, ''), machine: 'Bob\'s laptop'),
        text,
      );
    });
  }

  test('MACHINE_AWAY without a known own computer says "That computer"', () {
    expect(sharedTabErrorText(const SharedTabsFailure('MACHINE_AWAY', '')), 'That computer is away. Try again when it\'s on.');
  });

  test('another code shows the daemon\'s sentence as plain text, or a general one', () {
    expect(
      sharedTabErrorText(const SharedTabsFailure('X', 'Nope\u202E\nreally')),
      'Nope really',
    );
    expect(sharedTabErrorText(const SharedTabsFailure('X', 'X')), 'Something went wrong. Try again in a moment.');
    expect(sharedTabErrorText(const SharedTabsFailure('X', '')), 'Something went wrong. Try again in a moment.');
  });
}
