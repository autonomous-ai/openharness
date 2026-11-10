import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/instructions_link.dart';

import 'support/capture.dart';
import 'support/swarm_v4_channel.dart';

/// Set to a folder to write this file's screenshots there, with the system's real fonts.
final shots = Platform.environment['SWARM_V4_SHOTS'];

/// An agent's instructions file, `agents/<name>.md`, beside its chat: every way it can read, as a person sees it, at the window
/// the app opens in (1440 wide, 1280 wide) and in both appearances.
void main() {
  setUpAll(() => loadCaptureFonts(shots));

  Finder key(String k) => find.byKey(ValueKey(k));

  /// A computer that holds one file: what it answers to a read and a write, or its error [code].
  SwarmInstructionsLink computer({
    String? text,
    String? error,
    List<String>? asked,
  }) {
    var held = text;
    var version = 1;
    return SwarmInstructionsLink((machine, type, payload) async {
      asked?.add(type);
      if (error != null) return {'error': error};
      if (type == 'agent_instructions_write') {
        held = payload['text'] as String;
        return {'version': 'v${++version}'};
      }
      return {'text': held, 'version': 'v$version'};
    });
  }

  Future<void> open(
    WidgetTester tester,
    SwarmInstructionsLink link, {
    Size size = const Size(1440, 860),
    Brightness brightness = Brightness.light,
  }) async {
    await openSwarmV4(
      tester,
      swarmV4Channel(),
      saved: 'agent-chat-pip',
      size: size,
      brightness: brightness,
      instructions: link,
    );
    await tester.tap(key('swarm-instructions-button'));
    await tester.pumpAndSettle();
  }

  Future<void> look(WidgetTester tester, String name) =>
      captureWindow(tester, shots, 'instructions-$name');

  testWidgets('a short file reads, edits and saves', (tester) async {
    final asked = <String>[];
    await open(
      tester,
      computer(
        text: '# Pip\n\nAlways say hello first.\nNever touch the lamp firmware.\n',
        asked: asked,
      ),
    );
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
    expect(asked, ['agent_instructions_read', 'agent_instructions_write']);
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

  for (final code in const [
    'OFFLINE',
    'UNSUPPORTED',
    'TIMEOUT',
    'AGENT_NOT_FOUND',
    'FAILED',
    'TOO_LARGE',
  ]) {
    testWidgets('$code on a read says so and offers Try again', (tester) async {
      await open(tester, computer(error: code));
      expect(key('swarm-instructions-error'), findsOneWidget);
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
