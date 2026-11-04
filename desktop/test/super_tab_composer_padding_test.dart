import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_icons.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/workspace_chrome.dart';
import 'package:harness/super_tabs/view.dart';
import 'package:harness/super_tabs/voice_recorder.dart';

import 'support/super_tab_fixture.dart';

class _Recorder implements SuperTabVoiceRecorder {
  @override
  Future<void> start({required String conversationId, String? root}) async {}
}

/// Huy, 11-04: the composer was too tight, its hint and its row of actions
/// against the box's edge. As on the phone and in Slack, the text sits 12 below
/// the top and 16 in from each side, the + and the arrow's glyphs keep those
/// edges, the row has a little more air above it, the arrow sits as far up from
/// the bottom as the text sits down from the top, and the corners are the
/// phone's (SwarmComposer.cardRadius).
void main() {
  const top = 12.0, side = 16.0, rowGap = 12.0, radius = 24.0;

  ConversationServer buddyChat() {
    final server = ConversationServer()..threads = true;
    server.state['threadSessions'] = true;
    server.state['sessionsFromChat'] = true;
    final chat = (server.state['conversations'] as List)[1] as Map;
    chat
      ..['kind'] = 'buddy'
      ..['buddyOwnerId'] = 'owner'
      ..['title'] = 'Wren'
      ..['agentIds'] = ['buddy-main'];
    (server.state['agents'] as List).add({
      'id': 'buddy-main',
      'name': 'Wren',
      'displayName': 'Wren',
      'machineId': 'mac',
      'harnessId': 'h-main',
      'contributorId': 'owner',
      'buddyOf': {'personId': 'owner', 'generation': 'g1'},
      'configuration': {'engine': 'claude'},
    });
    server.append(
      'Measure prod CPU for the last day',
      conversationId: 'offline',
    );
    return server;
  }

  ConversationServer projectThread() {
    final server = ConversationServer()..threads = true;
    server.append('The build fails on the second run.');
    server.append('Which machine was it on?');
    server.messages.last
      ..['thread'] = 'message-1'
      ..['replyTo'] = 'message-1';
    return server;
  }

  Finder key(String value) => find.byKey(ValueKey(value));
  Rect glyph(WidgetTester tester, Finder button, IconData icon) =>
      tester.getRect(find.descendant(of: button, matching: find.byIcon(icon)));

  for (final brightness in Brightness.values) {
    for (final scene in ['chat', 'thread', 'web-phone']) {
      testWidgets('the $scene composer has room inside its box '
          '(${brightness.name})', (tester) async {
        final thread = scene == 'thread', phone = scene == 'web-phone';
        final c = (thread ? projectThread() : buddyChat()).controller();
        addTearDown(c.dispose);
        await c.refresh();
        grid.AppTheme.brightness.value = brightness;
        addTearDown(() => grid.AppTheme.brightness.value = Brightness.light);
        await tester.binding.setSurfaceSize(
          phone ? const Size(390, 844) : const Size(1280, 720),
        );
        addTearDown(() => tester.binding.setSurfaceSize(null));
        await tester.pumpWidget(
          MaterialApp(
            theme: grid.buildAppTheme(brightness: brightness),
            home: WorkspaceChromeScope(
              chrome: WorkspaceChrome(compactBelow: phone ? 720 : 0),
              child: Scaffold(
                body: SuperTabView(
                  controller: c,
                  onInvite: () {},
                  onAddAgent: (_) {},
                  onOpenTerminal: (_) {},
                  machineName: (_) => 'Mac Studio',
                  voiceRecorder: _Recorder(),
                ),
              ),
            ),
          ),
        );
        if (!thread) await c.select('offline');
        await tester.pumpAndSettle();
        if (thread) {
          c.openThread('message-1');
          await tester.pumpAndSettle();
        }
        final surfaceKey = key(
          thread
              ? 'super-thread-composer-surface'
              : 'super-message-composer-surface',
        );
        final surface = tester.getRect(surfaceKey);
        final field = tester.getRect(
          key(thread ? 'super-thread-composer' : 'super-message-composer'),
        );
        final plus = glyph(
          tester,
          find.descendant(of: surfaceKey, matching: key('new-harness-attach')),
          AppIcons.plus,
        );
        final tag = glyph(
          tester,
          key(thread ? 'super-thread-tag' : 'super-composer-tag'),
          AppIcons.atSign,
        );
        final mic = glyph(
          tester,
          key(thread ? 'super-thread-mic' : 'super-composer-mic'),
          AppIcons.mic,
        );
        final send = glyph(
          tester,
          find.byTooltip(thread ? 'Send reply' : 'Send message'),
          AppIcons.arrowUp,
        );

        expect(field.top - surface.top, closeTo(top, .5), reason: 'top');
        expect(field.left - surface.left, closeTo(side, .5), reason: 'left');
        expect(surface.right - field.right, closeTo(side, .5), reason: 'right');
        // The + under the text's first letter, the arrow at the text's right
        // edge, and the mic as far from the arrow as @ is from +.
        expect(plus.left, closeTo(field.left, .5), reason: '+ edge');
        expect(surface.right - send.right, closeTo(side, .5), reason: 'send');
        expect(
          send.left - mic.right,
          closeTo(tag.left - plus.right, .5),
          reason: 'mic and send spacing',
        );
        if (!phone) {
          // Desktop's 32pt targets: the row's air, then the arrow as far up
          // from the bottom as the text is down from the top. A phone's 44pt
          // targets take what they need.
          final glyphInTarget =
              (grid.AppControl.height - AppIcons.inlineSize) / 2;
          expect(
            plus.top - field.bottom,
            closeTo(rowGap + glyphInTarget, .5),
            reason: 'row gap',
          );
          expect(surface.bottom - send.bottom, closeTo(top, .5));
        }
        final box = tester.widget<DecoratedBox>(surfaceKey).decoration;
        expect(
          (box as BoxDecoration).borderRadius,
          BorderRadius.circular(radius),
        );
        await tester.pumpWidget(const SizedBox());
        await c.flush();
      });
    }
  }
}
