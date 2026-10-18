import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/agent_messages/shared_tab_dialogs.dart';
import 'package:harness/agent_messages/shared_tabs_model.dart' hide SharedTabNotice;
import 'package:harness/core/models.dart';
import 'package:harness/settings/experimental_features.dart';
import 'package:harness/settings/sections/tab_invites_section.dart';
import 'package:harness/settings/settings_section.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/widgets/shared_tab_notice.dart';
import 'package:harness/ws/ws_conn.dart';

import 'swarm_state_test.dart' show createApp, MemoryStore;

Map<String, dynamic> _invite({
  String id = 'i1',
  String tabName = 'app',
  String expiresAt = '2026-10-30T00:00:00.000Z',
}) => {
  'id': id,
  'sharedTabId': 's1',
  'ownerEmail': 'alice@example.com',
  'ownerMachineId': 'ma',
  'tabName': tabName,
  'expiresAt': expiresAt,
};

Map<String, dynamic> _shares({
  List<Map<String, dynamic>> invites = const [],
  List<Map<String, dynamic>> untrusted = const [],
  List<Map<String, dynamic>> notices = const [],
}) => {
  'api': 2,
  'me': {'accountId': 'bob', 'email': 'bob@example.com', 'machineId': 'm'},
  'rosters': [],
  'invites': invites,
  'alerts': [],
  'pending': [],
  'notices': notices,
  'untrusted': untrusted,
  'activity': [],
};

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
  Map<String, dynamic> shares = _shares();
  Map<String, dynamic> Function(Map<String, dynamic>)? answer;

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
    return answer?.call(payload) ?? const {};
  }

  List<String> get actions => [for (final p in asked) p['action'] as String];
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late _Daemon daemon;
  late AppNotifier app;
  late MemoryStore store;

  Future<void> open(WidgetTester tester) async {
    tester.view.physicalSize = const Size(1000, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    daemon = _Daemon();
    store = MemoryStore();
    app = createApp(store: store, connectionForTest: (_) => daemon, connected: true);
    app.machineStates['m']!.localOnly = true;
    app.machineStates['m']!.agents = [
      Agent(id: 'a1', name: 'Fixer', engine: 'codex', terminalAvailable: true),
      Agent(id: 'a2', name: 'Writer', engine: 'claude', terminalAvailable: true),
    ];
    addTearDown(app.dispose);
    await tester.runAsync(() => app.sharedTabs.refresh());
  }

  Future<void> settle(WidgetTester tester) async {
    for (var i = 0; i < 6; i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 10)));
      await tester.pump(const Duration(milliseconds: 50));
    }
  }

  Widget host(Widget child) => MaterialApp(
    theme: grid.buildAppTheme(brightness: Brightness.dark),
    home: Scaffold(body: child),
  );

  Future<void> pumpDialog(
    WidgetTester tester,
    Future<void> Function(BuildContext, AppNotifier) show,
  ) async {
    await tester.pumpWidget(
      host(
        Builder(
          builder: (context) => TextButton(
            onPressed: () => show(context, app),
            child: const Text('Open'),
          ),
        ),
      ),
    );
    await tester.tap(find.text('Open'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
  }

  testWidgets('a new invitation shows one notice with View, once per invitation', (tester) async {
    await open(tester);
    daemon.shares = _shares(invites: [_invite()]);
    await tester.runAsync(() => app.sharedTabs.refresh());
    await tester.pumpWidget(host(SharedTabNotice(notifier: app)));
    await settle(tester);
    expect(
      tester.widget<Text>(find.byKey(const Key('shared-tab-notice'))).data,
      'alice@example.com invited you to the tab "app"',
    );
    expect(store.values['shared_tabs.invites_seen.bob'], contains('i1'));

    await tester.tap(find.byKey(const Key('shared-tab-notice-view')));
    await tester.pump();
    expect(app.takeSharedTabsRequest(), isTrue);
    expect(app.takeSharedTabsRequest(), isFalse);
    expect(find.byKey(const Key('shared-tab-notice')), findsNothing);

    // The same invitation read again: no second notice.
    await tester.runAsync(() => app.sharedTabs.refresh());
    await settle(tester);
    expect(find.byKey(const Key('shared-tab-notice')), findsNothing);

    // Nor after a restart of the window (a fresh widget, same store).
    await tester.pumpWidget(host(const SizedBox()));
    await tester.pumpWidget(host(SharedTabNotice(notifier: app)));
    await settle(tester);
    expect(find.byKey(const Key('shared-tab-notice')), findsNothing);

    // A different invitation is new.
    daemon.shares = _shares(invites: [_invite(), _invite(id: 'i2')]);
    await tester.runAsync(() => app.sharedTabs.refresh());
    await settle(tester);
    expect(find.byKey(const Key('shared-tab-notice')), findsOneWidget);
  });

  testWidgets('a re-invitation (same id, later expiry) shows again; the same one after a restart does not', (tester) async {
    await open(tester);
    daemon.shares = _shares(invites: [_invite()]);
    await tester.runAsync(() => app.sharedTabs.refresh());
    await tester.pumpWidget(host(SharedTabNotice(notifier: app)));
    await settle(tester);
    expect(find.byKey(const Key('shared-tab-notice')), findsOneWidget);
    await tester.tap(find.byKey(const Key('shared-tab-notice-dismiss')));
    await tester.pump();
    expect(find.byKey(const Key('shared-tab-notice')), findsNothing);

    // Restart: same id and expiry, same store: nothing.
    await tester.pumpWidget(host(const SizedBox()));
    await tester.pumpWidget(host(SharedTabNotice(notifier: app)));
    await settle(tester);
    expect(find.byKey(const Key('shared-tab-notice')), findsNothing);

    // The backend reuses the id when the owner invites again; the expiry is new.
    daemon.shares = _shares(invites: [_invite(expiresAt: '2026-11-15T00:00:00.000Z')]);
    await tester.runAsync(() => app.sharedTabs.refresh());
    await settle(tester);
    expect(find.byKey(const Key('shared-tab-notice')), findsOneWidget);
  });

  testWidgets('an invitation from an older backend says "a tab"', (tester) async {
    await open(tester);
    daemon.shares = _shares(invites: [_invite(tabName: '')]);
    await tester.runAsync(() => app.sharedTabs.refresh());
    await tester.pumpWidget(host(SharedTabNotice(notifier: app)));
    await settle(tester);
    expect(
      tester.widget<Text>(find.byKey(const Key('shared-tab-notice'))).data,
      'alice@example.com invited you to a tab',
    );
  });

  testWidgets('a daemon notice shows its copy and dismiss goes to the daemon', (tester) async {
    await open(tester);
    daemon.shares = _shares(
      notices: [
        {'id': 'n1', 'sharedTabId': 's1', 'kind': 'removed', 'at': 'x', 'ownerEmail': 'alice@example.com'},
      ],
    );
    daemon.answer = (_) => {};
    await tester.runAsync(() => app.sharedTabs.refresh());
    await tester.pumpWidget(host(SharedTabNotice(notifier: app)));
    await settle(tester);
    expect(find.byKey(const Key('shared-tab-notice')), findsOneWidget);
    expect(
      tester.widget<Text>(find.byKey(const Key('shared-tab-notice'))).data,
      'You were removed from alice@example.com\'s tab',
    );
    await tester.tap(find.byKey(const Key('shared-tab-notice-dismiss')));
    await settle(tester);
    expect(daemon.asked.last, {'action': 'share_notice_dismiss', 'id': 'n1'});
  });

  testWidgets('a removed notice without an owner email says "a tab"', (tester) async {
    await open(tester);
    daemon.shares = _shares(
      notices: [
        {'id': 'n2', 'sharedTabId': 's1', 'kind': 'removed', 'at': 'x'},
      ],
    );
    await tester.runAsync(() => app.sharedTabs.refresh());
    await tester.pumpWidget(host(SharedTabNotice(notifier: app)));
    await settle(tester);
    expect(
      tester.widget<Text>(find.byKey(const Key('shared-tab-notice'))).data,
      'You were removed from a tab',
    );
  });

  testWidgets('another account\'s long email with a bidi override stays one bounded line', (tester) async {
    await open(tester);
    final hostile = '\u202E${'a' * 200}@example.com';
    final invite = SharedTabInvite.fromJson({
      ..._invite(),
      'ownerEmail': hostile,
      'tabName': 'b' * 200,
    })!;
    daemon.shares = _shares(
      invites: [
        {..._invite(), 'ownerEmail': hostile, 'tabName': 'b' * 200},
      ],
      untrusted: [
        {'sharedTabId': 's2', 'ownerEmail': hostile},
      ],
    );
    await tester.runAsync(() => app.sharedTabs.refresh());
    await tester.pumpWidget(host(TabInvitesSection(notifier: app)));
    await settle(tester);
    final texts = tester.widgetList<Text>(find.byType(Text)).map((t) => t.data ?? '');
    expect(texts.where((t) => t.contains('\u202E')), isEmpty);
    expect(texts.every((t) => t.length < 130), isTrue, reason: texts.toString());
    await tester.pumpWidget(host(const SizedBox()));
    await pumpDialog(tester, (c, a) => showAcceptInvite(c, a, invite));
    final dialog = tester.widgetList<Text>(find.byType(Text)).map((t) => t.data ?? '');
    expect(dialog.where((t) => t.contains('\u202E')), isEmpty);
    expect(dialog.every((t) => t.length < 200), isTrue, reason: dialog.toString());
    expect(tester.takeException(), isNull);
  });

  testWidgets('an accept without a fingerprint does not ask to compare', (tester) async {
    await open(tester);
    daemon.answer = (p) => {'sharedTabId': 's1'};
    final invite = SharedTabInvite.fromJson(_invite())!;
    await pumpDialog(tester, (c, a) => showAcceptInvite(c, a, invite));
    await tester.tap(find.byKey(const Key('shared-invite-accept')));
    await settle(tester);
    expect(find.textContaining('Compare it with'), findsNothing);
    expect(find.text('Add harnesses'), findsOneWidget);
  });

  testWidgets('Trust again offers Try again when the check fails', (tester) async {
    await open(tester);
    var fail = true;
    daemon.answer = (p) {
      if (fail) {
        throw const WsRequestFailure(
          responseType: 'agent_messages_result',
          code: 'MACHINE_AWAY',
          detail: '',
        );
      }
      return {'sharedTabId': 's2', 'ownerEmail': 'alice@example.com', 'ownerPub': 'P', 'fingerprint': 'F1', 'version': 1};
    };
    await pumpDialog(tester, (c, a) => showTrustAgain(c, a, 's2'));
    await settle(tester);
    expect(find.byKey(const Key('shared-trust-retry')), findsOneWidget);
    fail = false;
    await tester.tap(find.byKey(const Key('shared-trust-retry')));
    await settle(tester);
    expect(find.text('New: F1'), findsOneWidget);
    expect(find.byKey(const Key('shared-trust-retry')), findsNothing);
  });

  testWidgets('Accept shows the promise, then the fingerprint after it succeeds', (tester) async {
    await open(tester);
    daemon.answer = (p) => {'sharedTabId': 's1', 'fingerprint': 'AB12 CD34'};
    final invite = SharedTabInvite.fromJson(_invite())!;
    await pumpDialog(tester, (c, a) => showAcceptInvite(c, a, invite));
    expect(find.text('app'), findsOneWidget);
    expect(find.text('alice@example.com'), findsWidgets);
    expect(
      find.text(
        'alice@example.com and everyone in this tab will see the terminals of the harnesses you add. Only you can type into them.',
      ),
      findsOneWidget,
    );
    expect(find.text('AB12 CD34'), findsNothing);
    await tester.tap(find.byKey(const Key('shared-invite-accept')));
    await settle(tester);
    expect(daemon.asked.first, {'action': 'share_accept', 'inviteId': 'i1'});
    expect(find.text('AB12 CD34'), findsOneWidget);
    expect(
      find.text('Compare it with alice@example.com if you want to be sure.'),
      findsOneWidget,
    );
    expect(find.text('Add harnesses'), findsOneWidget);
  });

  testWidgets('a refused accept shows the daemon\'s message and stays', (tester) async {
    await open(tester);
    final invite = SharedTabInvite.fromJson(_invite())!;
    final failing = daemon;
    failing.answer = (_) => throw const WsRequestFailure(
      responseType: 'agent_messages_result',
      code: 'OWNER_KEY_MISMATCH',
      detail: 'The owner\'s computer key does not match.',
    );
    await pumpDialog(tester, (c, a) => showAcceptInvite(c, a, invite));
    await tester.tap(find.byKey(const Key('shared-invite-accept')));
    await settle(tester);
    expect(find.text('The owner\'s computer key does not match.'), findsOneWidget);
    expect(find.byKey(const Key('shared-invite-accept')), findsOneWidget);
  });

  testWidgets('a pending accept says the tab comes when the owner\'s computer is reachable', (tester) async {
    await open(tester);
    daemon.answer = (p) => {'sharedTabId': 's1', 'pending': true};
    final invite = SharedTabInvite.fromJson(_invite())!;
    await pumpDialog(tester, (c, a) => showAcceptInvite(c, a, invite));
    await tester.tap(find.byKey(const Key('shared-invite-accept')));
    await settle(tester);
    expect(
      find.text('The tab will appear when alice@example.com\'s computer is reachable.'),
      findsOneWidget,
    );
    expect(find.text('Add harnesses'), findsNothing);
  });

  testWidgets('Add harnesses without the desk tab says it comes when the owner\'s computer is reachable', (tester) async {
    await open(tester);
    await pumpDialog(tester, (c, a) => showAddHarnesses(c, a, 's1'));
    expect(find.text('Fixer · codex · Test host'), findsOneWidget);
    await tester.tap(find.text('Fixer · codex · Test host'));
    await tester.pump();
    await tester.tap(find.byKey(const Key('shared-add-confirm')));
    await settle(tester);
    expect(find.text('The tab will appear when the owner\'s computer is reachable.'), findsOneWidget);
    expect(daemon.actions.where((a) => a == 'share_add'), isEmpty);
    expect(find.byKey(const Key('shared-add-confirm')), findsOneWidget);
  });

  testWidgets('New Harness here hands the tab to the caller and closes', (tester) async {
    await open(tester);
    String? target;
    await pumpDialog(
      tester,
      (c, a) => showAddHarnesses(c, a, 's1', onNewHarness: (id) => target = id),
    );
    await tester.tap(find.byKey(const Key('shared-add-new')));
    await tester.pump(const Duration(milliseconds: 300));
    expect(target, 's1');
    expect(find.byKey(const Key('shared-add-confirm')), findsNothing);
  });

  testWidgets('Tab invites lists invitations and untrusted tabs with Trust again', (tester) async {
    await open(tester);
    daemon.shares = _shares(
      invites: [_invite()],
      untrusted: [
        {'sharedTabId': 's2', 'ownerEmail': 'alice@example.com'},
      ],
    );
    daemon.answer = (p) => switch (p['action']) {
      'share_retrust_check' => {
        'sharedTabId': 's2',
        'ownerEmail': 'alice@example.com',
        'ownerPub': 'PUB',
        'fingerprint': 'NEW1 NEW2',
        'version': 4,
        'pinnedFingerprint': 'OLD1 OLD2',
      },
      _ => {},
    };
    await tester.pumpWidget(host(TabInvitesSection(notifier: app)));
    await settle(tester);
    expect(find.text('app'), findsOneWidget);
    expect(find.byKey(const Key('tab-invite-accept-i1')), findsOneWidget);
    expect(find.text('Decline'), findsNothing);
    expect(find.text('alice@example.com\'s computer has a new key.'), findsOneWidget);
    await tester.tap(find.byKey(const Key('tab-invite-trust-s2')));
    await settle(tester);
    expect(daemon.asked.last, {'action': 'share_retrust_check', 'sharedTabId': 's2'});
    expect(find.text('New: NEW1 NEW2'), findsOneWidget);
    expect(find.text('Before: OLD1 OLD2'), findsOneWidget);
    await tester.tap(find.byKey(const Key('shared-trust-confirm')));
    await settle(tester);
    expect(daemon.asked.firstWhere((p) => p['action'] == 'share_retrust'), {
      'action': 'share_retrust',
      'sharedTabId': 's2',
      'ownerPub': 'PUB',
    });
  });

  testWidgets('Tab invites with nothing says so', (tester) async {
    await open(tester);
    await tester.pumpWidget(host(TabInvitesSection(notifier: app)));
    await settle(tester);
    expect(find.text('No invitations.'), findsOneWidget);
  });

  test('Tab invites is a Settings section found by its words', () {
    expect(SettingsSection.tabInvites.label, 'Tab invites');
    for (final q in ['invite', 'shared tab', 'trust']) {
      expect(SettingsSection.tabInvites.matches(q), isTrue, reason: q);
    }
    expect(
      settingsGroups.expand((g) => g.sections),
      contains(SettingsSection.tabInvites),
    );
  });

  test('the switch\'s copy names inviting people', () {
    expect(
      ExperimentalFeature.agentMessages.description,
      contains('Invite people to a tab and their harnesses join it from their own computers.'),
    );
  });
}
