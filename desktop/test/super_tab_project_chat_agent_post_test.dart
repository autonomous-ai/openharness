import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/capture.dart';
import 'support/pm_chat_fixture.dart';
import 'support/super_tab_fixture.dart';

/// Set to a folder to write the project chat with an Engineer's post there, in
/// light and dark (task #2924): the real chat over the in-memory Swarm, never
/// a backend or the live app.
final _shots = Platform.environment['SUPER_TAB_AGENT_POST_SHOTS'];

/// The project chat with its PM, a person's ask, and the answer of Marlin, an
/// Engineer with a task in the project who is not a member of the chat
/// (backend commands.ts postable, #2924).
ConversationServer _swarm() {
  final server = pmChatSwarm();
  (server.state['agents'] as List).add({
    'id': 'marlin',
    'name': 'Marlin',
    'machineId': 'm2',
    'harnessId': 'h2',
    'contributorId': 'owner',
    'configuration': {'engine': 'codex', 'model': 'gpt-6-astra'},
  });
  server.append('Can someone look at the login bug on the phone?');
  server.append('I am on it: the token expires before the refresh.');
  server.messages.last['author'] = {
    'kind': 'agent',
    'id': 'marlin',
    'name': 'Marlin',
  };
  return server;
}

void main() {
  setUpAll(() => loadCaptureFonts(_shots));

  Future<SuperTabController> show(
    WidgetTester tester,
    Brightness brightness,
  ) async {
    await tester.binding.setSurfaceSize(const Size(1200, 760));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    // The app sets the design tokens' brightness from its theme at startup.
    grid.AppTheme.brightness.value = brightness;
    addTearDown(() => grid.AppTheme.brightness.value = Brightness.dark);
    final c = _swarm().controller();
    await c.refresh();
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: brightness),
        home: Scaffold(
          body: SuperTabView(
            controller: c,
            onInvite: () {},
            onAddAgent: (_) {},
            onOpenTerminal: (_) {},
            machineName: (_) => 'Team Mac',
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    addTearDown(c.dispose);
    return c;
  }

  testWidgets(
    'shows an Engineer\'s post in the project chat with its name and engine '
    'mark, and its terminals stay the PM\'s alone',
    (tester) async {
      final c = await show(tester, Brightness.dark);
      expect(
        find.text('I am on it: the token expires before the refresh.'),
        findsOneWidget,
      );
      expect(find.text('Marlin'), findsWidgets);
      expect(find.byKey(const ValueKey('engine-icon-codex')), findsWidgets);
      // The chat's terminals: its PM alone, as #2207 keeps it.
      expect(c.snapshot!.paneAgentIds('lead'), ['lead-agent']);
      expect(find.byTooltip('Group terminals (1)'), findsOneWidget);
    },
  );

  testWidgets('screenshots for review', (tester) async {
    for (final (brightness, name) in [
      (Brightness.light, 'light'),
      (Brightness.dark, 'dark'),
    ]) {
      await show(tester, brightness);
      // The engine marks are image assets: decoded before the shot, or the
      // first one is drawn empty.
      await tester.runAsync(() async {
        for (final element in find.byType(Image).evaluate()) {
          await precacheImage((element.widget as Image).image, element);
        }
      });
      await tester.pumpAndSettle();
      await captureWindow(tester, _shots, 'project-chat-agent-post-$name');
      await tester.pumpWidget(const SizedBox());
      await tester.pumpAndSettle();
    }
  }, skip: _shots == null);
}
