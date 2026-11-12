import 'dart:io';

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/capture.dart';
import 'support/swarm_v4_channel.dart';

/// Set to a folder to write this file's screenshots there, with the system's real fonts.
final shots = Platform.environment['SWARM_V4_SHOTS'];

/// The smallest window the app goes to (880 by 560) and what a person does in it: the channel, a task's chat (a drawer there), an
/// agent's chat, the project's menu and the delete question, in both appearances. Nothing overflows or hides.
void main() {
  setUpAll(() => loadCaptureFonts(shots));

  Finder key(String k) => find.byKey(ValueKey(k));
  const smallest = Size(880, 560);

  for (final brightness in Brightness.values) {
    final mode = brightness.name;

    testWidgets(
      'the channel and a task\'s chat in the smallest window ($mode)',
      (tester) async {
        final server = swarmV4Channel();
        swarmV4Talk(server);
        final task = swarmV4Post(
          server,
          'Faye',
          '#12 The voice declines in a busy room. @Pip yours.',
        );
        swarmV4Post(server, 'Pip', 'Taking #12.', thread: task);
        swarmV4Post(server, 'Juno', 'Read #12: no P1.', thread: task);
        await openSwarmV4(
          tester,
          server,
          size: smallest,
          brightness: brightness,
        );
        expect(tester.takeException(), isNull);
        await captureWindow(tester, shots, 'smallest-channel-$mode');
        await tester.tap(key('super-thread-bar-$task'));
        await tester.pumpAndSettle();
        expect(key('super-thread-panel'), findsOneWidget);
        expect(tester.takeException(), isNull);
        await captureWindow(tester, shots, 'smallest-thread-$mode');
      },
    );

    testWidgets(
      'an agent\'s chat, the project menu and the delete question in the smallest window ($mode)',
      (tester) async {
        final server = swarmV4Channel();
        swarmV4Post(
          server,
          'Pip',
          'On it. Reading #12 first, then the retry path.',
          chat: 'agent-chat-pip',
        );
        await openSwarmV4(
          tester,
          server,
          saved: 'agent-chat-pip',
          size: smallest,
          brightness: brightness,
        );
        expect(key('swarm-agent-header'), findsOneWidget);
        expect(key('swarm-instructions-button'), findsOneWidget);
        expect(key('swarm-terminal-button'), findsOneWidget);
        await captureWindow(tester, shots, 'smallest-chat-$mode');
        // The left pane is still beside the chat at 880 wide; Pip's row removes it.
        expect(key('super-agent-pip'), findsOneWidget);
        await tester.tap(key('super-agent-pip'), buttons: kSecondaryButton);
        await tester.pumpAndSettle();
        await tester.tap(find.text('Remove'));
        await tester.pumpAndSettle();
        expect(find.text('Remove Pip?'), findsOneWidget);
        expect(tester.takeException(), isNull);
        await captureWindow(tester, shots, 'smallest-remove-$mode');
      },
    );
  }

  testWidgets('the project menu in the smallest window', (tester) async {
    final server = swarmV4Channel();
    swarmV4Talk(server);
    await openSwarmV4(tester, server, size: smallest);
    await tester.tap(key('super-project-menu'));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    await captureWindow(tester, shots, 'smallest-project-menu');
  });
}
