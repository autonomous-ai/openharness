import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shared/widgets/app_icon_button.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/message_link.dart';
import 'package:harness/super_tabs/message_row.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/super_tab_fixture.dart';

void main() {
  late SuperTabController c;

  Future<void> show(
    WidgetTester tester,
    ConversationServer server, {
    Brightness brightness = Brightness.dark,
  }) async {
    await tester.binding.setSurfaceSize(const Size(1200, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    c = server.controller();
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
  }

  ConversationServer chat(int count) {
    final server = ConversationServer();
    for (var i = 1; i <= count; i++) {
      server.append('Note $i');
    }
    return server;
  }

  SwarmMessageLink linkTo(String messageId, {String conversation = 'lead'}) =>
      SwarmMessageLink(
        tabId: 'tab',
        conversationId: conversation,
        messageId: messageId,
      );

  Finder row(String id) => find.byKey(ValueKey('super-message-$id'));
  Finder more(String id) => find.descendant(
    of: row(id),
    matching: find.byKey(ValueKey('super-message-more-$id')),
  );
  Finder note(String text) =>
      find.descendant(of: find.byType(SnackBar), matching: find.text(text));
  bool highlighted(WidgetTester tester, String id) => tester
      .widget<SuperTabMessageHighlight>(
        find.ancestor(
          of: row(id),
          matching: find.byType(SuperTabMessageHighlight),
        ),
      )
      .on;

  Future<void> hover(WidgetTester tester, String id) async {
    final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
    await mouse.addPointer(location: Offset.zero);
    addTearDown(mouse.removePointer);
    await mouse.moveTo(tester.getCenter(row(id)));
    await tester.pumpAndSettle();
  }

  group('More menu', () {
    testWidgets('the hover bar has More, with Copy link to message', (
      tester,
    ) async {
      await show(tester, chat(3));
      await hover(tester, 'message-3');
      expect(more('message-3'), findsOneWidget);
      await tester.tap(more('message-3'));
      await tester.pumpAndSettle();
      expect(find.text('Copy link to message'), findsOneWidget);
    });

    testWidgets('Copy link to message copies this message’s link', (
      tester,
    ) async {
      String? copied;
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        (call) async {
          if (call.method == 'Clipboard.setData') {
            copied = (call.arguments as Map)['text'] as String;
          }
          return null;
        },
      );
      addTearDown(
        () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          SystemChannels.platform,
          null,
        ),
      );
      await show(tester, chat(3));
      await hover(tester, 'message-2');
      await tester.tap(more('message-2'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Copy link to message'));
      await tester.pumpAndSettle();
      expect(copied, 'harness://swarm/tab/lead/message-2');
      expect(note('Link copied'), findsOneWidget);
      // The menu closes after a choice.
      expect(find.text('Copy link to message'), findsNothing);
    });

    testWidgets('More comes after Copy in the hover bar, as the last stop', (
      tester,
    ) async {
      await show(tester, chat(3));
      await hover(tester, 'message-3');
      final copy = tester.getTopLeft(
        find.descendant(
          of: row('message-3'),
          matching: find.byTooltip('Copy message'),
        ),
      );
      expect(tester.getTopLeft(more('message-3')).dx, greaterThan(copy.dx));
    });
  });

  group('keyboard', () {
    testWidgets('Escape closes the menu and returns focus to More', (
      tester,
    ) async {
      await show(tester, chat(3));
      await hover(tester, 'message-3');
      await tester.tap(more('message-3'));
      await tester.pumpAndSettle();
      expect(find.text('Copy link to message'), findsOneWidget);
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      expect(find.text('Copy link to message'), findsNothing);
      final focus = FocusManager.instance.primaryFocus;
      expect(focus?.debugLabel, 'Swarm message More');
    });

    testWidgets('opened by the pointer, no choice is focused', (tester) async {
      await show(tester, chat(3));
      await hover(tester, 'message-3');
      await tester.tap(more('message-3'));
      await tester.pumpAndSettle();
      expect(
        FocusManager.instance.primaryFocus?.debugLabel,
        isNot('Swarm message More first choice'),
      );
    });

    testWidgets('the menu’s item is reached and chosen from the keyboard', (
      tester,
    ) async {
      String? copied;
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        (call) async {
          if (call.method == 'Clipboard.setData') {
            copied = (call.arguments as Map)['text'] as String;
          }
          return null;
        },
      );
      addTearDown(
        () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          SystemChannels.platform,
          null,
        ),
      );
      await show(tester, chat(3));
      await hover(tester, 'message-3');
      tester
          .widget<AppIconButton>(
            find.descendant(
              of: more('message-3'),
              matching: find.byType(AppIconButton),
            ),
          )
          .focusNode!
          .requestFocus();
      await tester.pump();
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(find.text('Copy link to message'), findsOneWidget);
      expect(
        FocusManager.instance.primaryFocus?.debugLabel,
        'Swarm message More first choice',
      );
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(copied, 'harness://swarm/tab/lead/message-3');
    });
  });

  group('opening a link', () {
    testWidgets('a loaded message comes into view, lit', (tester) async {
      await show(tester, chat(60));
      expect(row('message-1').hitTestable(), findsNothing);
      expect(c.openMessageLink(linkTo('message-1')), isTrue);
      await tester.pumpAndSettle();
      expect(row('message-1').hitTestable(), findsOneWidget);
      expect(highlighted(tester, 'message-1'), isTrue);
      await tester.pump(const Duration(seconds: 3));
      await tester.pumpAndSettle();
      expect(highlighted(tester, 'message-1'), isFalse);
    });

    testWidgets('an older message reads earlier pages until it is there', (
      tester,
    ) async {
      final server = chat(250);
      await show(tester, server);
      expect(find.text('Note 10'), findsNothing);
      c.openMessageLink(linkTo('message-10'));
      await tester.pumpAndSettle();
      expect(row('message-10').hitTestable(), findsOneWidget);
      expect(highlighted(tester, 'message-10'), isTrue);
    });

    testWidgets('a link to another conversation opens it at the message', (
      tester,
    ) async {
      final server = chat(3)..append('Offline note', conversationId: 'offline');
      await show(tester, server);
      expect(c.selectedId, 'lead');
      c.openMessageLink(linkTo('message-4', conversation: 'offline'));
      await tester.pumpAndSettle();
      expect(c.selectedId, 'offline');
      expect(row('message-4').hitTestable(), findsOneWidget);
    });

    testWidgets('an archived conversation opens to read', (tester) async {
      final server = chat(3)..append('Old note', conversationId: 'offline');
      (server.state['conversations'] as List)
              .cast<Map<String, dynamic>>()
              .firstWhere((g) => g['id'] == 'offline')['archived'] =
          true;
      await show(tester, server);
      c.openMessageLink(linkTo('message-4', conversation: 'offline'));
      await tester.pumpAndSettle();
      expect(c.selectedId, 'offline');
      expect(find.text('Old note'), findsOneWidget);
    });

    testWidgets('a conversation the reader cannot read says unavailable only', (
      tester,
    ) async {
      final server = chat(3);
      await show(tester, server);
      c.openMessageLink(linkTo('message-9', conversation: 'private-chat'));
      await tester.pumpAndSettle();
      expect(note('Message unavailable'), findsOneWidget);
      expect(c.selectedId, 'lead');
    });

    testWidgets('a message the conversation no longer has says unavailable', (
      tester,
    ) async {
      await show(tester, chat(3));
      c.openMessageLink(linkTo('message-404'));
      await tester.pumpAndSettle();
      expect(note('Message unavailable'), findsOneWidget);
      expect(c.selectedId, 'lead');
    });

    testWidgets('a link to another Swarm is not taken', (tester) async {
      await show(tester, chat(3));
      final other = SwarmMessageLink(
        tabId: 'another-tab',
        conversationId: 'lead',
        messageId: 'message-1',
      );
      expect(c.openMessageLink(other), isFalse);
      await tester.pumpAndSettle();
      expect(c.messageRequest, isNull);
    });
  });

  group('a pasted link', () {
    testWidgets('previews a message the reader can read, and opens it', (
      tester,
    ) async {
      final server = chat(60)..append('See ${linkTo('message-1').url}');
      await show(tester, server);
      final preview = find.byKey(
        const ValueKey('super-message-link-preview-message-1'),
      );
      expect(preview, findsOneWidget);
      expect(
        find.descendant(of: preview, matching: find.text('Note 1')),
        findsOneWidget,
      );
      await tester.tap(preview);
      await tester.pumpAndSettle();
      expect(row('message-1').hitTestable(), findsOneWidget);
      expect(highlighted(tester, 'message-1'), isTrue);
    });

    testWidgets('previews an older message after reading it by itself', (
      tester,
    ) async {
      final server = chat(250)..append('See ${linkTo('message-3').url}');
      await show(tester, server);
      expect(
        find.descendant(
          of: find.byKey(
            const ValueKey('super-message-link-preview-message-3'),
          ),
          matching: find.text('Note 3'),
        ),
        findsOneWidget,
      );
    });

    testWidgets('says Message unavailable, and nothing else, if unreadable', (
      tester,
    ) async {
      final reads = <String>[];
      final server = chat(2)
        ..onRead = reads.add
        ..append('See ${linkTo('message-9', conversation: 'secret').url}');
      await show(tester, server);
      final preview = find.byKey(
        const ValueKey('super-message-link-preview-message-9'),
      );
      expect(
        find.descendant(
          of: preview,
          matching: find.text('Message unavailable'),
        ),
        findsOneWidget,
      );
      // The backend was asked who may read it; no message of it was fetched.
      expect(reads.where((p) => p.contains('secret/messages')), isEmpty);
      await tester.tap(preview, warnIfMissed: false);
      await tester.pumpAndSettle();
      expect(c.selectedId, 'lead');
    });

    testWidgets('a closed conversation previews once the backend allows it', (
      tester,
    ) async {
      final server = chat(2)..append('Old note', conversationId: 'offline');
      (server.state['conversations'] as List)
              .cast<Map<String, dynamic>>()
              .firstWhere((g) => g['id'] == 'offline')['archived'] =
          true;
      server.append('See ${linkTo('message-3', conversation: 'offline').url}');
      await show(tester, server);
      expect(
        find.descendant(
          of: find.byKey(
            const ValueKey('super-message-link-preview-message-3'),
          ),
          matching: find.text('Old note'),
        ),
        findsOneWidget,
      );
    });

    testWidgets('a link to another Swarm previews as unavailable too', (
      tester,
    ) async {
      final server = chat(2)
        ..append('See harness://swarm/another-tab/lead/message-1');
      await show(tester, server);
      expect(
        find.descendant(
          of: find.byKey(
            const ValueKey('super-message-link-preview-message-1'),
          ),
          matching: find.text('Message unavailable'),
        ),
        findsOneWidget,
      );
    });

    testWidgets('a link in code stays text, with no preview', (tester) async {
      final server = chat(2)..append('Try `${linkTo('message-1').url}`');
      await show(tester, server);
      expect(
        find.byKey(const ValueKey('super-message-link-preview-message-1')),
        findsNothing,
      );
    });
  });
}
