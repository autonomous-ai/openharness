// Task #3006 (Dee, 11-05): the Swarm in each new theme, for the pictures Dee
// okays before it merges: the chat with its sidebar, a thread open beside it,
// and Activity with a decision waiting. Writes nothing unless THEME_SHOTS
// names a folder.
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/core/local_key_value_store.dart';
import 'package:harness/shared/theme/appearance_prefs_store.dart';
import 'package:harness/shared/theme/color_palette.dart';
import 'package:harness/super_tabs/activity.dart';
import 'package:harness/super_tabs/attention.dart';
import 'package:harness/super_tabs/view.dart';
import 'package:harness/widgets/harness_customize_pane.dart';

import 'support/capture.dart';
import 'support/super_tab_fixture.dart';
import 'swarm_state_test.dart' show createApp;

final shots = Platform.environment['THEME_SHOTS'];

ConversationServer _swarm() {
  final server = ConversationServer()
    ..threads = true
    ..followedThreads = {'unread': [], 'read': [], 'more': false};
  server.state['projects'] = [
    projectFixture('lead', 'openharness', 'lead'),
    projectFixture('web', 'website', 'web-lead'),
  ];
  final groups = server.state['conversations'] as List;
  groups
    ..add({
      ...conversationFixture('t3006', 'Light and dark themes'),
      'projectId': 'lead',
      'number': 3006,
    })
    ..add({
      ...conversationFixture('t2996', 'Threads, Mentions, Decisions'),
      'projectId': 'lead',
      'number': 2996,
    })
    ..add({...conversationFixture('web-lead', 'Lead'), 'projectId': 'web'});
  (server.state['people'] as List)
    ..add({'id': 'dee', 'email': 'dee@example.com', 'role': 'collaborator'})
    ..add({'id': 'ken', 'email': 'ken@example.com', 'role': 'owner'});
  final now = DateTime.now().toUtc();
  const river = {'kind': 'agent', 'id': 'lead-agent', 'name': 'Lead'};
  const dee = {'kind': 'person', 'id': 'dee', 'name': 'dee@example.com'};
  const ken = {'kind': 'person', 'id': 'ken', 'name': 'ken@example.com'};
  void say(
    String text,
    Map<String, Object> author, {
    String conversation = 'lead',
    String? thread,
    int minutesAgo = 0,
  }) {
    server.append(text, conversationId: conversation);
    server.messages.last
      ..['author'] = author
      ..['createdAt'] = now
          .subtract(Duration(minutes: minutesAgo))
          .toIso8601String();
    if (thread != null) {
      server.messages.last
        ..['thread'] = thread
        ..['replyTo'] = thread;
    }
  }

  say('How do I change from dark mode to light mode?', dee, minutesAgo: 40);
  final root = server.messages.last['id'] as String;
  say(
    'Appearance > Workspace now opens on Light, Dark and Match macOS, with '
    'the light and the dark theme chosen right below.',
    river,
    thread: root,
    minutesAgo: 30,
  );
  say('Plum for me, Storm at night.', ken, thread: root, minutesAgo: 12);
  say(
    'Screenshots of each theme are in the task for your look.',
    river,
    minutesAgo: 8,
  );
  say('Release notes are up for review.', ken, minutesAgo: 2);
  server.tag(root, threadId: root, messageSequence: server.revision);
  say(
    'Which theme should be the default light one?',
    river,
    conversation: 'web-lead',
    minutesAgo: 5,
  );
  server.ask(
    ['Cloud or Plum as the default light theme?'],
    conversationId: 'web-lead',
    projectId: 'web',
  );
  ((server.state['conversations'] as List)[0] as Map)['leadId'] = 'lead-agent';
  return server;
}

