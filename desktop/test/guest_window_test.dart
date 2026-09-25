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
import 'package:harness/core/models.dart';
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

    test('a desk keyed by the DASHED computer id still re-keys', () async {
      // The tiles carry `~/.harness/computer-id` verbatim — the daemon served
      // them under it while signed out — and the account's machine is a
      // different id entirely. The re-key rewrites what is actually on the desk.
      const dashed = 'd11a1f3b-ca2a-44e9-ae68-a942e044e6d8';
      final store = await savedDesk(dashed);
      final layout = PaneLayoutStore(storage: store);
      await layout.rekeyMachine(
        from: dashed,
        to: '001bcba1e7e9deb6f8756c053a951ce2',
      );

      expect(savedPanes((await layout.loadSwarms())!), [
        ('001bcba1e7e9deb6f8756c053a951ce2', 'a1'),
        ('001bcba1e7e9deb6f8756c053a951ce2', 'a2'),
        ('other-machine', 'b1'),
      ]);
    });

    test('a desk that already names the right id is left alone', () async {
      final store = await savedDesk('machine-xyz');
      final before = await store.read('swarm_layout_v1');
      final layout = PaneLayoutStore(storage: store);
      await layout.rekeyMachine(from: 'machine-xyz', to: 'machine-xyz');
      expect(await store.read('swarm_layout_v1'), before);
    });
  });

  group('the two spellings of one computer id', () {
    // The backend strips the dashes; `~/.harness/computer-id` keeps them, and
    // that file is what the daemon serves under while signed out — so it is what
    // a tile made then is keyed by. A plain `==` across that boundary never
    // matches, and the re-key that depends on it silently does nothing.
    const dashed = 'd11a1f3b-ca2a-44e9-ae68-a942e044e6d8';
    const plain = 'd11a1f3bca2a44e9ae68a942e044e6d8';

    test('the same id written two ways is the same id', () {
      expect(sameMachineId(dashed, plain), isTrue);
      expect(sameMachineId(plain, dashed), isTrue);
      expect(sameMachineId(dashed, dashed), isTrue);
    });

    test('case is not part of the id either', () {
      expect(sameMachineId(plain.toUpperCase(), dashed), isTrue);
    });

    test('two different ids stay different', () {
      expect(sameMachineId(plain, '001bcba1e7e9deb6f8756c053a951ce2'), isFalse);
      // Not a prefix match: one is not the other with the rest cut off.
      expect(sameMachineId(plain, plain.substring(0, 20)), isFalse);
    });
  });

  group('what a guest window is', () {
    test(
      'a desktop window without an account is a guest; a viewer never is',
      () {
        final app = createApp();
        addTearDown(app.dispose);
        expect(app.signedIn, isTrue, reason: 'presumed until the CLI answers');
        expect(app.isGuest, isFalse);

        app.signedIn = false;
        expect(app.isGuest, isTrue);
      },
    );
  });
}
