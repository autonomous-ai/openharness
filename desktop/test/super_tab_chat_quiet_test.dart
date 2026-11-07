import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_icons.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/harness_attachments.dart';
import 'package:harness/super_tabs/avatar_art.dart';
import 'package:harness/super_tabs/message_row.dart';
import 'package:harness/widgets/desktop_chrome.dart';

import 'super_tab_mentions_test.dart' show showView;
import 'support/super_tab_fixture.dart';

/// Task #4467 (anh Dee, 11-07 15:35): the Swarm chat, quiet. Round faces at 28, the name in semibold, the time in
/// 12 tertiary, text at 14, and a composer that matches Cmd-N.
void main() {
  group('a message row', () {
    /// A person, an agent in the Swarm, and an agent that has left, one message each.
    ConversationServer server() {
      final server = ConversationServer();
      (server.state['agents'] as List).add({
        'id': 'pm',
        'name': 'Lead',
        'displayName': 'River',
        'machineId': 'mac',
        'harnessId': 'h-pm',
        'contributorId': 'owner',
        'configuration': {'engine': 'claude'},
      });
      server.append('From a person');
      server.append('From an agent', agent: true);
      server.messages.last['author'] = {
        'kind': 'agent',
        'id': 'pm',
        'name': 'Lead',
      };
      server.append('From a person again');
      server.append('From an agent that left', agent: true);
      return server;
    }

    for (final brightness in Brightness.values) {
      testWidgets('draws every sender as a round face at 28 '
          '(${brightness.name})', (tester) async {
        await showView(tester, server(), brightness: brightness);
        final faces = find.descendant(
          of: find.byType(SuperTabMessageRow),
          matching: find.byType(SuperTabAvatarFace),
        );
        expect(faces, findsNWidgets(4));
        for (final face in faces.evaluate()) {
          final widget = face.widget as SuperTabAvatarFace;
          expect(widget.radius, isNull, reason: 'round, not a rounded square');
          expect(tester.getSize(find.byWidget(widget)), const Size(28, 28));
        }
      });
    }
  });

  group('the composer, as Cmd-N draws its field', () {
    Finder key(String value) => find.byKey(ValueKey(value));

    /// The round send's fill inside [surface].
    BoxDecoration sendFill(WidgetTester tester, String surface) {
      final fill = find.descendant(
        of: key(surface),
        matching: key('swarm-send-fill'),
      );
      expect(tester.getSize(fill), const Size.square(28));
      final box = tester.widget<DecoratedBox>(fill);
      final decoration = box.decoration as BoxDecoration;
      expect(decoration.shape, BoxShape.circle);
      return decoration;
    }

    void expectNeutral(BoxDecoration fill) =>
        expect(fill.color, DesktopChrome.rim, reason: 'neutral while empty');
    void expectBlue(BoxDecoration fill) =>
        expect(fill.color, grid.AppPalette.accent, reason: 'blue to send');

    /// The box is one rounded field: radius 12, a hairline, the faint fill.
    void expectField(WidgetTester tester, String surface) {
      final box = tester.widget<DecoratedBox>(key(surface));
      final decoration = box.decoration as BoxDecoration;
      expect(decoration.borderRadius, BorderRadius.circular(12));
      expect(decoration.border, Border.all(color: DesktopChrome.rim));
      expect(decoration.color, DesktopChrome.field);
      expect(
        find.descendant(
          of: key(surface),
          matching: find.descendant(
            of: key('new-harness-attach'),
            matching: find.byIcon(AppIcons.paperclip),
          ),
        ),
        findsOneWidget,
      );
    }

    for (final brightness in Brightness.values) {
      testWidgets('the main chat: a paperclip, and send turns blue for text '
          'or a file (${brightness.name})', (tester) async {
        final c = await showView(
          tester,
          ConversationServer(),
          brightness: brightness,
        );
        const surface = 'super-message-composer-surface';
        expectField(tester, surface);
        expectNeutral(sendFill(tester, surface));

        await tester.enterText(key('super-message-composer'), 'Ship it');
        await tester.pump();
        expectBlue(sendFill(tester, surface));

        await tester.enterText(key('super-message-composer'), '');
        await tester.pump();
        expectNeutral(sendFill(tester, surface));

        c.attachments('lead').add([
          HarnessAttachment('a.png', Uint8List.fromList([1, 2, 3])),
        ]);
        await tester.pump();
        expectBlue(sendFill(tester, surface));
        c.attachments('lead').clear();
        // The typed draft's save waits on a timer: let it run.
        await tester.pumpWidget(const SizedBox());
        await c.flush();
      });

      testWidgets('a thread\'s reply box is drawn the same '
          '(${brightness.name})', (tester) async {
        final server = ConversationServer()..threads = true;
        server.append('Should we do thread replies?');
        server.append('Yes, like Slack.');
        server.messages.last
          ..['thread'] = 'message-1'
          ..['replyTo'] = 'message-1';
        final c = await showView(tester, server, brightness: brightness);
        c.openThread('message-1');
        await tester.pumpAndSettle();
        const surface = 'super-thread-composer-surface';
        expectField(tester, surface);
        expectNeutral(sendFill(tester, surface));

        await tester.enterText(key('super-thread-composer'), 'Agreed');
        await tester.pump();
        expectBlue(sendFill(tester, surface));
        await tester.pumpWidget(const SizedBox());
        await c.flush();
      });
    }
  });
}
