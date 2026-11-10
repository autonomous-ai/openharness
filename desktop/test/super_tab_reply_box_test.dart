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

/// The thread reply box (Scholes, 10-31): attach and send on one row; Also
/// send under it names where it posts, shortened only where the pane is too
/// narrow, and reads as an on/off choice, with a one-line hover hint.
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

  final alsoSend = find.byKey(const ValueKey('super-thread-also-send'));
  final send = find.byKey(const ValueKey('super-thread-send'));
  final surface = find.byKey(const ValueKey('super-thread-composer-surface'));

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

  /// The reader's chat with their own agent ('offline'), running, and a
  /// thread on message-1.
  ConversationServer agentChat() {
    final server = ConversationServer()..threads = true;
    (server.state['conversations'] as List)[1] as Map
      ..['kind'] = 'agent-chat'
      ..['title'] = 'Wren'
      ..['agentIds'] = ['own-agent'];
    (server.state['agents'] as List).add({
      'id': 'own-agent',
      'name': 'Wren',
      'displayName': 'Wren',
      'machineId': 'mac',
      'harnessId': 'h-main',
      'contributorId': 'owner',
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
      ('agent', 'Also send to the main chat', 'Also to chat'),
    ]) {
      testBox('a $kind thread says "$full" on its own line under the box, at '
          'every width', (tester) async {
        final own = kind == 'agent';
        ConversationServer server() => own ? agentChat() : projectChat();
        final conversation = own ? 'offline' : 'lead';
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
          expectMark(tester, alsoSend, on: false);
          expect(tester.takeException(), isNull);
          await tester.pumpWidget(const SizedBox());
          await shown.flush();
        }
      });
    }
  });

  group('Also send reads as an on/off choice', () {
    // Scholes, 11-03: an outlined pill with a circle read as a radio.
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
      testBox('${width.round()}px at ${scale}x: no overflow, Also send under '
          'the box', (tester) async {
        await panel(
          tester,
          agentChat(),
          'offline',
          width: width,
          textScale: scale,
        );
        expect(tester.takeException(), isNull);
        expectMark(tester, alsoSend, on: false);
        expect(box(tester, alsoSend).label, 'Also send to the main chat');
        expectUnderBox(tester);
        expectWholeUnderBox(tester, 'Also send to the main chat');
      });
    }
  });

  // The row's order, then Also send under the box (Huy and Scholes, 11-04).
  for (final width in [800.0, SuperTabPaneLayout.rightWidth]) {
    testBox('Tab goes from the reply to the paperclip, send and Also send at '
        '${width.round()}px', (tester) async {
      await panel(tester, agentChat(), 'offline', width: width);
      final order = [
        find.byKey(const ValueKey('new-harness-attach')),
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

  testBox('at the thread\'s default width, in the Mac\'s face, an agent '
      'thread shows "Also send to the main chat" whole under the box, and a '
      'project thread names #openharness in full under the box', (
    tester,
  ) async {
    await panel(tester, agentChat(), 'offline');
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
