import 'dart:async';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/local_key_value_store.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/settings/config_store.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/state/desk_sync.dart';
import 'package:harness_mobile/terminal/terminal_session.dart';

import 'viewer_app_fixture.dart';
import 'voice_fakes.dart' show MemoryKeyValueStore;

/// The rest of what a phone asks of `AppNotifier`: the link prompt, the tabs
/// of the account's desk, the saved settings read at launch, and the timers
/// that keep a machine's list honest while nobody is looking.
void main() {
  group('the link prompt', () {
    test('waved away and asked for again, each said once', () async {
      final rig = await signedInWith({
        'm': ['a'],
      });
      addTearDown(rig.app.dispose);
      var redraws = 0;
      rig.app.addListener(() => redraws++);

      rig.app.dismissLinkPrompt('m');
      rig.app.dismissLinkPrompt('m');
      expect(rig.app.isLinkPromptDismissed('m'), isTrue);
      expect(redraws, 1);

      rig.app.revisitLinkPrompt('m');
      rig.app.revisitLinkPrompt('m');
      expect(rig.app.isLinkPromptDismissed('m'), isFalse);
      expect(redraws, 2);
    });

    test('opening an agent on the machine is asking to see it', () async {
      final rig = await signedInWith({
        'm': ['a'],
      });
      addTearDown(rig.app.dispose);
      rig.app.dismissLinkPrompt('m');

      await openAgent(rig, 'm', 'a');

      expect(rig.app.isLinkPromptDismissed('m'), isFalse);
    });
  });

  group('the account\'s tabs', () {
    DeskTab tab(String id, String name, List<String> agentIds) => DeskTab(
      id: id,
      name: name,
      nameIsCustom: true,
      panes: [
        for (final agentId in agentIds)
          DeskPaneRef(machineId: 'm', agentId: agentId),
      ],
    );

    Future<ViewerRig> withDesk(List<DeskTab> tabs) async {
      final rig = viewerApp();
      rig.api.deskTabs = tabs;
      rig.api.onMachines = () async => [remoteMachine('m')];
      rig.conn('m').answers['agents_list'] = (_) => {
        'agents': [agentJson('a'), agentJson('b')],
      };
      rig.conn('m').answers['terminal_capabilities'] = (_) => capabilities();
      await rig.app.bootstrap();
      await rig.app.deskSyncForTest();
      // Out of the pocket poll's way: a test is nobody holding the phone.
      rig.app.handleAppPaused();
      await settle();
      return rig;
    }

    test('are read at sign-in, and written back from the tabs panel', () async {
      final rig = await withDesk([
        tab('t1', 'Work', ['a']),
      ]);
      addTearDown(rig.app.dispose);

      expect(rig.app.deskSettled, isTrue);
      expect(rig.app.deskWritable, isTrue);
      expect(rig.app.deskTabs.single.name, 'Work');

      rig.app.addAgentToDeskTab('t1', (machineId: 'm', agentId: 'b'));
      rig.app.renameDeskTab('t1', '  Deep work ');
      final made = rig.app.createDeskTabFor((machineId: 'm', agentId: 'a'));
      await settle();

      expect(rig.api.deskWrites.map((op) => op['op']), [
        'pane.add',
        'tab.rename',
        'tab.create',
        'pane.add',
      ]);
      expect(made, isNotNull);
      expect(rig.app.activeDeskTabId, made);
      expect(rig.api.deskTabs!.first.name, 'Deep work');
    });

    test('an agent made on the phone joins the tab it is in', () async {
      final rig = await withDesk([
        tab('t1', 'Work', ['a']),
      ]);
      addTearDown(rig.app.dispose);
      rig.app.selectDeskTab('t1');
      rig.conn('m').answers['agent_create'] = (p) => {
        'creationId': p['creationId'],
        'state': 'created',
        'agent': agentJson('new'),
      };

      final creating = rig.app.createAgent(
        'm',
        engine: 'claude',
        folder: '/work',
      );
      await settle();
      rig.app.paneOfAgent('m', 'new')?.session?.reportViewport(80, 24);
      await creating;
      await settle();

      expect(rig.api.deskTabs!.single.panes.map((p) => p.agentId), [
        'a',
        'new',
      ]);
    });

    test(
      'or a tab of its own, when the + on the tab row asked for one',
      () async {
        final rig = await withDesk([
          tab('t1', 'Work', ['a']),
        ]);
        addTearDown(rig.app.dispose);
        rig.app.noteDeskTab('t1');
        rig.app.openNextAgentInNewDeskTab();
        rig.conn('m').answers['agent_create'] = (p) => {
          'creationId': p['creationId'],
          'state': 'created',
          'agent': agentJson('new', name: 'Fix login'),
        };

        final creating = rig.app.createAgent(
          'm',
          engine: 'claude',
          folder: '/work',
        );
        await settle();
        rig.app.paneOfAgent('m', 'new')?.session?.reportViewport(80, 24);
        await creating;
        await settle();

        expect(rig.api.deskTabs!.map((t) => t.name), ['Work', 'Fix login']);
      },
    );

    test('a form closed without making anything forgets the new tab', () async {
      final rig = await withDesk([
        tab('t1', 'Work', ['a']),
      ]);
      addTearDown(rig.app.dispose);
      rig.app.selectDeskTab('t1');
      rig.app.openNextAgentInNewDeskTab();
      rig.app.forgetNewDeskTabIntent();
      rig.conn('m').answers['agent_create'] = (p) => {
        'creationId': p['creationId'],
        'state': 'created',
        'agent': agentJson('new'),
      };

      final creating = rig.app.createAgent(
        'm',
        engine: 'claude',
        folder: '/work',
      );
      await settle();
      rig.app.paneOfAgent('m', 'new')?.session?.reportViewport(80, 24);
      await creating;
      await settle();

      expect(rig.api.deskTabs, hasLength(1));
    });

    test(
      'an agent stopped on the phone leaves every tab that held it',
      () async {
        final rig = await withDesk([
          tab('t1', 'Work', ['a']),
          tab('t2', 'Also', ['a', 'b']),
        ]);
        addTearDown(rig.app.dispose);

        expect(await rig.app.deleteAgent('m', 'a'), isNull);
        await settle();

        expect(
          rig.api.deskTabs!.map((t) => [for (final p in t.panes) p.agentId]),
          [
            <String>[],
            ['b'],
          ],
        );
      },
    );

    test('a change elsewhere is read when a machine says so', () async {
      final rig = await withDesk([
        tab('t1', 'Work', ['a']),
      ]);
      addTearDown(rig.app.dispose);
      rig.api.deskTabs = [
        tab('t1', 'Renamed on the Mac', ['a']),
      ];
      rig.api.deskRevision = 5;

      await push(rig, 'm', 'desk_changed', {'revision': 5});
      await settle();

      expect(rig.app.deskTabs.single.name, 'Renamed on the Mac');
    });

    test('coming back to the app reads them again', () async {
      final rig = await withDesk([
        tab('t1', 'Work', ['a']),
      ]);
      addTearDown(rig.app.dispose);
      rig.api.deskTabs = [
        tab('t1', 'Changed meanwhile', ['a']),
      ];
      rig.api.deskRevision = 9;

      rig.app.handleAppResumed();
      await settle();
      rig.app.handleAppPaused();

      expect(rig.app.deskTabs.single.name, 'Changed meanwhile');
    });
  });

  group('the settings read at launch', () {
    test('are read before the sign-in is asked about', () async {
      final storage = MemoryKeyValueStore()
        ..values['app_autonomous_environment'] = 'stag';
      final rig = viewerApp(signedIn: false);
      final app = AppNotifier(
        config: rig.app.config,
        authSession: rig.app.session,
        configStore: ConfigStore(storage: storage),
        cliLogin: rig.signIn,
        peerLinks: rig.links,
        viewer: rig.viewer,
        connectionForTest: (id) => rig.conn(id),
      );
      addTearDown(app.dispose);
      rig.app.dispose();

      await app.bootstrap();

      expect(app.status, AppStatus.unauthenticated);
      expect(
        app.autonomousEnv,
        'prod',
        reason: 'a stale staging choice must not come back',
      );
    });

    test(
      'a settings file that cannot be read falls back to the defaults',
      () async {
        final rig = viewerApp(signedIn: false);
        final app = AppNotifier(
          config: rig.app.config,
          authSession: rig.app.session,
          configStore: ConfigStore(storage: _Unreadable()),
          cliLogin: rig.signIn,
          peerLinks: rig.links,
          viewer: rig.viewer,
          connectionForTest: (id) => rig.conn(id),
        );
        addTearDown(app.dispose);
        rig.app.dispose();

        await app.bootstrap();

        expect(app.status, AppStatus.unauthenticated);
        expect(app.config.apiBaseUrl, ConfigStore.defaultBaseUrl);
      },
    );
  });

  group('the account and the machines, late', () {
    test('a profile that answers after sign-out is not taken', () async {
      final rig = viewerApp();
      addTearDown(rig.app.dispose);
      final profile = Completer<Map<String, dynamic>?>();
      rig.api.onProfile = () => profile.future;

      await rig.app.bootstrap();
      await rig.app.logout();
      profile.complete({
        'user': {'id': 'u1', 'email': 'late@example.com'},
      });
      await settle();

      expect(rig.app.currentUser, isNull);
    });

    test('a profile that cannot be read leaves the app signed in', () async {
      final rig = viewerApp();
      addTearDown(rig.app.dispose);
      rig.api.onProfile = () async => throw StateError('503');

      await rig.app.bootstrap();
      await settle();

      expect(rig.app.status, AppStatus.authenticated);
      expect(rig.app.currentUser, isNull);
    });

    test(
      'capabilities that land after the list still attach the page waiting',
      () async {
        final rig = await signedInWith({
          'm': ['a'],
        });
        addTearDown(rig.app.dispose);
        final caps = Completer<Map<String, dynamic>>();
        rig.conn('m').answers['terminal_capabilities'] = (_) => caps.future;
        rig.app.stateOf('m')!.terminalCapabilityAvailable = false;
        await rig.app.selectAgent('m', 'a');
        expect(rig.app.paneOfAgent('m', 'a')!.session, isNull);

        rig.app.connectionStatusForTest('m', ConnectionStatus.connected);
        await settle();
        caps.complete(capabilities());
        await settle();

        expect(rig.app.paneOfAgent('m', 'a')!.session, isNotNull);
      },
    );

    test('capabilities that land after sign-out change nothing', () async {
      final rig = await signedInWith({
        'm': ['a'],
      });
      addTearDown(rig.app.dispose);
      final caps = Completer<Map<String, dynamic>>();
      rig.conn('m').answers['terminal_capabilities'] = (_) => caps.future;
      final machine = rig.app.stateOf('m')!;
      final load = rig.app.reloadMachineData('m');
      await settle();

      await rig.app.logout();
      caps.complete({...capabilities(), 'available': false});
      await load;

      expect(machine.terminalCapabilityAvailable, isTrue);
    });

    test('a list without an agent lets go of what was waiting on it', () async {
      final rig = await signedInWith({
        'm': ['a', 'b'],
      });
      addTearDown(rig.app.dispose);
      await push(rig, 'm', 'turn_started', {'agentId': 'b'});
      final machine = rig.app.stateOf('m')!
        ..pendingOfflineAgentId = 'b'
        ..activeAgentId = 'b';
      rig.conn('m').answers['agents_list'] = (_) => {
        'agents': [agentJson('a')],
      };

      await rig.app.reloadMachineData('m');

      expect(rig.app.agentIsProcessing('m', 'b'), isFalse);
      expect(machine.pendingOfflineAgentId, isNull);
      expect(machine.activeAgentId, isNull);
    });

    test(
      'an agent deleted while the phone waited for it is not waited for',
      () async {
        final rig = await signedInWith({
          'm': ['a'],
        });
        addTearDown(rig.app.dispose);
        rig.app.stateOf('m')!.pendingOfflineAgentId = 'a';

        await push(rig, 'm', 'agent_deleted', {'agentId': 'a'});

        expect(rig.app.stateOf('m')!.pendingOfflineAgentId, isNull);
      },
    );

    test('a frame from an agent\'s previous session is not searched', () async {
      final rig = await signedInWith({'m': []});
      addTearDown(rig.app.dispose);
      await push(rig, 'm', 'agent_synced', {
        'agent': agentJson('a', sessionId: 's-now'),
      });
      final agent = rig.app.stateOf('m')!.agents.single;

      await push(rig, 'm', 'user_message', {
        'agentId': 'a',
        'sessionId': 's-before-clear',
        'content': 'old words',
      });
      expect(
        rig.app.sessionPreviews
            .read(rig.app.previewKey('m', agent))
            ?.latestRequest,
        isNull,
      );

      await push(rig, 'm', 'user_message', {
        'agentId': 'a',
        'sessionId': 's-now',
        'content': 'new words',
      });
      expect(
        rig.app.sessionPreviews
            .read(rig.app.previewKey('m', agent))
            ?.latestRequest,
        'new words',
      );
    });

    test('a second turn after the first leaves the agent processing', () async {
      final rig = await signedInWith({
        'm': ['a'],
      });
      addTearDown(rig.app.dispose);

      await push(rig, 'm', 'turn_started', {'agentId': 'a'});
      await push(rig, 'm', 'turn_ended', {'agentId': 'a'});
      await push(rig, 'm', 'turn_started', {'agentId': 'a'});

      expect(rig.app.agentIsProcessing('m', 'a'), isTrue);
    });
  });

  group('recovery that finds the person elsewhere', () {
    test('the agent comes back, but the phone does not move to it', () async {
      final rig = await signedInWith({
        'm': ['a'],
        'n': ['b'],
      });
      addTearDown(rig.app.dispose);
      final a = await openAgent(rig, 'm', 'a');
      await push(rig, 'm', 'node_status', {'online': false});
      await openAgent(rig, 'n', 'b');
      expect(rig.app.selectedMachineId, 'n');
      final opens = rig.conn('m').opens.length;

      // A machine whose pages cannot be reopened politely: only recovery could.
      rig.conn('m').answers['terminal_capabilities'] = (_) =>
          capabilities(noTakeover: false);
      await push(rig, 'm', 'node_status', {'online': true});
      await settle();

      expect(rig.app.stateOf('m')!.pendingOfflineAgentId, isNull);
      expect(rig.conn('m').opens.length, opens);
      expect(a.status, TerminalSessionStatus.error);
      expect(rig.app.selectedMachineId, 'n');
    });

    test('a socket still coming up is waited for, not asked through', () async {
      final rig = await signedInWith({
        'm': ['a'],
      });
      addTearDown(rig.app.dispose);
      await openAgent(rig, 'm', 'a');
      await push(rig, 'm', 'node_status', {'online': false});
      rig.conn('m').ready = false;
      final lists = rig.conn('m').payloadsOf('agents_list').length;

      await push(rig, 'm', 'node_status', {'online': true});
      await Future<void>.delayed(const Duration(milliseconds: 300));
      expect(rig.conn('m').payloadsOf('agents_list'), hasLength(lists));

      rig.conn('m').ready = true;
      await Future<void>.delayed(const Duration(milliseconds: 300));
      expect(
        rig.conn('m').payloadsOf('agents_list').length,
        greaterThan(lists),
      );
      expect(rig.app.stateOf('m')!.pendingOfflineAgentId, isNull);
    });
  });

  group('the timers', () {
    test(
      'an offline machine something waits on is asked about every few seconds',
      () {
        fakeAsync((async) {
          final rig = viewerApp();
          rig.api.onMachines = () async => [remoteMachine('m')];
          rig.conn('m').answers['agents_list'] = (_) => {
            'agents': [agentJson('a')],
          };
          rig.conn('m').answers['terminal_capabilities'] = (_) =>
              capabilities();
          rig.app.bootstrap();
          async.flushMicrotasks();
          rig.app.handleAppPaused();
          rig.app.stateOf('m')!.pendingOfflineAgentId = 'a';
          rig.api.onMachines = () async => [
            remoteMachine('m', status: 'offline'),
          ];
          rig.app.handleEventForTest('m', {
            'type': 'node_status',
            'payload': {'online': false},
          });
          async.flushMicrotasks();
          final fetches = rig.api.machineFetches;

          async.elapse(AppNotifier.offlineRetryInterval * 2);
          expect(rig.api.machineFetches, fetches + 2);

          rig.api.onMachines = () async => [
            remoteMachine('m', status: 'online'),
          ];
          async.elapse(AppNotifier.offlineRetryInterval);
          expect(rig.app.stateOf('m')!.nodeOnline, isTrue);
          final settled = rig.api.machineFetches;
          async.elapse(AppNotifier.offlineRetryInterval * 2);
          expect(
            rig.api.machineFetches,
            settled,
            reason: 'online: polling stops',
          );

          rig.app.dispose();
        });
      },
    );

    test(
      'an offline poll that fails, or finds nothing to act on, is quiet',
      () async {
        final rig = await signedInWith({
          'm': ['a'],
        });
        addTearDown(rig.app.dispose);
        await openAgent(rig, 'm', 'a');
        await push(rig, 'm', 'node_status', {'online': false});

        rig.api.onMachines = () async => throw StateError('no network');
        await rig.app.retryOfflineMachine('m');
        rig.api.onMachines = () async => const [];
        await rig.app.retryOfflineMachine('m');
        rig.api.onMachines = () async => [remoteMachine('m', status: 'weird')];
        await rig.app.retryOfflineMachine('m');
        await rig.app.retryOfflineMachine('ghost');

        expect(rig.app.stateOf('m')!.nodeOnline, isFalse);
      },
    );

    test('a connected machine\'s list is re-read every minute, and not once it goes', () {
      fakeAsync((async) {
        final rig = viewerApp();
        rig.api.onMachines = () async => [remoteMachine('m')];
        rig.app.bootstrap();
        async.flushMicrotasks();
        rig.app.handleAppPaused();
        rig.app.connectionStatusForTest('m', ConnectionStatus.connected);
        async.flushMicrotasks();
        final lists = rig.conn('m').payloadsOf('agents_list').length;

        async.elapse(AppNotifier.agentSyncInterval);
        expect(rig.conn('m').payloadsOf('agents_list'), hasLength(lists + 1));

        rig.api.onMachines = () async => const [];
        rig.app.refreshMachines();
        async.flushMicrotasks();
        async.elapse(AppNotifier.agentSyncInterval * 2);
        expect(rig.conn('m').payloadsOf('agents_list'), hasLength(lists + 1));

        rig.app.dispose();
      });
    });
  });

  test('closing the app mid sign-in lets go of the sign-in', () async {
    final rig = viewerApp(signedIn: false);
    final gate = rig.viewer.emailLogin.gate = Completer<void>();

    final signingIn = rig.app.signInWithCode(email: 'a@b.co', code: '1');
    await settle();
    rig.app.dispose();
    gate.complete();
    await signingIn;

    // The code's answer lands on an app that is gone: nothing is fetched for
    // it, and nothing tells a disposed notifier's listeners (which throws).
    expect(rig.api.machineFetches, 0);
  });
}

class _Unreadable implements LocalKeyValueStore {
  @override
  Future<String?> read(String key) async => throw StateError('locked');

  @override
  Future<void> write(String key, String value) async =>
      throw StateError('locked');

  @override
  Future<void> delete(String key) async => throw StateError('locked');
}
