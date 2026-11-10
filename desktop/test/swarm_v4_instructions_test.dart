import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/capture.dart';
import 'support/swarm_v4_channel.dart';
import 'support/swarm_v4_data.dart';

/// Set to a folder to write this file's screenshots there, with the system's real fonts.
final shots = Platform.environment['SWARM_V4_SHOTS'];

/// An agent's instructions file, `agents/<name>.md`, beside its chat: every way it can read, as a person sees it, at the window
/// the app opens in (1440 wide, 1280 wide) and in both appearances.
void main() {
  setUpAll(() => loadCaptureFonts(shots));

  Finder key(String k) => find.byKey(ValueKey(k));

  /// A computer that holds Pip's file ([SwarmV4Computer]: it refuses as a real link fails, and a save checks the version).
  SwarmV4Computer computer({String? text, String? error}) =>
      SwarmV4Computer(files: {'session-pip/Pip': ?text})
        ..refuse = error;

  Future<void> open(
    WidgetTester tester,
    SwarmV4Computer computer, {
    Size size = const Size(1440, 860),
    Brightness brightness = Brightness.light,
  }) async {
    await openSwarmV4(
      tester,
      swarmV4Channel(),
      saved: 'agent-chat-pip',
      size: size,
      brightness: brightness,
      instructions: computer.link,
    );
    await tester.tap(key('swarm-instructions-button'));
    await tester.pumpAndSettle();
  }

  Future<void> look(WidgetTester tester, String name) =>
      captureWindow(tester, shots, 'instructions-$name');

  testWidgets('a short file reads, edits and saves', (tester) async {
    final pc = computer(
      text:
          '# Pip\n\nAlways say hello first.\nNever touch the lamp firmware.\n',
    );
    await open(tester, pc);
    expect(find.text('agents/Pip.md'), findsOneWidget);
    expect(find.textContaining('Always say hello first.'), findsOneWidget);
    await look(tester, 'read');
    await tester.tap(key('swarm-instructions-edit'));
    await tester.pumpAndSettle();
    await tester.enterText(
      key('swarm-instructions-field'),
      '# Pip\n\nAlways say hello first.\nNever touch the lamp firmware.\nShip on Fridays.\n',
    );
    await tester.pump();
    await look(tester, 'edit');
    await tester.tap(key('swarm-instructions-save'));
    await tester.pumpAndSettle();
    expect(find.textContaining('Ship on Fridays.'), findsOneWidget);
    // Saved on the computer, over the version it read.
    expect(pc.files['session-pip/Pip'], contains('Ship on Fridays.'));
    expect(
      [for (final (_, type, _) in pc.requests) type],
      ['agent_instructions_read', 'agent_instructions_write'],
    );
  });

  testWidgets('no file yet', (tester) async {
    await open(tester, computer());
    expect(find.textContaining('No instructions yet.'), findsOneWidget);
    await look(tester, 'none');
  });

  testWidgets('a file of nearly 64 KB, one line of it 5,000 long', (
    tester,
  ) async {
    final text = [
      '# Rules',
      for (var i = 0; i < 600; i++) '- rule $i: ${'always check twice ' * 4}',
      'x' * 5000,
    ].join('\n');
    expect(text.length, lessThan(65536));
    await open(tester, computer(text: text));
    expect(tester.takeException(), isNull);
    await look(tester, 'large');
    await tester.tap(key('swarm-instructions-edit'));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    await look(tester, 'large-edit');
  });

  for (final (code, words) in const [
    ('OFFLINE', 'Mac Studio is offline.'),
    ('UNSUPPORTED', 'Update Harness on Mac Studio.'),
    ('TIMEOUT', "Mac Studio didn't answer. Try again."),
    ('AGENT_NOT_FOUND', "Pip isn't running on Mac Studio."),
    ('FAILED', "Couldn't read it. Try again."),
    ('TOO_LARGE', 'Too long to open here.'),
  ]) {
    testWidgets('$code on a read says what to do and offers Try again', (
      tester,
    ) async {
      await open(tester, computer(error: code));
      expect(tester.widget<Text>(key('swarm-instructions-error')).data, words);
      expect(key('swarm-instructions-retry'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await look(tester, 'error-$code');
    });
  }

  testWidgets('the file in the dark, and at 1280 wide', (tester) async {
    await open(
      tester,
      computer(text: '# Pip\n\nAlways say hello first.\n'),
      size: const Size(1280, 800),
      brightness: Brightness.dark,
    );
    expect(find.textContaining('Always say hello first.'), findsOneWidget);
    await look(tester, 'dark-1280');
  });
}
