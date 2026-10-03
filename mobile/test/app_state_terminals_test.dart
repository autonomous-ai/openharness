import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/terminal/terminal_binary.dart';
import 'package:harness_mobile/terminal/terminal_session.dart';

import 'viewer_app_fixture.dart';
import 'voice_fakes.dart' show MemoryKeyValueStore;

/// The terminals a phone holds open: the one a person opened, the ones the
/// pager opened ahead of the thumb, and what happens to each when the machine,
/// the stream or the person does something.
void main() {
  List<Map<String, dynamic>> opensFor(ViewerRig rig, String agentId) => [
    for (final open in rig.conn('m').opens)
      if (open['agentId'] == agentId) open,
  ];

  /// Everything on [session]'s screen, as text.
  String screenOf(TerminalSession session) {
    final lines = session.terminal.buffer.lines;
    return [
      for (var i = 0; i < lines.length; i++) lines[i].toString().trimRight(),
    ].join('\n');
  }

  /// The pager warming [agentId] on `m`, its parked page measuring itself.
  Future<void> warm(ViewerRig rig, String agentId) async {
    final warming = rig.app.warmAgentPane('m', agentId);
    await settle();
    rig.app.paneOfAgent('m', agentId)?.session?.reportViewport(80, 24);
    await warming;
  }

  group('opening an agent', () {
    test('takes its terminal, says who is asking, and selects it', () async {
      final rig = await signedInWith({
        'm': ['a', 'b'],
      });
      addTearDown(rig.app.dispose);

      final session = await openAgent(rig, 'm', 'a');

      final open = opensFor(rig, 'a').single;
      expect(open.containsKey('takeover'), isFalse, reason: 'absent is take');
      expect((open['client'] as Map)['kind'], 'phone');
      expect(open['cols'], 80);
      expect(session.status, TerminalSessionStatus.controlling);
      expect(rig.app.stateOf('m')!.activeAgentId, 'a');
      expect(rig.app.selectedMachineId, 'm');
      expect(rig.app.focusedPane?.agentId, 'a');
    });

    test('an agent already live is only focused, not opened again', () async {
      final rig = await signedInWith({
        'm': ['a', 'b'],
      });
      addTearDown(rig.app.dispose);
      await openAgent(rig, 'm', 'a');
      await openAgent(rig, 'm', 'b');

      await rig.app.selectAgent('m', 'a');

      expect(opensFor(rig, 'a'), hasLength(1));
      expect(rig.app.focusedPane?.agentId, 'a');
    });

    test(
      'an agent taken by another app is asked for again on arrival',
      () async {
        final rig = await signedInWith({
          'm': ['a'],
        });
        addTearDown(rig.app.dispose);
        final session = await openAgent(rig, 'm', 'a');
        await push(rig, 'm', 'terminal_closed', {
          'streamId': session.streamId,
          'code': 'TERMINAL_TAKEN_OVER',
          'takenBy': {'kind': 'desktop', 'name': 'MacBook Pro'},
        });
        expect(session.status, TerminalSessionStatus.takenOver);
        expect(session.errorMessage, 'MacBook Pro connected to this terminal.');

        await rig.app.selectAgent('m', 'a');

        expect(opensFor(rig, 'a'), hasLength(2));
        expect(opensFor(rig, 'a').last.containsKey('takeover'), isFalse);
      },
    );

    test(
      'a watcher promoted by a person reopens to take the keyboard',
      () async {
        final rig = await signedInWith({
          'm': ['a'],
        });
        addTearDown(rig.app.dispose);
        await warm(rig, 'a');
        final session = rig.app.paneOfAgent('m', 'a')!.session!;
        await settle();
        await push(rig, 'm', 'terminal_ready', {
          'requestId': opensFor(rig, 'a').single['requestId'],
          'agentId': 'a',
          'protocolVersion': TerminalSession.protocolVersion,
          'streamId': newStreamId(),
          'readOnly': true,
          'heldBy': {'kind': 'desktop', 'name': 'Studio'},
        });
        expect(session.watching, isTrue);
        expect(session.heldBy?.name, 'Studio');
        expect(session.acceptsInput, isFalse);

        await rig.app.selectAgent('m', 'a');

        expect(opensFor(rig, 'a'), hasLength(2));
        expect(opensFor(rig, 'a').last.containsKey('takeover'), isFalse);
        expect(rig.app.paneOfAgent('m', 'a')!.warm, isFalse);
      },
    );

    test('a dead stream is reopened in place, keeping its screen', () async {
      final rig = await signedInWith({
        'm': ['a'],
      });
      addTearDown(rig.app.dispose);
      final session = await openAgent(rig, 'm', 'a');
      session.transportLost('gone');

      await rig.app.selectAgent('m', 'a');

      expect(opensFor(rig, 'a'), hasLength(2));
      expect(
        identical(rig.app.paneOfAgent('m', 'a')!.session, session),
        isTrue,
      );
      expect(session.status, TerminalSessionStatus.opening);
    });

    test('on a machine that is off, the page waits and remembers it', () async {
      final rig = await signedInWith({
        'm': ['a'],
      });
      addTearDown(rig.app.dispose);
      await push(rig, 'm', 'node_status', {'online': false});

      await rig.app.selectAgent('m', 'a');

      expect(rig.app.paneOfAgent('m', 'a'), isNotNull);
      expect(rig.app.paneOfAgent('m', 'a')!.session, isNull);
      expect(rig.app.stateOf('m')!.pendingOfflineAgentId, 'a');
      expect(opensFor(rig, 'a'), isEmpty);
    });

    test('on a machine with no terminal protocol, nothing is opened', () async {
      final rig = await signedInWith({
        'm': ['a'],
      });
      addTearDown(rig.app.dispose);
      rig.app.stateOf('m')!.terminalCapabilityAvailable = false;

      await rig.app.selectAgent('m', 'a');

      expect(rig.app.paneOfAgent('m', 'a')!.session, isNull);
      expect(opensFor(rig, 'a'), isEmpty);
    });

    test('an agent the machine does not list is not opened at all', () async {
      final rig = await signedInWith({
        'm': ['a'],
      });
      addTearDown(rig.app.dispose);

      await rig.app.selectAgent('m', 'ghost');
      await rig.app.selectAgent('ghost', 'a');

      expect(rig.app.allPanes, isEmpty);
    });

    test('a page waiting for its terminal is opened by the next tap', () async {
      final rig = await signedInWith({
        'm': ['a'],
      });
      addTearDown(rig.app.dispose);
      rig.app.stateOf('m')!.terminalCapabilityAvailable = false;
      await rig.app.selectAgent('m', 'a');
      rig.app.stateOf('m')!.terminalCapabilityAvailable = true;

      final opening = rig.app.selectAgent('m', 'a');
      await settle();
      rig.app.paneOfAgent('m', 'a')!.session!.reportViewport(80, 24);
      await opening;

      expect(opensFor(rig, 'a'), hasLength(1));
    });

    test(
      'names this phone after the person when the device has no name',
      () async {
        final rig = await signedInWith({
          'm': ['a'],
        });
        addTearDown(rig.app.dispose);

        final descriptor = rig.app.phoneClientDescriptor();

        expect(descriptor.kind, 'phone');
        expect(descriptor.name, "Pat's phone");
      },
    );
  });

  group('the pager opening ahead of the thumb', () {
    test('never on a machine that would take the terminal to do it', () async {
      final rig = await signedInWith({
        'm': ['a'],
      }, noTakeover: false);
      addTearDown(rig.app.dispose);

      await rig.app.warmAgentPane('m', 'a');

      expect(rig.app.allPanes, isEmpty);
      expect(opensFor(rig, 'a'), isEmpty);
    });

    test('politely, without moving focus or the saved layout', () async {
      final storage = MemoryKeyValueStore();
      final rig = await signedInWith({
        'm': ['a', 'b'],
      }, storage: storage);
      addTearDown(rig.app.dispose);
      await openAgent(rig, 'm', 'a');
      await rig.app.flushPaneLayout();
      final saved = storage.values['swarm_layout_v1'];

      await warm(rig, 'b');
      await rig.app.flushPaneLayout();

      final pane = rig.app.paneOfAgent('m', 'b')!;
      expect(pane.warm, isTrue);
      expect(opensFor(rig, 'b').single['takeover'], isFalse);
      expect(rig.app.focusedPane?.agentId, 'a');
      expect(rig.app.stateOf('m')!.activeAgentId, 'a');
      expect(storage.values['swarm_layout_v1'], saved);
    });

    test('a guess that comes true joins the layout', () async {
      final storage = MemoryKeyValueStore();
      final rig = await signedInWith({
        'm': ['a', 'b'],
      }, storage: storage);
      addTearDown(rig.app.dispose);
      await warm(rig, 'b');

      await rig.app.selectAgent('m', 'b');
      await rig.app.flushPaneLayout();

      expect(rig.app.paneOfAgent('m', 'b')!.warm, isFalse);
      expect(storage.values['swarm_layout_v1'], contains('"agentId":"b"'));
    });

    test(
      'a warm page with a dead stream is reopened; a live one is left',
      () async {
        final rig = await signedInWith({
          'm': ['a'],
        });
        addTearDown(rig.app.dispose);
        await warm(rig, 'a');
        await rig.app.warmAgentPane('m', 'a');
        expect(opensFor(rig, 'a'), hasLength(1));

        rig.app.paneOfAgent('m', 'a')!.session!.transportLost('gone');
        await rig.app.warmAgentPane('m', 'a');

        expect(opensFor(rig, 'a'), hasLength(2));
        expect(opensFor(rig, 'a').last['takeover'], isFalse);
      },
    );

    test('a page a person has looked at is not reopened by a guess', () async {
      final rig = await signedInWith({
        'm': ['a'],
      });
      addTearDown(rig.app.dispose);
      final session = await openAgent(rig, 'm', 'a');
      session.transportLost('gone');

      await rig.app.warmAgentPane('m', 'a');

      expect(opensFor(rig, 'a'), hasLength(1));
    });

    test(
      'a refused polite open waits for a person, not a retry loop',
      () async {
        final rig = await signedInWith({
          'm': ['a'],
        });
        addTearDown(rig.app.dispose);
        await warm(rig, 'a');
        final session = rig.app.paneOfAgent('m', 'a')!.session!;

        await push(rig, 'm', 'terminal_error', {
          'requestId': opensFor(rig, 'a').single['requestId'],
          'code': 'CONTROL_LEASE_HELD',
        });
        expect(session.status, TerminalSessionStatus.takenOver);

        // The machine's list landing again reattaches what needs it — not this.
        await rig.app.reloadMachineData('m');
        await settle();
        expect(opensFor(rig, 'a'), hasLength(1));
      },
    );
  });

  group('closing a page', () {
    test(
      'closes its stream, and shows its last screen when it is back',
      () async {
        final rig = await signedInWith({
          'm': ['a'],
        });
        addTearDown(rig.app.dispose);
        final session = await openAgent(rig, 'm', 'a');
        await session.close();
        await session.reopen();
        await answerOpen(rig, session, screen: 'last words here');
        final streamId = session.streamId;

        await rig.app.closePane(rig.app.paneOfAgent('m', 'a')!.id);

        expect(rig.app.paneOfAgent('m', 'a'), isNull);
        expect(
          rig
              .conn('m')
              .frames
              .where(
                (f) => f.$1 == 'terminal_close' && f.$2['streamId'] == streamId,
              ),
          hasLength(1),
        );

        final reopening = rig.app.selectAgent('m', 'a');
        await settle();
        final again = rig.app.paneOfAgent('m', 'a')!.session!;
        expect(again.showingKeptScreen, isTrue);
        expect(again.hasScreen, isTrue);
        expect(
          screenOf(again),
          contains('last words here'),
          reason: 'the stand-in is what the reader last saw, not a blank page',
        );
        again.reportViewport(80, 24);
        await reopening;
        expect(screenOf(again), contains('last words here'));
        await answerOpen(rig, again, screen: 'fresh');
        expect(again.showingKeptScreen, isFalse);
        expect(screenOf(again), contains('fresh'));
      },
    );

    test('a page closed before it drew anything keeps nothing', () async {
      final rig = await signedInWith({
        'm': ['a'],
      });
      addTearDown(rig.app.dispose);
      final opening = rig.app.selectAgent('m', 'a');
      await settle();
      rig.app.paneOfAgent('m', 'a')!.session!.reportViewport(80, 24);
      await opening;

      await rig.app.closePane(rig.app.paneOfAgent('m', 'a')!.id);
      final reopening = rig.app.selectAgent('m', 'a');
      await settle();

      expect(rig.app.paneOfAgent('m', 'a')!.session!.hasScreen, isFalse);
      rig.app.paneOfAgent('m', 'a')!.session!.reportViewport(80, 24);
      await reopening;
    });

    test('only the last few screens are kept', () async {
      final rig = await signedInWith({
        'm': ['a', 'b', 'c', 'd'],
      });
      addTearDown(rig.app.dispose);
      for (final id in ['a', 'b', 'c', 'd']) {
        await openAgent(rig, 'm', id);
        await rig.app.closePane(rig.app.paneOfAgent('m', id)!.id);
      }

      final reopening = rig.app.selectAgent('m', 'a');
      await settle();
      expect(rig.app.paneOfAgent('m', 'a')!.session!.hasScreen, isFalse);
      rig.app.paneOfAgent('m', 'a')!.session!.reportViewport(80, 24);
      await reopening;
    });

    test('an unknown page is nothing to close', () async {
      final rig = await signedInWith({
        'm': ['a'],
      });
      addTearDown(rig.app.dispose);

      await rig.app.closePane(999);

      expect(rig.app.allPanes, isEmpty);
    });
  });

  group('frames from the machine', () {
    test(
      'a frame that cannot be decoded takes down every stream on its machine',
      () async {
        final rig = await signedInWith({
          'm': ['a', 'b'],
        });
        addTearDown(rig.app.dispose);
        final a = await openAgent(rig, 'm', 'a');
        final b = await openAgent(rig, 'm', 'b');

        await rig.app.handleTerminalBinaryForTest(
          'm',
          Uint8List.fromList([1, 2, 3]),
        );

        expect(a.status, TerminalSessionStatus.error);
        expect(b.status, TerminalSessionStatus.error);
      },
    );

    test('a frame reaches only the stream it names', () async {
      final rig = await signedInWith({
        'm': ['a', 'b'],
      });
      addTearDown(rig.app.dispose);
      final a = await openAgent(rig, 'm', 'a');
      final b = await openAgent(rig, 'm', 'b');
      final before = b.outputTicks.value;

      await rig.app.handleTerminalBinaryForTest(
        'm',
        encodeTerminalLocal(
          TerminalBinaryFrame(
            kind: TerminalBinaryKind.output,
            streamId: a.streamId!,
            seq: 1,
            bytes: Uint8List.fromList('hello'.codeUnits),
            compressed: false,
          ),
        )!,
      );

      expect(a.outputTicks.value, greaterThan(0));
      expect(b.outputTicks.value, before);
    });

    test('a frame for a machine with nothing open is dropped', () async {
      final rig = await signedInWith({
        'm': ['a'],
      });
      addTearDown(rig.app.dispose);

      await rig.app.handleTerminalBinaryForTest(
        'm',
        Uint8List.fromList([1, 2, 3]),
      );

      expect(rig.app.allPanes, isEmpty);
    });

    test('what is typed is sent down the machine\'s socket, encoded', () async {
      final rig = await signedInWith({
        'm': ['a'],
      });
      addTearDown(rig.app.dispose);
      final session = await openAgent(rig, 'm', 'a');

      session.terminal.textInput('ls\r');
      await settle();

      final input = rig
          .conn('m')
          .binaries
          .map(decodeTerminalLocal)
          .whereType<TerminalBinaryFrame>()
          .where((frame) => frame.kind == TerminalBinaryKind.input)
          .toList();
      expect(String.fromCharCodes(input.expand((f) => f.bytes)), 'ls\r');
      expect(input.first.streamId, session.streamId);
    });

    test('an open that stalls on a live socket redials it once', () async {
      final rig = await signedInWith({
        'm': ['a'],
      });
      addTearDown(rig.app.dispose);
      final opening = rig.app.selectAgent('m', 'a');
      await settle();
      final session = rig.app.paneOfAgent('m', 'a')!.session!;
      session.reportViewport(80, 24);
      await opening;

      // No terminal_ready: past the session's watchdog, the socket is suspect.
      await Future<void>.delayed(
        session.resyncTimeout + const Duration(milliseconds: 100),
      );

      expect(rig.conn('m').redials, 1);
      expect(opensFor(rig, 'a'), hasLength(2), reason: 'the same open, again');
      expect(
        opensFor(rig, 'a').last['requestId'],
        opensFor(rig, 'a').first['requestId'],
      );
    });

    test('an open on a socket still shaking hands is not redialled', () async {
      final rig = await signedInWith({
        'm': ['a'],
      });
      addTearDown(rig.app.dispose);
      rig.conn('m').ready = false;
      final opening = rig.app.selectAgent('m', 'a');
      await settle();
      final session = rig.app.paneOfAgent('m', 'a')!.session!;
      session.reportViewport(80, 24);
      await opening;

      await Future<void>.delayed(
        session.resyncTimeout + const Duration(milliseconds: 100),
      );

      expect(rig.conn('m').redials, 0);
      expect(session.status, TerminalSessionStatus.error);
    });
  });

  group('a machine dropping out with several pages open', () {
    test('the page being read is the one recovery brings back', () async {
      final rig = await signedInWith({
        'm': ['a', 'b'],
      }, noTakeover: false);
      addTearDown(rig.app.dispose);
      await openAgent(rig, 'm', 'a');
      await openAgent(rig, 'm', 'b');
      // `b` is focused, but `a` comes first in the list.
      expect(rig.app.focusedPane?.agentId, 'b');

      await push(rig, 'm', 'node_status', {'online': false});

      expect(rig.app.stateOf('m')!.pendingOfflineAgentId, 'b');
    });

    test('a page someone else took is not recorded to be taken back', () async {
      final rig = await signedInWith({
        'm': ['a'],
      });
      addTearDown(rig.app.dispose);
      final session = await openAgent(rig, 'm', 'a');
      await push(rig, 'm', 'terminal_closed', {
        'streamId': session.streamId,
        'code': 'TERMINAL_TAKEN_OVER',
      });

      await push(rig, 'm', 'node_status', {'online': false});

      expect(rig.app.stateOf('m')!.pendingOfflineAgentId, isNull);
      expect(session.status, TerminalSessionStatus.takenOver);
    });
  });

  group('the layout across launches', () {
    test('a page opened on one launch is waiting on the next', () async {
      final storage = MemoryKeyValueStore();
      final first = await signedInWith({
        'm': ['a', 'b'],
      }, storage: storage);
      await openAgent(first, 'm', 'b');
      await first.app.flushPaneLayout();
      first.app.dispose();

      final next = viewerApp(storage: storage);
      addTearDown(next.app.dispose);
      await next.app.restorePaneLayoutForTest();

      final restored = next.app.allPanes.single;
      expect((restored.machineId, restored.agentId), ('m', 'b'));
      expect(restored.session, isNull, reason: 'intent, until m answers');
    });

    test('a layout that cannot be read is a first launch', () async {
      final storage = MemoryKeyValueStore()
        ..values['swarm_layout_v1'] = '{not json';
      final rig = viewerApp(storage: storage);
      addTearDown(rig.app.dispose);

      await rig.app.restorePaneLayoutForTest();

      expect(rig.app.allPanes, isEmpty);
    });

    test('an older build\'s single list of tiles is read too', () async {
      final storage = MemoryKeyValueStore()
        ..values['terminal_pane_layout'] =
            '[{"machineId":"m","agentId":"a"},{"machineId":"m","agentId":"a"}]';
      final rig = viewerApp(storage: storage);
      addTearDown(rig.app.dispose);

      await rig.app.restorePaneLayoutForTest();

      expect(rig.app.allPanes.map((p) => p.agentId), ['a']);
      expect(rig.app.focusedPane?.agentId, 'a');
    });
  });

  test(
    'an agent on a machine the phone signs out of is not reopened',
    () async {
      final rig = await signedInWith({
        'm': ['a'],
      });
      addTearDown(rig.app.dispose);
      await openAgent(rig, 'm', 'a');

      await rig.app.logout();

      expect(rig.app.allPanes, isEmpty);
      expect(rig.app.stateOf('m'), isNull);
      expect(rig.app.status, AppStatus.unauthenticated);
      expect(
        rig.conn('m').frames.where((f) => f.$1 == 'terminal_close'),
        hasLength(1),
        reason: 'its stream is let go of properly',
      );
      expect(rig.app.machines, isEmpty);
    },
  );
}
