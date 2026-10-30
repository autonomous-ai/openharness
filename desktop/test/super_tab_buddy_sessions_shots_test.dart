import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/view.dart';

import 'box_render_preview_test.dart' show loadPreviewFonts;
import 'support/super_tab_fixture.dart';
import 'swarm_state_test.dart' show createApp;

/// Set to a folder to write the PR's screenshots there.
final shots = Platform.environment['SUPER_TAB_BUDDY_SESSION_SHOTS'];

/// Buddy thread sessions as the PR shows them, the spec's five mockups in
/// both appearances: a thread with no session, the limit, a working session,
/// the chat's thread line, and an ended session.
void main() {
  setUpAll(() async {
    if (shots == null) return;
    await loadPreviewFonts();
    // The activity marks are Braille and symbols, which the preview fonts
    // lack; the roster's captures load them from the system the same way.
    if (!Platform.isMacOS) return;
    for (final font in [
      ('.AppleSystemUIFontMonospaced', '/System/Library/Fonts/SFNSMono.ttf'),
      ('Menlo', '/System/Library/Fonts/Menlo.ttc'),
      ('Apple Symbols', '/System/Library/Fonts/Apple Symbols.ttf'),
    ]) {
      final bytes = ByteData.sublistView(await File(font.$2).readAsBytes());
      await (FontLoader(font.$1)..addFont(Future.value(bytes))).load();
    }
  });

  const owner = {'kind': 'person', 'id': 'owner', 'name': 'quang@example.com'};
  const wren = {
    'kind': 'agent',
    'id': 'buddy-main',
    'name': 'Wren',
    'displayName': 'Wren',
  };
  const session = {
    'kind': 'agent',
    'id': 'session-1',
    'name': 'Wren',
    'displayName': 'Wren',
  };

  Map<String, dynamic> agent(String id, String harness, {String? thread}) => {
    'id': id,
    'name': 'Wren',
    'displayName': 'Wren',
    'machineId': 'm',
    'harnessId': harness,
    'contributorId': 'owner',
    'machineOwnerId': 'owner',
    'buddyOf': {'personId': 'owner', 'generation': 'g1'},
    'buddySession': ?(thread == null ? null : {'thread': thread, 'from': 1}),
    'configuration': {'engine': 'claude', 'model': 'opus'},
  };

  for (final brightness in Brightness.values) {
    for (final state in ['no-session', 'limit', 'working', 'chat', 'ended']) {
      testWidgets('screenshot $state (${brightness.name})', (tester) async {
        final picture = GlobalKey();
        final app = createApp(connected: true);
        addTearDown(app.dispose);
        final server = ConversationServer()..threads = true;
        (server.state['people'] as List).first['email'] = 'quang@example.com';
        final chat = (server.state['conversations'] as List)[1] as Map
          ..['kind'] = 'buddy'
          ..['buddyOwnerId'] = 'owner'
          ..['title'] = 'Wren'
          ..['buddyName'] = 'Wren'
          ..['agentIds'] = ['buddy-main'];
        (server.state['agents'] as List).add(agent('buddy-main', 'a1'));
        final now = DateTime.now().toUtc();
        void say(
          String text,
          Map<String, Object> author, {
          String? thread,
          int minutesAgo = 0,
          Map<String, Object>? source,
        }) {
          server.append(text, conversationId: 'offline');
          server.messages.last
            ..['author'] = author
            ..['createdAt'] = now
                .subtract(Duration(minutes: minutesAgo))
                .toIso8601String();
          if (thread != null) {
            server.messages.last
              ..['thread'] = thread
              ..['replyTo'] = thread
              ..['buddySession'] = true;
          }
          if (source != null) server.messages.last['source'] = source;
        }

        say(
          'Measure prod CPU for the last day and say what changed.',
          owner,
          minutesAgo: 12,
        );
        if (state == 'working' || state == 'chat' || state == 'ended') {
          say(
            'Reading the last 24 h of pod logs, one pod at a time…',
            session,
            thread: 'message-1',
            minutesAgo: 10,
          );
        }
        say('What\'s the PR number for the login fix?', owner, minutesAgo: 2);
        say('#2290.', wren, minutesAgo: 2);
        if (state == 'ended') {
          say(
            'Session ended: idle for 30 minutes.',
            owner,
            thread: 'message-1',
            source: {
              'kind': 'buddy-session-ended',
              'reason': 'idle',
              'thread': 'message-1',
            },
          );
          server.messages.last['author'] = {
            'kind': 'person',
            'id': 'system',
            'name': 'Harness',
          };
        }
        if (state == 'working' || state == 'chat') {
          chat['buddySessions'] = [
            {
              'thread': 'message-1',
              'startId': 's1',
              'agentId': 'session-1',
              'at': 1,
            },
          ];
          chat['agentIds'] = ['buddy-main', 'session-1'];
          (server.state['agents'] as List).add(
            agent('session-1', 'a5', thread: 'message-1'),
          );
          await app.handleEventForTest('m', {
            'type': 'turn_started',
            'agentId': 'a5',
          });
        }
        if (state == 'limit') {
          chat['buddySessions'] = [
            for (final t in ['t1', 't2', 't3'])
              {'thread': t, 'startId': 's$t', 'agentId': 'session-$t', 'at': 1},
          ];
        }
        final c = server.controller();
        addTearDown(c.dispose);
        await c.refresh();
        grid.AppTheme.brightness.value = brightness;
        addTearDown(() => grid.AppTheme.brightness.value = Brightness.light);
        await tester.binding.setSurfaceSize(const Size(1280, 720));
        addTearDown(() => tester.binding.setSurfaceSize(null));
        await tester.pumpWidget(
          MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: grid.buildAppTheme(brightness: brightness),
            builder: (context, child) =>
                RepaintBoundary(key: picture, child: child),
            home: Scaffold(
              body: SuperTabView(
                controller: c,
                app: app,
                onInvite: () {},
                onAddAgent: (_) {},
                onOpenTerminal: (_) {},
                machineName: (_) => 'Mac Studio',
              ),
            ),
          ),
        );
        c.select('offline');
        await tester.pumpAndSettle();
        if (state != 'chat') {
          c.openThread('message-1');
          await tester.pumpAndSettle();
        }
        // The working mark spins: stop on one frame.
        await tester.pump(const Duration(milliseconds: 50));
        await tester.runAsync(() async {
          final boundary =
              picture.currentContext!.findRenderObject()!
                  as RenderRepaintBoundary;
          final image = await boundary.toImage(pixelRatio: 1.5);
          final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
          await Directory(shots!).create(recursive: true);
          await File('$shots/buddy-session-$state-${brightness.name}.png')
              .writeAsBytes(bytes!.buffer.asUint8List());
          image.dispose();
        });
        if (state == 'working' || state == 'chat') {
          // Its turn ends, so no turn watchdog outlives the test.
          await app.handleEventForTest('m', {
            'type': 'turn_ended',
            'agentId': 'a5',
          });
          // Its preview's short debounce runs out too.
          await tester.pump(const Duration(milliseconds: 100));
        }
        await tester.pumpWidget(const SizedBox());
        await c.flush();
      }, skip: shots == null);
    }
  }
}
