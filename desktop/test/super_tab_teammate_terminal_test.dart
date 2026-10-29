import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/api/api_client.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/sharing/shared_harness_panel.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/super_tabs/terminal_unavailable.dart';
import 'package:harness/super_tabs/workspace.dart';
import 'package:harness/widgets/pane_grid.dart';
import 'package:harness/ws/local_cli_discovery.dart';

import 'box_render_preview_test.dart' show loadPreviewFonts;
import 'super_tab_launch_test.dart' show SuperTabLaunchFixture, tabId;
import 'swarm_state_test.dart' show MemoryStore;

/// The daemon's machine list, scripted: this computer, and the teammate's once its invitation arrives.
class _Machines extends ApiClient {
  _Machines()
    : super(
        config: AppConfig.dev,
        session: AuthSession(storage: MemoryStore()),
      );
  List<Machine> list = const [_own];
  int reads = 0;
  @override
  Future<List<Machine>> machines() async {
    reads++;
    return list;
  }
}

class _Discovery extends LocalCliDiscovery {
  _Discovery() : super(config: AppConfig.dev);
  @override
  Future<String?> computerId() async => null;
  @override
  Future<LocalCliEndpoint?> discover({String? expectedComputerId}) async =>
      null;
}

const _own = Machine(
  machineId: 'm',
  authMode: MachineAuthMode.remote,
  name: 'Test host',
);
const _computer = 'MacBooks-MacBook-Pro-9';

SharedHarness _invite(int day) => SharedHarness(
  id: 'share-river',
  agentId: 'river-native',
  name: 'Builder',
  engine: 'claude',
  expiresAt: DateTime.utc(2026, 11, day),
  ownerPublicKey: 'DEys/M3p0/VLAiDGLRit4jGJ49PGHZm6eZchm6cYrVo=',
);

/// The teammate's computer as an invitation lists it: shared, with River's terminal to watch.
Machine _teammate(int day) => Machine(
  machineId: 'mate',
  authMode: MachineAuthMode.remote,
  name: _computer,
  isShared: true,
  ownerName: 'Scholes',
  status: 'running',
  sharedHarnesses: [_invite(day)],
);

/// A Swarm where River runs on scholes' computer, contributed by scholes, and this account is another member.
Future<(SuperTabLaunchFixture, _Machines, SuperTabController)> _swarm({
  Duration lastHeard = const Duration(seconds: 5),
  bool confidential = false,
}) async {
  final f = SuperTabLaunchFixture(discovery: _Discovery());
  final api = _Machines();
  f.app.api = api;
  f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
  final state = f.connection.server.state;
  (state['people'] as List).add({
    'id': 'scholes',
    'email': 'scholes@autonomous.ai',
    'role': 'collaborator',
  });
  state['machines'] = [
    {
      'machineId': 'mate',
      'name': _computer,
      'observation': {
        'receivedAt': DateTime.now().subtract(lastHeard).millisecondsSinceEpoch,
      },
    },
  ];
  state['agents'] = [
    {
      'id': 'river',
      'name': 'Builder',
      'displayName': 'River',
      'machineId': 'mate',
      'harnessId': 'river-native',
      'contributorId': 'scholes',
      'machineOwnerId': 'scholes',
      if (confidential) 'confidential': true,
      'configuration': {'engine': 'claude'},
    },
  ];
  (state['conversations'] as List)[0]['agentIds'] = ['river'];
  final c = await f.app.superTabs.open(tabId);
  await c.refresh();
  return (f, api, c);
}

/// Set to a folder to write the workgroup pane as a picture, for a review: `SUPER_TAB_TEAMMATE_SHOTS=/tmp/shots`.
final _shots = Platform.environment['SUPER_TAB_TEAMMATE_SHOTS'];
final _picture = GlobalKey();

