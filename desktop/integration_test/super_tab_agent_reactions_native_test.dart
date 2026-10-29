import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/test_run.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:window_manager/window_manager.dart';

import '../test/super_tab_delight_shots_test.dart' show ago, delightApp, office;
import '../test/support/super_tab_fixture.dart';
import 'flutter_test_config.dart';

/// The agent-reactions PR's screenshots on a real macOS surface, where color
/// emoji draw: agents acknowledge with 👀 ✅ 🚀 as Slack bots do and post only
/// substance. The in-memory Swarm of the delight capture, never a backend,
/// account or the live app. Writes to SUPER_TAB_AGENT_REACTIONS_SHOTS.
void main() {
  if (!kUnderTest) throw StateError('Requires FLUTTER_TEST=1');
  ensureNativeTestBinding();
  final folder = Platform.environment['SUPER_TAB_AGENT_REACTIONS_SHOTS'];
  final boundary = GlobalKey();

  Future<void> shot(String name) async {
    if (folder == null) return;
    final render =
        boundary.currentContext!.findRenderObject()! as RenderRepaintBoundary;
    final image = await render.toImage(pixelRatio: 2);
    final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
    await Directory(folder).create(recursive: true);
    await File('$folder/$name.png').writeAsBytes(bytes!.buffer.asUint8List());
    image.dispose();
  }

  testWidgets('agents acknowledge with reactions', (tester) async {
    expect(defaultTargetPlatform, TargetPlatform.macOS);
    await windowManager.ensureInitialized();
    await windowManager.setSize(const Size(1280, 860));
    await windowManager.setTitle('Agent reactions — test data');
    await windowManager.setAlwaysOnTop(true);
    addTearDown(() => windowManager.setAlwaysOnTop(false));
    await windowManager.show();
    for (final brightness in Brightness.values) {
      grid.AppTheme.brightness.value = brightness;
      final c = agentReactions().controller();
      await c.refresh();
      await tester.pumpWidget(
        delightApp(c, brightness: brightness, boundary: boundary),
      );
      await tester.pumpAndSettle();
      expect(find.text('✅'), findsOneWidget);
      await tester.runAsync(() => shot('agent-reactions-${brightness.name}'));
      await tester.pumpWidget(const SizedBox());
      c.dispose();
    }
    grid.AppTheme.brightness.value = Brightness.dark;
  }, variant: TargetPlatformVariant.only(TargetPlatform.macOS));
}

/// The delight office's people and agents, in a chat where the agents react
/// instead of posting "on it" or "done".
ConversationServer agentReactions() {
  final server = office()..messages.clear();
  Map<String, dynamic> agent(String id, String name) => {
    'kind': 'agent',
    'id': id,
    'name': name,
    'displayName': name,
  };
  Map<String, dynamic> by(String emoji, List<(String, String)> who) => {
    'emoji': emoji,
    'count': who.length,
    'by': [
      for (final (kind, id) in who) {'kind': kind, 'id': id},
    ],
  };
  void say(
    String text,
    Map<String, dynamic> author,
    Duration at,
    List<Map<String, dynamic>> reactions,
  ) {
    server.append(text);
    server.messages.last
      ..['author'] = author
      ..['createdAt'] = ago(at)
      ..['reactions'] = reactions;
  }

  final kai = agent('kai', 'Kai');
  say(
    'Kai: agents react 👀 when they start on a message, ✅ when done, 🚀 '
    'when merged, instead of posting "on it" or "done".',
    agent('river', 'River'),
    const Duration(minutes: 50),
    [
      by('check', [('agent', 'kai')]),
      by('rocket', [('agent', 'river')]),
    ],
  );
  say(
    'Plan: 1. the server takes ✅ and agents react as people do. 2. a react '
    'command. 3. the skills say to react, and to post only substance.',
    kai,
    const Duration(minutes: 48),
    [
      by('thumbs_up', [('person', 'owner')]),
    ],
  );
  say(
    'Can the phone show ✅ too?',
    {'kind': 'person', 'id': 'ivy', 'name': 'ivy@example.com'},
    const Duration(minutes: 9),
    [
      by('eyes', [('agent', 'kai')]),
    ],
  );
  say(
    'Ready for review: the Desktop pull request at f8cdae2. Phone is next.',
    kai,
    const Duration(minutes: 3),
    [
      by('eyes', [('agent', 'ellis')]),
    ],
  );
  return server;
}
