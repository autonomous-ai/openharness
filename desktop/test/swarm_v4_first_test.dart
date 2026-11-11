import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/capture.dart';
import 'support/super_tab_fixture.dart';
import 'support/swarm_v4_channel.dart';

/// Set to a folder to write this file's screenshots there, with the system's real fonts.
final shots = Platform.environment['SWARM_V4_SHOTS'];

/// A person's first launch of Swarm v4: nothing in it, then one agent, then one project, each as the window shows it.
void main() {
  setUpAll(() => loadCaptureFonts(shots));

  Finder key(String k) => find.byKey(ValueKey(k));

  /// A Swarm with nothing in it.
  ConversationServer nothing() {
    final server = ConversationServer()..threads = true;
    (server.state['conversations'] as List).clear();
    server.state['projects'] = <dynamic>[];
    server.state['agents'] = <dynamic>[];
    return server;
  }

  for (final size in const [Size(1440, 860), Size(1024, 700), Size(700, 800)]) {
    final at = size.width.toInt();

    testWidgets(
      'a Swarm with nothing in it, at $at wide: two ways to start, and each starts',
      (tester) async {
        var agents = 0, projects = 0;
        await openSwarmV4(
          tester,
          nothing(),
          size: size,
          onNewAgent: () => agents++,
          onNewProject: () => projects++,
        );
        expect(
          find.text('Start a project, or bring an agent to work with you.'),
          findsOneWidget,
        );
        // An empty list shows nothing: Projects is its heading and its +, with no words under it.
        if (at >= 720) {
          expect(key('project-sidebar-projects'), findsOneWidget);
          expect(key('project-sidebar-projects-add'), findsOneWidget);
        }
        expect(key('super-projects-empty'), findsNothing);
        expect(find.text('No projects yet.'), findsNothing);
        expect(tester.takeException(), isNull);
        await captureWindow(tester, shots, 'first-nothing-$at');
        await tester.tap(key('super-empty-new-agent'));
        await tester.pump();
        expect(agents, 1);
        await tester.tap(find.text('New project'));
        await tester.pump();
        expect(projects, 1);
      },
    );
  }

  testWidgets('the same in the dark', (tester) async {
    await openSwarmV4(tester, nothing(), brightness: Brightness.dark);
    expect(
      find.text('Start a project, or bring an agent to work with you.'),
      findsOneWidget,
    );
    await captureWindow(tester, shots, 'first-nothing-dark');
  });
}
