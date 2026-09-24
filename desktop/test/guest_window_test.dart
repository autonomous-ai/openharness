/// A window with no account.
///
/// The product used to refuse to show anything until this computer was signed
/// in, and the CLI refused to start its daemon at all — so a browser sign-in
/// stood in front of every local thing Harness does on day one: agents,
/// terminals, tabs, DSH, the cabled dial, all of which are served over the
/// loopback and need no backend. What an account adds is the OTHER machines,
/// the shared desk, voice on the dial and the profile, and those are asked for
/// at the moment they are reached for.
///
/// These pin the two halves that make that safe: the desk follows this
/// computer's id when the account changes hands, and nothing account-shaped is
/// asked for without one.
library;

import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/state/pane_layout_store.dart';

import 'swarm_state_test.dart' show MemoryStore, createApp;

void main() {
  group('the desk when the account changes hands', () {
    /// One saved desk: two tiles on this computer, one on another machine.
    Future<MemoryStore> savedDesk(String localId) async {
      final store = MemoryStore();
      await store.write(
        'swarm_layout_v1',
        jsonEncode({
          'version': 1,
          'activeId': 'swarm-1',
          'swarms': [
            {
              'id': 'swarm-1',
              'panes': [
                {'machineId': localId, 'agentId': 'a1'},
                {'machineId': localId, 'agentId': 'a2'},
                {'machineId': 'other-machine', 'agentId': 'b1'},
              ],
            },
          ],
        }),
      );
      return store;
    }

    List<(String, String)> savedPanes(Map<String, dynamic> raw) => [
      for (final swarm in raw['swarms'] as List)
        for (final pane in (swarm as Map)['panes'] as List)
          ((pane as Map)['machineId'] as String, pane['agentId'] as String),
    ];

    test('a sign-in re-keys this computer and keeps the other machines', () async {
      // The daemon serves this computer under the COMPUTER id while signed out
      // and under the account's machineId after — `harness login` restarts it on
      // the other one. The tiles are intent about this computer either way.
      final store = await savedDesk('computer-abc');
      final layout = PaneLayoutStore(storage: store);
      await layout.rekeyMachine(from: 'computer-abc', to: 'machine-xyz');

      expect(savedPanes((await layout.loadSwarms())!), [
        ('machine-xyz', 'a1'),
        ('machine-xyz', 'a2'),
        ('other-machine', 'b1'),
      ]);
    });

    test('a sign-out re-keys this computer and drops the others', () async {
      // A guest has no machine to attach a remote tile to, and a tile waiting
      // forever reads as broken rather than as signed out.
      final store = await savedDesk('machine-xyz');
      final layout = PaneLayoutStore(storage: store);
      await layout.rekeyMachine(
        from: 'machine-xyz',
        to: 'computer-abc',
        dropOthers: true,
      );

      expect(savedPanes((await layout.loadSwarms())!), [
        ('computer-abc', 'a1'),
        ('computer-abc', 'a2'),
      ]);
    });

    test('the id is remembered, so a sign-out in a terminal is caught later', () async {
      // `harness logout` while the app is CLOSED cannot re-key anything. The next
      // launch compares what it remembered against what the daemon now serves.
      final store = MemoryStore();
      final layout = PaneLayoutStore(storage: store);
      expect(await layout.loadLocalMachineId(), isNull);
      await layout.saveLocalMachineId('machine-xyz');
      expect(await layout.loadLocalMachineId(), 'machine-xyz');
    });

    test('a desk that already names the right id is left alone', () async {
      final store = await savedDesk('machine-xyz');
      final before = await store.read('swarm_layout_v1');
      final layout = PaneLayoutStore(storage: store);
      await layout.rekeyMachine(from: 'machine-xyz', to: 'machine-xyz');
      expect(await store.read('swarm_layout_v1'), before);
    });
  });

  group('what a guest window is', () {
    test('a desktop window without an account is a guest; a viewer never is', () {
      final app = createApp();
      addTearDown(app.dispose);
      expect(app.signedIn, isTrue, reason: 'presumed until the CLI answers');
      expect(app.isGuest, isFalse);

      app.signedIn = false;
      expect(app.isGuest, isTrue);
    });
  });
}
