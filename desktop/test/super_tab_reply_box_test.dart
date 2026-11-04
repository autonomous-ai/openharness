import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_icons.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/composer_toggle.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/super_tabs/pane_layout.dart';
import 'package:harness/super_tabs/thread_panel.dart';
import 'package:harness/widgets/desktop_chrome.dart';

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

  /// The empty square (off) or checked square (on) inside [chip], drawn
  /// inside its bounds: a checkbox, never a radio's circle (Scholes, 11-03).
  void expectMark(WidgetTester tester, Finder chip, {required bool on}) {
    final mark = find.descendant(
      of: chip,
      matching: find.byKey(
        ValueKey(on ? 'composer-toggle-check' : 'composer-toggle-off'),
      ),
    );
    expect(mark, findsOneWidget);
    expect(
      tester.widget<Icon>(mark).icon,
      on ? AppIcons.squareCheck : AppIcons.square,
    );
    final rect = tester.getRect(mark), bounds = tester.getRect(chip);
    expect(rect.width, greaterThan(0));
    expect(bounds.contains(rect.center), isTrue);
    expect(rect.right, lessThanOrEqualTo(bounds.right));
  }

  /// Every option sits on the send button's row, vertically centred with it,
  /// left of send, inside the box.
  void expectOneRow(WidgetTester tester, List<Finder> chips) {
    final sendRect = tester.getRect(send);
    final box = tester.getRect(surface);
    double? right;
    for (final chip in chips) {
      final rect = tester.getRect(chip);
      expect((rect.center.dy - sendRect.center.dy).abs(), lessThan(1));
      // Never past send: in a pane narrower than the app allows, New session
      // ends in "…" against it.
      expect(rect.right, lessThanOrEqualTo(sendRect.left));
      expect(rect.left, greaterThanOrEqualTo(box.left));
      if (right != null) expect(rect.left, greaterThan(right));
      right = rect.right;
    }
  }

  final alsoLine = find.byKey(const ValueKey('super-thread-also-line'));

  /// [label] drawn whole inside [chip]: one line, no "…".
  void expectWhole(WidgetTester tester, Finder chip, String label) {
    final text = find.descendant(of: chip, matching: find.text(label));
    final paragraph = tester.renderObject<RenderParagraph>(text);
    expect(paragraph.didExceedMaxLines, isFalse, reason: label);
    expect(
      paragraph.size.width,
      greaterThanOrEqualTo(paragraph.getMaxIntrinsicWidth(100) - .5),
      reason: label,
    );
  }

  /// Also send's [label] on its line under the box: whole where the face
  /// drawn has room for it (the Mac's face at every width the app allows, the
  /// screenshots show); in a face too wide for that (the test font on Linux
  /// CI), it ends in "…" there and nothing overflows.
  void expectWholeUnderBox(WidgetTester tester, String label) {
    final text = find.descendant(of: alsoSend, matching: find.text(label));
    final paragraph = tester.renderObject<RenderParagraph>(text);
    if (!paragraph.didExceedMaxLines) expectWhole(tester, alsoSend, label);
    expect(
      tester.getRect(alsoSend).right,
      lessThanOrEqualTo(tester.getRect(surface).right),
    );
  }

  /// Also send on its own line under the box, its square under the send
  /// row's first one, not on the send row.
  void expectUnderBox(WidgetTester tester) {
    expect(alsoLine, findsOneWidget);
    expect(find.descendant(of: alsoLine, matching: alsoSend), findsOneWidget);
    final rect = tester.getRect(alsoSend), box = tester.getRect(surface);
    expect(rect.top, greaterThanOrEqualTo(box.bottom));
    final mark = tester.getRect(
      find
          .descendant(
            of: alsoSend,
            matching: find.byKey(const ValueKey('composer-toggle-off')),
          )
          .hitTestable(),
    );
    // Under the send row's first square: the options start 16 in, and the
    // control's own padding is 6.
    expect((mark.left - (box.left + 16 + 6)).abs(), lessThan(.5));
    expect(rect.right, lessThanOrEqualTo(box.right));
  }

  // Huy and Scholes, 11-04: Also send is a small checkbox on its own line
  // under the box, as in Slack, never on the send row; its wording in full
  // (Scholes, 11-03: "Also to chat" did not say where the reply goes).
  group('Also send names where it posts', () {
    for (final (kind, full, short) in [
      ('project', 'Also send to #Pilot', 'Also to #Pilot'),
      ('Buddy', 'Also send to the main chat', 'Also to chat'),
    ]) {
      testBox('a $kind thread says "$full" on its own line under the box, at '
          'every width', (tester) async {
        final buddy = kind == 'Buddy';
        ConversationServer server() => buddy ? buddyChat() : projectChat();
        final conversation = buddy ? 'offline' : 'lead';
        for (final pane in [
          800.0,
          SuperTabPaneLayout.threadWidth,
          SuperTabPaneLayout.rightWidth,
        ]) {
          await panel(tester, server(), conversation, width: pane);
          expect(box(tester, alsoSend).label, full, reason: 'at $pane');
          expect(find.text(short), findsNothing);
          expect(
            find.byTooltip('$full as well as this thread'),
            findsOneWidget,
          );
          expectUnderBox(tester);
          if (pane == 800) {
            expectWhole(tester, alsoSend, full);
          } else {
            expectWholeUnderBox(tester, full);
          }
          if (buddy) {
            expect(box(tester, newSession).label, 'New session');
            expectOneRow(tester, [newSession]);
            expectMark(tester, newSession, on: false);
          }
          expectMark(tester, alsoSend, on: false);
          expect(tester.takeException(), isNull);
          await tester.pumpWidget(const SizedBox());
          await shown.flush();
        }
      });
    }
  });

  group('the options read as on/off choices', () {
    // Scholes, 11-03: an outlined pill with a circle read as a radio, so New
    // session and Also send looked like an either-or choice.
    testBox('a checkbox with no pill around it, off or on', (tester) async {
      await panel(tester, projectChat(), 'lead', width: 800);
      DesktopPill pill() => tester.widget<DesktopPill>(
        find.descendant(of: alsoSend, matching: find.byType(DesktopPill)),
      );
      expect(pill().quiet, isTrue);
      expect(pill().choice, isFalse);
      expect(pill().selected, isNull);
      await tester.tap(alsoSend);
      await tester.pump();
      expectMark(tester, alsoSend, on: true);
      expect(pill().quiet, isTrue);
      expect(pill().selected, isNull);
    });

    testBox('a New session that can\'t start now is a greyed empty square', (
      tester,
    ) async {
      final server = buddyChat()..state['paused'] = true;
      await panel(tester, server, 'offline', width: 800);
      expectMark(tester, newSession, on: false);
      final mark = tester.widget<Icon>(
        find.descendant(
          of: newSession,
          matching: find.byKey(const ValueKey('composer-toggle-off')),
        ),
      );
      expect(mark.color!.a, lessThan(.5));
      expect(
        find.byTooltip('New work is paused in this Swarm'),
        findsOneWidget,
      );
    });

    testBox('off is an empty square, on a checked square; tapping toggles it', (
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
      // Hidden, its place kept.
      expect(alsoSend.hitTestable(), findsNothing);
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

  group('at any width and text size', () {
    for (final (width, scale) in [
      (SuperTabPaneLayout.threadWidth, 1.0),
      // The pane's minimum grows with the text (pane_layout.dart).
      (SuperTabPaneLayout.rightWidth * 1.6, 1.6),
      (SuperTabPaneLayout.rightWidth * 2, 2.0),
      (SuperTabPaneLayout.rightWidth, 1.0),
      // Narrower than the app allows: only here may the line under the box
      // end in "…".
      (SuperTabPaneLayout.rightWidth, 2.0),
    ]) {
      testBox('${width.round()}px at ${scale}x: no overflow, New session on '
          'the send row, both squares showing, Also send under the box', (
        tester,
      ) async {
        await panel(
          tester,
          buddyChat(),
          'offline',
          width: width,
          textScale: scale,
        );
        expect(tester.takeException(), isNull);
        expectOneRow(tester, [newSession]);
        expectMark(tester, newSession, on: false);
        expectMark(tester, alsoSend, on: false);
        expect(box(tester, alsoSend).label, 'Also send to the main chat');
        expectUnderBox(tester);
        expectWholeUnderBox(tester, 'Also send to the main chat');
      });
    }

    testBox('a project thread in a wide pane has no New session, and Also '
        'send under the box', (tester) async {
      await panel(tester, projectChat(), 'lead', width: 800);
      expect(newSession, findsNothing);
      expectUnderBox(tester);
    });

    testBox('in the narrow layout, turning New session on and off never moves '
        'the box', (tester) async {
      await panel(
        tester,
        buddyChat(),
        'offline',
        width: SuperTabPaneLayout.rightWidth,
      );
      expectUnderBox(tester);
      final before = tester.getRect(surface);
      final line = tester.getRect(alsoLine);
      await tester.tap(newSession);
      await tester.pump();
      // Hidden, its place kept.
      expect(alsoSend.hitTestable(), findsNothing);
      expect(tester.getRect(surface), before);
      // The note takes Also send's line: the two never show together, so no
      // empty band opens between the box and the note.
      expect(tester.getRect(note).top, lessThan(line.bottom));
      expect(tester.getRect(note).top, greaterThanOrEqualTo(before.bottom));
      await tester.tap(newSession);
      await tester.pump();
      expectUnderBox(tester);
      expect(tester.getRect(surface), before);
    });
  });

  // The row's order, then Also send under the box (Huy and Scholes, 11-04).
  for (final width in [800.0, SuperTabPaneLayout.rightWidth]) {
    testBox('Tab goes from the reply to +, @ Tag, New session, send and Also '
        'send at ${width.round()}px', (tester) async {
      await panel(tester, buddyChat(), 'offline', width: width);
      final order = [
        find.byKey(const ValueKey('new-harness-attach')),
        find.byKey(const ValueKey('super-thread-tag')),
        newSession,
        send,
        alsoSend,
      ];
      // Send takes focus only with something to send.
      await tester.enterText(
        find.byKey(const ValueKey('super-thread-composer')),
        'Ship it',
      );
      await tester.pump();
      for (final next in order) {
        await tester.sendKeyEvent(LogicalKeyboardKey.tab);
        await tester.pump();
        final focused = FocusManager.instance.primaryFocus!.context!;
        expect(
          find
              .descendant(
                of: next,
                matching: find.byElementPredicate((e) => e == focused),
              )
              .evaluate()
              .isNotEmpty,
          isTrue,
          reason: '$next at $width',
        );
      }
    });
  }

  testBox('at the thread\'s default width, in the Mac\'s face, a Buddy '
      'thread shows "New session" on the send row and "Also send to the main '
      'chat" whole under the box, and a project thread names #openharness in '
      'full under the box', (tester) async {
    await panel(tester, buddyChat(), 'offline');
    expectWhole(tester, newSession, 'New session');
    expectUnderBox(tester);
    expectWhole(tester, alsoSend, 'Also send to the main chat');
    await tester.pumpWidget(const SizedBox());
    await shown.flush();

    final project = projectChat();
    project.state['name'] = 'openharness';
    await panel(tester, project, 'lead');
    expect(box(tester, alsoSend).label, 'Also send to #openharness');
    expectUnderBox(tester);
    expectWhole(tester, alsoSend, 'Also send to #openharness');
  }, skip: !systemFace);
}
