import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/composer_toggle.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/super_tabs/pane_layout.dart';
import 'package:harness/super_tabs/thread_panel.dart';

import 'box_render_preview_test.dart' show loadPreviewFonts;
import 'support/super_tab_fixture.dart';

/// The thread reply box's options (Scholes, 10-31): one row, options left and
/// attach and send right; Also send names where it posts, shortened only
/// where the pane is too narrow; both options read as on/off choices, with a
/// one-line hover hint.
void main() {
  // The Mac's own face, where there is one: what the default width is chosen
  // for. Every other test here measures whatever face it draws in.
  final systemFace = File('/System/Library/Fonts/SFNS.ttf').existsSync();
  setUpAll(() async {
    if (!systemFace) return;
    try {
      await loadPreviewFonts();
    } catch (_) {
      // Icons from another pub cache: the text face is what counts here.
    }
  });

  final newSession = find.byKey(const ValueKey('super-thread-new-session'));
  final alsoSend = find.byKey(const ValueKey('super-thread-also-send'));
  final send = find.byKey(const ValueKey('super-thread-send'));
  final surface = find.byKey(const ValueKey('super-thread-composer-surface'));
  final note = find.byKey(const ValueKey('super-thread-session-note'));

  late SuperTabController shown;

  void testBox(
    String description,
    Future<void> Function(WidgetTester) body, {
    bool skip = false,
  }) => testWidgets(description, (tester) async {
    await body(tester);
    await tester.pumpWidget(const SizedBox());
    await shown.flush();
  }, skip: skip);

  /// A project chat ('lead', named "Pilot") with a thread on message-1.
  ConversationServer projectChat() {
    final server = ConversationServer()..threads = true;
    server.append('Should we do thread replies?');
    server.append('Yes, like Slack.');
    server.messages.last
      ..['thread'] = 'message-1'
      ..['replyTo'] = 'message-1';
    return server;
  }

  /// The reader's own Buddy chat ('offline') with their Buddy running and a
  /// thread on message-1; New session is offered unless [sessions] is false.
  ConversationServer buddyChat({bool sessions = true}) {
    final server = ConversationServer()..threads = true;
    if (sessions) server.state['threadSessions'] = true;
    (server.state['conversations'] as List)[1] as Map
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
    server.append('On it', conversationId: 'offline');
    server.messages.last
      ..['thread'] = 'message-1'
      ..['replyTo'] = 'message-1';
    return server;
  }

  /// The thread pane alone, [width] wide, at [textScale].
  Future<SuperTabController> panel(
    WidgetTester tester,
    ConversationServer server,
    String conversation, {
    double width = SuperTabPaneLayout.threadWidth,
    double textScale = 1,
  }) async {
    await tester.binding.setSurfaceSize(const Size(1400, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final c = shown = server.controller();
    await c.refresh();
    await c.select(conversation);
    c.openThread('message-1');
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.light),
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(context)
              .copyWith(textScaler: TextScaler.linear(textScale)),
          child: child!,
        ),
        home: Scaffold(
          body: Align(
            alignment: Alignment.topLeft,
            child: SizedBox(
              width: width,
              height: 600,
              child: SuperTabThreadPanel(
                controller: c,
                root: 'message-1',
                row: (SuperTabMessage m, bool _) => Text(m.text),
                outgoing: (_) => const SizedBox(),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    return c;
  }

  SuperTabComposerToggle box(WidgetTester tester, Finder finder) =>
      tester.widget<SuperTabComposerToggle>(finder);

  /// The circle (off) or check (on) inside [chip], drawn inside its bounds.
  void expectMark(WidgetTester tester, Finder chip, {required bool on}) {
    final mark = find.descendant(
      of: chip,
      matching: find.byKey(
        ValueKey(on ? 'composer-toggle-check' : 'composer-toggle-off'),
      ),
    );
    expect(mark, findsOneWidget);
    final rect = tester.getRect(mark), bounds = tester.getRect(chip);
    expect(rect.width, greaterThan(0));
    expect(bounds.contains(rect.center), isTrue);
    expect(rect.right, lessThanOrEqualTo(bounds.right));
  }

  /// Every option sits on the send button's row, vertically centred with it,
  /// left of attach and send, inside the box.
  void expectOneRow(WidgetTester tester, List<Finder> chips) {
    final sendRect = tester.getRect(send);
    final box = tester.getRect(surface);
    double? right;
    for (final chip in chips) {
      final rect = tester.getRect(chip);
      expect((rect.center.dy - sendRect.center.dy).abs(), lessThan(1));
      expect(rect.right, lessThan(sendRect.left));
      expect(rect.left, greaterThanOrEqualTo(box.left));
      if (right != null) expect(rect.left, greaterThan(right));
      right = rect.right;
    }
  }

  group('Also send names where it posts', () {
    testBox('a project thread names the project chat in full', (tester) async {
      await panel(tester, projectChat(), 'lead', width: 800);
      expect(box(tester, alsoSend).label, 'Also post to #Pilot');
      expect(
        find.byTooltip('Also post to #Pilot as well as this thread'),
        findsOneWidget,
      );
      expectOneRow(tester, [alsoSend]);
    });

    testBox('a Buddy thread with room says the main chat in full, beside '
        'New session', (tester) async {
      await panel(tester, buddyChat(), 'offline', width: 800);
      expect(box(tester, alsoSend).label, 'Also post to the main chat');
      expect(
        find.byTooltip('Also post to the main chat as well as this thread'),
        findsOneWidget,
      );
      expectOneRow(tester, [newSession, alsoSend]);
    });

    /// The width the send row's options have in a thread pane [pane] wide:
    /// the pane less the box's insets and attach and send, as laid out.
    double Function(double pane) roomIn(WidgetTester tester) {
      final sendRow = tester.getRect(
        find.byKey(const ValueKey('new-harness-attach')),
      );
      final box = tester.getRect(surface);
      final pane = tester.getRect(find.byType(SuperTabThreadPanel));
      // The rim is drawn, not laid out: the options start 16 in.
      final insets = pane.width - (sendRow.left - box.left - 16);
      return (width) => width - insets;
    }

    double widthOf(WidgetTester tester, String label) =>
        SuperTabComposerToggle.widthOf(tester.element(alsoSend), label);

    for (final (kind, full, short) in [
      ('project', 'Also post to #Pilot', 'Also to #Pilot'),
      ('Buddy', 'Also post to the main chat', 'Also to chat'),
    ]) {
      testBox('a $kind thread steps down to "$short" where "$full" has no '
          'room, never shorter: below that the label ends in "…" and its '
          'circle shows', (tester) async {
        final buddy = kind == 'Buddy';
        ConversationServer server() => buddy ? buddyChat() : projectChat();
        final conversation = buddy ? 'offline' : 'lead';
        await panel(tester, server(), conversation, width: 800);
        final room = roomIn(tester);
        final beside = buddy ? widthOf(tester, 'New session') + 4 : 0.0;
        final fullFits = widthOf(tester, full) + beside;
        final shortFits = widthOf(tester, short) + beside;
        double paneFor(double needed) => 800 - room(800) + needed;
        await tester.pumpWidget(const SizedBox());
        await shown.flush();

        for (final (pane, label) in [
          (paneFor(fullFits) + 1, full),
          (paneFor(fullFits) - 1, short),
          (paneFor(shortFits) + 1, short),
          (paneFor(shortFits) - 12, short),
        ]) {
          await panel(tester, server(), conversation, width: pane);
          expect(box(tester, alsoSend).label, label, reason: 'at $pane');
          expect(
            find.byTooltip('$full as well as this thread'),
            findsOneWidget,
          );
          if (buddy) expect(box(tester, newSession).label, 'New session');
          expectOneRow(tester, [if (buddy) newSession, alsoSend]);
          expectMark(tester, alsoSend, on: false);
          if (buddy) expectMark(tester, newSession, on: false);
          expect(tester.takeException(), isNull);
          await tester.pumpWidget(const SizedBox());
          await shown.flush();
        }
      });
    }
  });

  group('the options read as on/off choices', () {
    testBox('off is an empty circle, on a check; tapping toggles it', (
      tester,
    ) async {
      await panel(tester, projectChat(), 'lead', width: 800);
      expect(box(tester, alsoSend).on, isFalse);
      expectMark(tester, alsoSend, on: false);
      bool? toggled() => tester
          .widget<Semantics>(
            find
                .descendant(of: alsoSend, matching: find.byType(Semantics))
                .first,
          )
          .properties
          .toggled;
      expect(toggled(), isFalse);

      await tester.tap(alsoSend);
      await tester.pump();
      expect(box(tester, alsoSend).on, isTrue);
      expectMark(tester, alsoSend, on: true);
      expect(toggled(), isTrue);

      await tester.tap(alsoSend);
      await tester.pump();
      expect(box(tester, alsoSend).on, isFalse);
      expectMark(tester, alsoSend, on: false);
    });

    testBox('New session reads the same way, and while on it hides Also '
        'send and shows the note; the box never moves', (tester) async {
      await panel(tester, buddyChat(), 'offline');
      final before = tester.getRect(surface);
      expectMark(tester, newSession, on: false);
      expect(
        find.byTooltip('Starts a separate Buddy session for this thread'),
        findsOneWidget,
      );

      await tester.tap(alsoSend);
      await tester.pump();
      expect(tester.getRect(surface), before);

      await tester.tap(newSession);
      await tester.pump();
      expectMark(tester, newSession, on: true);
      expect(alsoSend, findsNothing);
      expect(
        tester
            .widget<Visibility>(
              find.ancestor(of: note, matching: find.byType(Visibility)),
            )
            .visible,
        isTrue,
      );
      expect(tester.getRect(surface), before);

      await tester.tap(newSession);
      await tester.pump();
      expect(alsoSend, findsOneWidget);
      expect(tester.getRect(surface), before);
    });
  });

  group('one row at any width and text size', () {
    for (final (width, scale) in [
      (SuperTabPaneLayout.threadWidth, 1.0),
      // The pane's minimum grows with the text (pane_layout.dart).
      (SuperTabPaneLayout.rightWidth * 1.6, 1.6),
      (SuperTabPaneLayout.rightWidth * 2, 2.0),
      // A window too narrow for the thread's default: "…", the marks stay.
      (SuperTabPaneLayout.rightWidth, 1.0),
      // Narrower than the app allows.
      (SuperTabPaneLayout.rightWidth, 2.0),
    ]) {
      testBox('${width.round()}px at ${scale}x: one row, no overflow, both '
          'marks showing', (tester) async {
        await panel(
          tester,
          buddyChat(),
          'offline',
          width: width,
          textScale: scale,
        );
        expect(tester.takeException(), isNull);
        expectOneRow(tester, [newSession, alsoSend]);
        expectMark(tester, newSession, on: false);
        expectMark(tester, alsoSend, on: false);
        // One line each: the same top and height, never wrapped below.
        final a = tester.getRect(newSession), b = tester.getRect(alsoSend);
        expect(a.top, b.top);
        expect(a.height, b.height);
      });
    }

    testBox('a project thread in a wide pane keeps its row with only Also '
        'send', (tester) async {
      await panel(tester, projectChat(), 'lead', width: 800);
      expect(newSession, findsNothing);
      expectOneRow(tester, [alsoSend]);
    });
  });

  testBox('at the thread\'s default width, in the Mac\'s face, a Buddy '
      'thread fits "New session" and "Also to chat" with no "…", and a '
      'project thread names #openharness in full', (tester) async {
    await panel(tester, buddyChat(), 'offline');
    expect(box(tester, newSession).label, 'New session');
    expect(box(tester, alsoSend).label, 'Also to chat');
    for (final (chip, label) in [
      (newSession, 'New session'),
      (alsoSend, 'Also to chat'),
    ]) {
      final text = find.descendant(of: chip, matching: find.text(label));
      final paragraph = tester.renderObject<RenderParagraph>(text);
      expect(paragraph.didExceedMaxLines, isFalse, reason: label);
      expect(
        paragraph.size.width,
        greaterThanOrEqualTo(paragraph.getMaxIntrinsicWidth(100) - .5),
        reason: label,
      );
    }
    await tester.pumpWidget(const SizedBox());
    await shown.flush();

    final project = projectChat();
    project.state['name'] = 'openharness';
    await panel(tester, project, 'lead');
    expect(box(tester, alsoSend).label, 'Also post to #openharness');
  }, skip: !systemFace);
}
