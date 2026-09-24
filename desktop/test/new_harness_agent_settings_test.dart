import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/engine_availability.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/widgets/new_harness_form.dart';
import 'package:harness/ws/ws_conn.dart';

import 'keymap_host_test.dart' show MemoryKeymap, key;
import 'keymap_runtime_test.dart' as configured;
import 'support/launch_menu.dart';
import 'support/mixed_agents.dart';
import 'swarm_screen_test.dart' show terminal;
import 'swarm_state_test.dart' show createApp;

class _Profiles extends WsConn {
  _Profiles(String machine)
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: machine,
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );
  final creates = <Map<String, dynamic>>[];
  final links = <String>[];
  int lists = 0;
  bool failProfiles = false;
  bool supportsProfiles = true;
  Completer<Map<String, dynamic>>? pendingProfiles;
  Completer<Map<String, dynamic>>? pendingLink;

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    switch (type) {
      case 'engines_probe':
        return {
          'engines': [
            {
              'engine': 'codex',
              'installed': true,
              'supportsCodexHome': supportsProfiles,
            },
            {'engine': 'claude', 'installed': true},
          ],
        };
      case 'dsh_list':
        return {'dsh': []};
      case 'fs_list_dir':
        return {'path': '/home/$machineId', 'entries': []};
      case 'codex_profiles_list':
        lists++;
        if (pendingProfiles != null) return pendingProfiles!.future;
        return failProfiles
            ? {'error': 'UNREACHABLE'}
            : {
                'profiles': [
                  {'path': '/profiles/$machineId/work', 'label': 'Work'},
                  {
                    'path': '/profiles/$machineId/personal',
                    'label': 'Personal',
                  },
                ],
              };
      case 'codex_profile_link':
        links.add(payload['path'] as String);
        return pendingLink?.future ??
            Future.value({
              'profile': {'path': payload['path'], 'label': 'Linked'},
            });
      case 'agent_create':
        creates.add(Map.of(payload));
        return {
          'creationId': payload['creationId'],
          'state': 'created',
          'agent': {
            'id': 'made',
            'name': 'Made',
            'engine': payload['engine'],
            'terminalAvailable': true,
          },
        };
      default:
        return {};
    }
  }
}