Future<void> _show(WidgetTester tester, SuperTabLaunchFixture f) async {
  await tester.binding.setSurfaceSize(const Size(1280, 800));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  await tester.pumpWidget(
    MaterialApp(
      theme: grid.buildAppTheme(brightness: Brightness.dark),
      home: RepaintBoundary(
        key: _picture,
        child: Scaffold(
          body: ListenableBuilder(
            listenable: f.app,
            builder: (_, _) => SuperTabWorkspace(
              app: f.app,
              canvas: PaneGrid(notifier: f.app, swarmMode: true),
              onAddAgent: (_) {},
            ),
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

Future<void> _shoot(WidgetTester tester, String name) async {
  final directory = _shots;
  if (directory == null) return;
  await tester.runAsync(() async {
    final boundary =
        _picture.currentContext!.findRenderObject()! as RenderRepaintBoundary;
    final image = await boundary.toImage();
    final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
    await Directory(directory).create(recursive: true);
    await File('$directory/$name.png')
        .writeAsBytes(bytes!.buffer.asUint8List());
    image.dispose();
  });
}

Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 20; i++) {
    await tester.pump(const Duration(milliseconds: 50));
  }
}

Future<void> _close(
  WidgetTester tester,
  SuperTabLaunchFixture f,
  SuperTabController c,
) async {
  await tester.pumpWidget(const SizedBox());
  // A shared panel's connection gives its socket 2 s to close.
  await tester.pump(const Duration(seconds: 3));
  await c.flush();
  f.app.superTabs.dispose();
  f.dispose();
  await tester.pump();
}

void main() {
  setUpAll(() async {
    if (_shots != null) await loadPreviewFonts();
  });
  group('why a member’s terminal is unavailable', () {
    SuperTabSnapshot snapshot({
      int? receivedAt,
      bool ownerListed = true,
      bool confidential = false,
      bool lead = false,
    }) => SuperTabSnapshot.fromJson({
      'version': 1,
      'id': tabId,
      'name': 'Pilot',
      'ownerId': 'owner',
      'people': [
        {'id': 'owner', 'email': 'owner@example.com', 'role': 'owner'},
        if (ownerListed)
          {
            'id': 'scholes',
            'email': 'scholes@autonomous.ai',
            'role': 'collaborator',
          },
      ],
      'agents': [
        {
          'id': 'river',
          'name': 'Builder',
          'displayName': 'River',
          'machineId': 'mate',
          'harnessId': 'river-native',
          'contributorId': 'scholes',
          'machineOwnerId': 'scholes',
          if (confidential) 'confidential': true,
          'configuration': {'engine': 'claude'},
        },
        {
          'id': 'mine',
          'name': 'Builder',
          'machineId': 'm',
          'harnessId': 'mine-native',
          'contributorId': 'owner',
          'configuration': {'engine': 'codex'},
        },
      ],
      'machines': [
        {
          'machineId': 'mate',
          'name': _computer,
          if (receivedAt != null) 'observation': {'receivedAt': receivedAt},
        },
      ],
      if (lead)
        'projects': [
          {
            'id': 'p',
            'name': 'Pilot',
            'ownerId': 'owner',
            'leadConversationId': 'pm',
          },
        ],
      'conversations': [
        if (lead)
          {
            'id': 'pm',
            'projectId': 'p',
            'title': 'Product Manager',
            'brief': 'Product Manager',
            'leadId': 'river',
            'agentIds': ['river'],
          },
      ],
      'invitations': const [],
    });
    final now = DateTime.utc(2026, 10, 23, 4, 11);
    String reason(SuperTabSnapshot s, String agentId) =>
        superTabTerminalUnavailable(
          snapshot: s,
          agent: s.agent(agentId)!,
          accountId: 'owner',
          machine: null,
          now: now,
        );

    test('names a teammate’s computer and account and what they can do, '
        'never that an online computer must be online', () {
      final text = reason(
        snapshot(
          receivedAt: now
              .subtract(const Duration(seconds: 4))
              .millisecondsSinceEpoch,
        ),
        'river',
      );
      expect(
        text,
        'River runs on $_computer, scholes’s computer. Its '
        'terminal is not shared with you yet: Harness there shares it with '
        'Swarm members once it is up to date and running. Ask '
        'scholes to update and restart Harness, then Retry.',
      );
      expect(text, isNot(contains('must be online')));
    });

    test('says a private session’s terminal is only its owner’s to watch, '
        'never that the owner must update Harness', () {
      final heard = now
          .subtract(const Duration(seconds: 4))
          .millisecondsSinceEpoch;
      // Every member watches the current Product Manager, view only (Ken, 2026-10-28), though the backend marks it
      // confidential: until its invitation arrives, its computer is the one to update.
      final pm = snapshot(receivedAt: heard, lead: true, confidential: true);
      expect(superTabTerminalPrivate(pm, pm.agent('river')!), isFalse);
      expect(
        reason(pm, 'river'),
        'River runs on $_computer, scholes’s computer. Its '
        'terminal is not shared with you yet: Harness there shares it with '
        'Swarm members once it is up to date and running. Ask '
        'scholes to update and restart Harness, then Retry.',
      );
      // Marked confidential by the backend: in a private chat, or a Product Manager before.
      final private = reason(
        snapshot(receivedAt: heard, confidential: true),
        'river',
      );
      expect(
        private,
        'River reads private chats, so only scholes can watch '
        'its terminal.',
      );
      // Its computer offline changes nothing: the terminal stays private once it is back.
      final silent = now
          .subtract(const Duration(minutes: 3))
          .millisecondsSinceEpoch;
      expect(
        reason(snapshot(receivedAt: silent, confidential: true), 'river'),
        private,
      );
    });

    test('says a teammate’s computer is offline only when the Swarm stopped '
        'hearing from it', () {
      final silent = now
          .subtract(const Duration(minutes: 3))
          .millisecondsSinceEpoch;
      expect(
        reason(snapshot(receivedAt: silent), 'river'),
        'River runs on $_computer, scholes’s computer, which is '
        'offline. Its terminal shows here once that computer is back.',
      );
      expect(reason(snapshot(), 'river'), contains('which is offline'));
    });

    test('keeps the original message for this account’s own computer and '
        'never shows an internal id for an unknown owner', () {
      expect(reason(snapshot(), 'mine'), superTabTerminalOffline);
      final unknown = reason(snapshot(ownerListed: false), 'river');
      expect(unknown, contains('its owner’s computer'));
      expect(unknown, isNot(contains('scholes')));
      expect(
        superTabTerminalUnavailable(
          snapshot: null,
          agent: snapshot().agent('river')!,
          accountId: 'owner',
          machine: null,
        ),
        superTabTerminalOffline,
      );
    });

    test(
      'reads a legacy agent without its machine owner as its contributor’s',
      () {
        final legacy = SuperTabAgent.fromJson({
          'id': 'old',
          'name': 'Builder',
          'machineId': 'm',
          'harnessId': 'h',
          'contributorId': 'owner',
          'configuration': const <String, dynamic>{},
        });
        expect(legacy.machineOwnerId, 'owner');
      },
    );
  });

  testWidgets(
    'a teammate’s agent without an invitation says why and how to fix it, '
    'and Retry shows its read-only terminal once the invitation arrives',
    (tester) async {
      final (f, api, c) = await _swarm();
      await _show(tester, f);
      c.selectTerminal('lead', 'river');
      await _settle(tester);
      await _shoot(tester, 'teammate-without-invitation');
      expect(find.textContaining('must be online'), findsNothing);
      expect(find.textContaining('scholes’s computer'), findsOneWidget);
      expect(find.text('Retry'), findsOneWidget);
      expect(find.byType(SharedHarnessPanel), findsNothing);

      api.list = [_own, _teammate(21)];
      await tester.tap(find.text('Retry'));
      await _settle(tester);
      expect(find.textContaining('not shared with you yet'), findsNothing);
      expect(find.byType(SharedHarnessPanel), findsOneWidget);
      final pane = f.app.panes.single;
      expect(pane.sharedHarness?.id, 'share-river');
      expect(pane.inputContext, isNull);
      // Read-only: no input grant was asked for on another account's computer.
      expect(
        f.connection.calls.where(
          (call) =>
              (call.$2['path'] as String?)?.endsWith('/native') == true ||
              call.$2['action'] == 'prepareNative',
        ),
        isEmpty,
      );
      await _close(tester, f, c);
    },
  );

  testWidgets(
    'a teammate’s private session says only its owner watches it, without '
    're-reading the machine list for an invitation that never comes',
    (tester) async {
      final (f, api, c) = await _swarm(confidential: true);
      await _show(tester, f);
      final reads = api.reads;
      c.selectTerminal('lead', 'river');
      await _settle(tester);
      expect(find.textContaining('only scholes can watch'), findsOneWidget);
      expect(find.textContaining('update and restart'), findsNothing);
      expect(find.byType(SharedHarnessPanel), findsNothing);
      expect(api.reads, reads);
      await _close(tester, f, c);
    },
  );

  testWidgets(
    'a teammate’s read-only terminal stays the same connection across '
    'machine-list refreshes, renewed invitations included',
    (tester) async {
      final (f, api, c) = await _swarm();
      api.list = [_own, _teammate(21)];
      await f.app.refreshMachines();
      await _show(tester, f);
      c.selectTerminal('lead', 'river');
      await _settle(tester);
      final panel = tester.state(find.byType(SharedHarnessPanel));
      final pane = f.app.panes.single;
      // The storm seen 2026-10-23: a machine list re-read about 1.5 times a second, each with a renewed invitation.
      for (var day = 22; day < 30; day++) {
        api.list = [_own, _teammate(day)];
        expect(await f.app.refreshMachines(), isTrue);
        await tester.pump(const Duration(milliseconds: 700));
      }
      await _settle(tester);
      expect(api.reads, greaterThanOrEqualTo(9));
      expect(tester.state(find.byType(SharedHarnessPanel)), same(panel));
      expect(f.app.panes.single, same(pane));
      expect(find.text('Retry'), findsNothing);
      await _close(tester, f, c);
    },
  );

  testWidgets(
    'this account’s own computer without the agent keeps its original message',
    (tester) async {
      final (f, _, c) = await _swarm();
      final state = f.connection.server.state;
      (state['agents'] as List).first
        ..['machineId'] = 'm'
        ..['harnessId'] = 'gone-native'
        ..['contributorId'] = 'owner'
        ..['machineOwnerId'] = 'owner';
      await c.refresh();
      await _show(tester, f);
      c.selectTerminal('lead', 'river');
      await _settle(tester);
      expect(find.text(superTabTerminalOffline), findsOneWidget);
      expect(find.text('Retry'), findsOneWidget);
      await _close(tester, f, c);
    },
  );
}