void main() {
  setUpAll(() => loadCaptureFonts(shots));

  for (final palette in [
    HarnessPalette.plum,
    HarnessPalette.cloud,
    HarnessPalette.night,
    HarnessPalette.storm,
  ]) {
    testWidgets('the Swarm in ${palette.label}', (tester) async {
      if (shots == null) return;
      final previous = (
        grid.AppTheme.palette.value,
        grid.AppTheme.brightness.value,
      );
      grid.AppTheme.palette.value = palette;
      grid.AppTheme.brightness.value = palette.brightness;
      addTearDown(() {
        grid.AppTheme.palette.value = previous.$1;
        grid.AppTheme.brightness.value = previous.$2;
      });
      tester.view.devicePixelRatio = 2;
      tester.view.physicalSize = const Size(2560, 1500);
      addTearDown(tester.view.reset);
      final app = createApp(connected: true);
      addTearDown(app.dispose);
      final server = _swarm();
      final c = server.controller(
        account: 'dee',
        initial: {
          'tabId': 'tab',
          'accountId': 'dee',
          'selectedId': 'lead',
          'expandedProjects': ['lead'],
        },
      );
      await c.refresh();
      final attention = SuperTabAttention.of(c);
      await attention.mentions.load();
      await attention.decisions.load();
      await attention.load();
      SuperTabActivity.of(c);
      await c.select('lead');
      final picture = GlobalKey();
      await tester.pumpWidget(
        MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: grid.buildAppTheme(brightness: palette.brightness),
          home: RepaintBoundary(
            key: picture,
            child: Scaffold(
              body: SuperTabView(
                controller: c,
                app: app,
                onInvite: () {},
                onAddAgent: (_) {},
                onOpenTerminal: (_) {},
                onNewProject: () {},
                machineName: (_) => 'Team Mac',
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      Future<void> shot(String scene) => captureBoundary(
        tester,
        picture.currentContext!.findRenderObject()! as RenderRepaintBoundary,
        shots,
        'theme-${palette.name}-$scene',
      );

      await shot('chat');
      final line = find.byKey(const ValueKey('super-thread-line-message-1'));
      if (line.evaluate().isNotEmpty) {
        await tester.tap(line);
        await tester.pumpAndSettle();
        await shot('thread');
      }
      final activityRow = find.byKey(const ValueKey('super-activity'));
      if (activityRow.evaluate().isNotEmpty) {
        await tester.tap(activityRow);
        await tester.pumpAndSettle();
        await shot('activity');
      }
      await tester.pumpWidget(const SizedBox());
      await c.flush();
      c.dispose();
    }, variant: TargetPlatformVariant.only(TargetPlatform.macOS));
  }

  testWidgets('Appearance > Workspace in Plum', (tester) async {
    if (shots == null) return;
    final store = AppearancePrefsStore(storage: _Memory());
    addTearDown(store.dispose);
    await store.setPalette(HarnessPalette.plum);
    final previous = (
      grid.AppTheme.palette.value,
      grid.AppTheme.brightness.value,
    );
    grid.AppTheme.palette.value = HarnessPalette.plum;
    grid.AppTheme.brightness.value = Brightness.light;
    addTearDown(() {
      grid.AppTheme.palette.value = previous.$1;
      grid.AppTheme.brightness.value = previous.$2;
    });
    tester.view.devicePixelRatio = 2;
    tester.view.physicalSize = const Size(880, 1500);
    addTearDown(tester.view.reset);
    final picture = GlobalKey();
    await tester.pumpWidget(
      MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: grid.buildAppTheme(brightness: Brightness.light),
        home: RepaintBoundary(
          key: picture,
          child: Scaffold(
            body: HarnessCustomizePane(onClose: () {}, store: store),
          ),
        ),
      ),
    );
    await tester.tap(find.byKey(const ValueKey('customize-appearance')));
    await tester.pumpAndSettle();
    await captureBoundary(
      tester,
      picture.currentContext!.findRenderObject()! as RenderRepaintBoundary,
      shots,
      'theme-appearance-workspace',
    );
  }, variant: TargetPlatformVariant.only(TargetPlatform.macOS));
}

class _Memory implements LocalKeyValueStore {
  final values = <String, String>{};
  @override
  Future<String?> read(String key) async => values[key];
  @override
  Future<void> delete(String key) async => values.remove(key);
  @override
  Future<void> write(String key, String value) async => values[key] = value;
}