void main() {
  setUp(() => newHarnessOpensInBox = true);
  tearDown(() => newHarnessOpensInBox = false);

  void setting(NewHarnessController box, String id) {
    if (id == NewHarnessController.permissionsId ||
        id == NewHarnessController.profileId) {
      box.openAgentSetting(box.selected!.engine!, id);
    } else {
      box.accept(box.options.singleWhere((row) => row.id == id));
    }
  }

  testWidgets('setup launches with the chosen profile and approvals', (
    tester,
  ) async {
    final connection = _Profiles('m');
    final app = createApp(connectionForTest: (_) => connection);
    seedMixedAgents(app);
    addTearDown(app.dispose);
    final map = MemoryKeymap();
    addTearDown(map.dispose);
    app.adoptSessionForTest(terminal('a0', []));
    await configured.mount(tester, app, map);
    await key(tester, LogicalKeyboardKey.keyN, cmd: true);
    final box = tester
        .widget<NewHarnessForm>(find.byType(NewHarnessForm))
        .controller;
    await openLaunchRow(tester, 'approvals');
    await typeHarnessQuery(tester, 'read only');
    await key(tester, LogicalKeyboardKey.enter);
    expect(box.mode, 'readOnly');
    await openLaunchRow(tester, 'profile');
    await tester.pump(const Duration(milliseconds: 200));
    expect(connection.lists, greaterThanOrEqualTo(1));
    expect(box.draft.profile, isNull);
    await typeHarnessQuery(tester, 'Work');
    await key(tester, LogicalKeyboardKey.enter);
    expect(box.draft.profile!.path, '/profiles/m/work');
    expect(connection.creates, isEmpty);
    await startHarness(tester);
    expect(connection.creates.single['codexHome'], '/profiles/m/work');
    expect(connection.creates.single['permissionMode'], 'readOnly');
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(milliseconds: 200));
  });

  testWidgets('profile discovery ignores replies from the previous machine', (
    tester,
  ) async {
    final local = _Profiles('m')..pendingProfiles = Completer();
    final remote = _Profiles('studio');
    final app = createApp(
      connectionForTest: (id) => id == 'm' ? local : remote,
    );
    seedMixedAgents(app);
    addTearDown(app.dispose);
    final box = NewHarnessController(
      app,
      machineId: 'm',
      engine: 'codex',
      folder: '/work/local',
    );
    addTearDown(box.dispose);
    await tester.pump(const Duration(milliseconds: 200));
    box.focusField(NewHarnessField.agent);
    box.setQuery('codex');
    setting(box, NewHarnessController.profileId);
    await tester.pump();
    expect(box.loadingProfiles, isTrue);
    box.back();
    expect(box.query, 'codex');
    box.back();
    box.focusField(NewHarnessField.machine);
    box.setQuery('Office');
    box.accept();
    await tester.pump(const Duration(milliseconds: 200));
    box.focusField(NewHarnessField.agent);
    setting(box, NewHarnessController.profileId);
    await tester.pump();
    expect(
      box.options
          .where((row) => row.profile != null)
          .every((row) => row.machineId == 'studio'),
      isTrue,
    );
    final stale = local.pendingProfiles!;
    local.pendingProfiles = null;
    stale.complete({
      'profiles': [
        {'path': '/profiles/m/private', 'label': 'Private'},
      ],
    });
    await tester.pump();
    expect(box.machineId, 'studio');
    expect(box.options.any((row) => row.title == 'Private'), isFalse);
    expect(box.draft.profile, isNull);
    box.setQuery('Work');
    box.accept();
    expect(box.draft.profile!.path, '/profiles/studio/work');
    box.back();
    box.focusField(NewHarnessField.machine);
    box.setQuery('M2');
    box.accept();
    expect(box.draft.profile, isNull);
    expect(box.project.folder, '/work/local');
    await tester.pump(const Duration(milliseconds: 200));
  });

  testWidgets(
    'profiles can retry, link a folder, and restore default without creating',
    (tester) async {
      final connection = _Profiles('m')..failProfiles = true;
      final app = createApp(connectionForTest: (_) => connection);
      seedMixedAgents(app);
      addTearDown(app.dispose);
      final box = NewHarnessController(
        app,
        machineId: 'm',
        engine: 'codex',
        folder: '/work/local',
      );
      addTearDown(box.dispose);
      await tester.pump(const Duration(milliseconds: 200));
      box.focusField(NewHarnessField.agent);
      setting(box, NewHarnessController.profileId);
      await tester.pump();
      expect(box.error, contains('Refresh profiles'));
      connection.failProfiles = false;
      setting(box, NewHarnessController.refreshProfilesId);
      await tester.pump();
      expect(box.error, isNull);
      expect(connection.lists, 2);
      connection.pendingLink = Completer();
      final link = box.linkProfile('/profiles/m/linked');
      expect(box.linkingProfile, isTrue);
      expect(box.requestDismiss(), isFalse);
      expect(await box.createNow(), NewHarnessOutcome.failed);
      expect(connection.creates, isEmpty);
      connection.pendingLink!.complete({
        'profile': {'path': '/profiles/m/linked', 'label': 'Linked'},
      });
      await link;
      expect(connection.links, ['/profiles/m/linked']);
      expect(box.field, NewHarnessField.agent);
      expect(box.draft.profile!.path, '/profiles/m/linked');
      box.setQuery('Claude');
      expect(box.agentSettingsFor('claude'), hasLength(1));
      expect(box.engine, 'codex');
      box.back();
      expect(box.draft.profile!.path, '/profiles/m/linked');
      box.focusField(NewHarnessField.agent);
      setting(box, NewHarnessController.profileId);
      setting(box, NewHarnessController.defaultProfileId);
      expect(box.draft.profile, isNull);
      expect(box.draft.profileChosen, isTrue);
      box.setQuery('claude');
      box.accept();
      box.focusField(NewHarnessField.agent);
      expect(
        box.options.any((row) => row.id == NewHarnessController.profileId),
        isFalse,
      );
      box.setQuery('Terminal');
      box.accept();
      box.focusField(NewHarnessField.agent);
      expect(box.agentSettingsFor('terminal'), isEmpty);
      expect(connection.creates, isEmpty);
    },
  );

  testWidgets(
    'an older machine offers the default profile and explains support',
    (tester) async {
      final connection = _Profiles('m')..supportsProfiles = false;
      final app = createApp(connectionForTest: (_) => connection);
      seedMixedAgents(app);
      addTearDown(app.dispose);
      final box = NewHarnessController(
        app,
        machineId: 'm',
        engine: 'codex',
        folder: '/work/local',
      );
      addTearDown(box.dispose);
      await tester.pump(const Duration(milliseconds: 200));
      box.focusField(NewHarnessField.agent);
      setting(box, NewHarnessController.profileId);
      expect(box.profileHelp, contains('Update Harness CLI on M2'));
      expect(box.options.single.id, NewHarnessController.defaultProfileId);
      expect(connection.lists, 0);
      // A later capability response refreshes the open picker automatically.
      app.machineStates['m']!.engines.replace(const [
        EngineAvailability(
          engine: 'codex',
          installed: true,
          supportsCodexHome: true,
        ),
      ]);
      app.notifyListeners();
      await tester.pump(const Duration(milliseconds: 200));
      expect(connection.lists, 1);
      expect(box.profileHelp, isNull);
    },
  );
}
