import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shared/widgets/app_menu.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/super_tab_fixture.dart';

/// Edit and delete your own message (task #2746, plan Task 2): the More menu
/// of the reader's own plain message offers Edit message and Delete message;
/// an edit shows "(edited)", a delete with replies leaves "This message was
/// deleted." and one without replies goes.
void main() {
  setUpAll(() async {
    if (Platform.environment['BUDDY_DELETE_SHOTS'] == null) return;
    final sf = ByteData.sublistView(
      await File('/System/Library/Fonts/SFNS.ttf').readAsBytes(),
    );
    for (final family in {
      '.AppleSystemUIFont',
      'Roboto',
      grid.AppFont.sans,
      ...grid.AppFont.sansFallback,
    }) {
      await (FontLoader(family)..addFont(Future.value(sf))).load();
    }
    final manifest =
        jsonDecode(await rootBundle.loadString('FontManifest.json')) as List;
    for (final entry in manifest.cast<Map>()) {
      final loader = FontLoader(entry['family'] as String);
      for (final font in (entry['fonts'] as List).cast<Map>()) {
        loader.addFont(rootBundle.load(font['asset'] as String));
      }
      await loader.load();
    }
  });

  final picture = GlobalKey();
  var brightness = Brightness.dark;

  Future<void> shot(WidgetTester tester, String platform) async {
    final folder = Platform.environment['BUDDY_DELETE_SHOTS'];
    if (folder == null) return;
    await tester.runAsync(() async {
      final boundary =
          picture.currentContext!.findRenderObject()! as RenderRepaintBoundary;
      final image = await boundary.toImage(pixelRatio: 1.5);
      final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
      await Directory(folder).create(recursive: true);
      await File('$folder/$platform-buddy-delete-${brightness.name}.png')
          .writeAsBytes(bytes!.buffer.asUint8List());
      image.dispose();
    });
  }

  late SuperTabController c;

  Future<void> show(
    WidgetTester tester,
    ConversationServer server, {
    String account = 'owner',
  }) async {
    await tester.binding.setSurfaceSize(const Size(1200, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    c = server.controller(account: account);
    await c.refresh();
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: brightness),
        builder: (context, child) =>
            RepaintBoundary(key: picture, child: child),
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

  Finder row(String id) => find.byKey(ValueKey('super-message-$id'));
  Finder more(String id) => find.descendant(
    of: row(id),
    matching: find.byKey(ValueKey('super-message-more-$id')),
  );
  Finder field(String id) => find.byKey(ValueKey('super-message-edit-$id'));

  // One mouse for a whole test, moved from row to row.
  TestGesture? mouse;
  setUp(() => mouse = null);

  Future<void> hover(WidgetTester tester, String id) async {
    if (mouse == null) {
      final added = mouse = await tester.createGesture(
        kind: PointerDeviceKind.mouse,
      );
      await added.addPointer(location: Offset.zero);
      addTearDown(added.removePointer);
    }
    await mouse!.moveTo(tester.getCenter(row(id)));
    await tester.pumpAndSettle();
  }

  Future<void> openMore(WidgetTester tester, String id) async {
    await hover(tester, id);
    await tester.tap(more(id));
    await tester.pumpAndSettle();
  }

  Future<void> choose(WidgetTester tester, String id, String label) async {
    await openMore(tester, id);
    await tester.tap(find.text(label));
    await tester.pumpAndSettle();
  }

  List<Map<String, dynamic>> changes(ConversationServer server) => [
    for (final post in server.posts)
      if (const {
        'message.edit',
        'message.delete',
      }.contains((post['command'] as Map)['type']))
        Map<String, dynamic>.from(post['command'] as Map),
  ];

  /// The reader's own message, an agent's and another person's.
  ConversationServer three() {
    final server = ConversationServer()
      ..append('My own words')
      ..append('An agent update', agent: true)
      ..append('Someone else');
    server.messages[2]['author'] = {
      'kind': 'person',
      'id': 'huy',
      'name': 'Huy',
    };
    return server;
  }

  testWidgets('the More menu of your own message offers Edit message and '
      'Delete message after a divider', (tester) async {
    await show(tester, three());
    await openMore(tester, 'message-1');
    expect(find.text('Edit message'), findsOneWidget);
    expect(find.text('Delete message'), findsOneWidget);
    expect(find.byType(AppMenuDivider), findsOneWidget);
    final rule = tester.getTopLeft(find.byType(AppMenuDivider)).dy;
    expect(rule, greaterThan(tester.getTopLeft(find.text('Remind me')).dy));
    expect(rule, lessThan(tester.getTopLeft(find.text('Edit message')).dy));
    expect(
      tester.getTopLeft(find.text('Edit message')).dy,
      lessThan(tester.getTopLeft(find.text('Delete message')).dy),
    );
  });

  for (final appearance in Brightness.values) {
    testWidgets(
      'your Buddy proposal offers Delete without Edit (${appearance.name})',
      (tester) async {
        brightness = appearance;
        grid.AppTheme.brightness.value = appearance;
        addTearDown(() => grid.AppTheme.brightness.value = Brightness.light);
        final server = ConversationServer()..append('Please fix the menu');
        server.messages.single['source'] = {
          'kind': 'buddy-proposal',
          'personId': 'owner',
        };
        await show(tester, server);
        await openMore(tester, 'message-1');
        expect(find.text('Delete message'), findsOneWidget);
        expect(find.text('Edit message'), findsNothing);
        await shot(tester, 'desktop');
      },
    );
  }

  for (final entry in <String, Map<String, dynamic>>{
    'another person': {'kind': 'person', 'id': 'huy', 'name': 'Huy'},
    'an agent': {'kind': 'agent', 'id': 'owner', 'name': 'Buddy'},
  }.entries) {
    testWidgets('${entry.key} cannot delete an owner Buddy proposal', (
      tester,
    ) async {
      final server = ConversationServer()..append('Please fix the menu');
      server.messages.single
        ..['author'] = entry.value
        ..['source'] = {'kind': 'buddy-proposal', 'personId': 'owner'};
      await show(tester, server);
      await openMore(tester, 'message-1');
      expect(find.text('Delete message'), findsNothing);
      expect(find.text('Edit message'), findsNothing);
    });
  }

  for (final source in [
    {'kind': 'buddy-proposal', 'personId': 'huy'},
    {'kind': 'buddy-proposal'},
    {'kind': 'task-line', 'personId': 'owner'},
  ]) {
    testWidgets('a source that does not authorize owner deletion: $source', (
      tester,
    ) async {
      final server = ConversationServer()..append('Please fix the menu');
      server.messages.single['source'] = source;
      await show(tester, server);
      await openMore(tester, 'message-1');
      expect(find.text('Delete message'), findsNothing);
      expect(find.text('Edit message'), findsNothing);
    });
  }

  testWidgets('an agent’s and another person’s message offer neither', (
    tester,
  ) async {
    await show(tester, three());
    for (final id in ['message-2', 'message-3']) {
      await openMore(tester, id);
      expect(find.text('Mark unread'), findsOneWidget, reason: id);
      expect(find.text('Edit message'), findsNothing, reason: id);
      expect(find.text('Delete message'), findsNothing, reason: id);
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
    }
  });

  testWidgets('a reader who may not write here is offered neither', (
    tester,
  ) async {
    final server = three();
    (server.state['conversations'] as List).cast<Map>().first['archived'] =
        true;
    await show(tester, server);
    await openMore(tester, 'message-1');
    expect(find.text('Copy link to message'), findsOneWidget);
    expect(find.text('Edit message'), findsNothing);
  });

  testWidgets('Edit message turns the text into a field; Enter saves the '
      'new text, which shows with (edited)', (tester) async {
    final server = three();
    await show(tester, server);
    await choose(tester, 'message-1', 'Edit message');
    expect(field('message-1'), findsOneWidget);
    expect(
      tester.widget<TextField>(field('message-1')).controller!.text,
      'My own words',
    );
    expect(find.text('Save'), findsOneWidget);
    expect(find.text('Cancel'), findsOneWidget);

    await tester.enterText(field('message-1'), '  My better words  ');
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();

    expect(changes(server), [
      {
        'type': 'message.edit',
        'conversationId': 'lead',
        'messageId': 'message-1',
        'text': 'My better words',
      },
    ]);
    expect(field('message-1'), findsNothing);
    // Read again at once: the new text, marked edited.
    expect(
      find.descendant(of: row('message-1'), matching: find.text('(edited)')),
      findsOneWidget,
    );
    expect(c.messages('lead').first.text, 'My better words');
    expect(c.messages('lead').first.editedAt, isNotNull);
  });

  testWidgets('Shift+Enter writes another line in the field', (tester) async {
    final server = three();
    await show(tester, server);
    await choose(tester, 'message-1', 'Edit message');
    await tester.enterText(field('message-1'), 'First');
    await tester.sendKeyDownEvent(LogicalKeyboardKey.shiftLeft);
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.shiftLeft);
    await tester.pumpAndSettle();
    expect(changes(server), isEmpty);
    expect(
      tester.widget<TextField>(field('message-1')).controller!.text,
      'First\n',
    );
  });

  testWidgets('Esc and Cancel close the field and send nothing', (
    tester,
  ) async {
    final server = three();
    await show(tester, server);
    await choose(tester, 'message-1', 'Edit message');
    await tester.enterText(field('message-1'), 'Changed my mind');
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
    expect(field('message-1'), findsNothing);
    expect(find.text('My own words'), findsOneWidget);

    await choose(tester, 'message-1', 'Edit message');
    await tester.enterText(field('message-1'), 'Changed my mind');
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();
    expect(field('message-1'), findsNothing);
    expect(changes(server), isEmpty);
    expect(find.text('(edited)'), findsNothing);
  });

  testWidgets('saving the same text just closes the field', (tester) async {
    final server = three();
    await show(tester, server);
    await choose(tester, 'message-1', 'Edit message');
    await tester.tap(find.text('Save'));
    await tester.pumpAndSettle();
    expect(field('message-1'), findsNothing);
    expect(changes(server), isEmpty);
  });

  testWidgets('a refused edit says why and keeps the old text', (tester) async {
    final server = three();
    await show(tester, server);
    await choose(tester, 'message-1', 'Edit message');
    server.refuse = {
      'code': 'FORBIDDEN',
      'message': 'Only its author can change this message.',
    };
    await tester.enterText(field('message-1'), 'New words');
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
    expect(find.text('Only its author can change this message.'), findsOne);
    expect(find.text('My own words'), findsOneWidget);
    expect(find.text('(edited)'), findsNothing);
  });

  testWidgets('Delete message asks first and sends only on Delete', (
    tester,
  ) async {
    final server = three();
    await show(tester, server);
    await choose(tester, 'message-1', 'Delete message');
    expect(find.text('Delete message?'), findsOneWidget);
    expect(find.text("This can't be undone."), findsOneWidget);
    await tester.tap(find.widgetWithText(TextButton, 'Cancel'));
    await tester.pumpAndSettle();
    expect(find.text('Delete message?'), findsNothing);
    expect(changes(server), isEmpty);
    expect(find.text('My own words'), findsOneWidget);

    await choose(tester, 'message-1', 'Delete message');
    await tester.tap(find.widgetWithText(FilledButton, 'Delete'));
    await tester.pumpAndSettle();
    expect(changes(server), [
      {
        'type': 'message.delete',
        'conversationId': 'lead',
        'messageId': 'message-1',
      },
    ]);
    // No replies: it goes at once.
    expect(row('message-1'), findsNothing);
    expect(find.text('My own words'), findsNothing);
  });

  testWidgets('a message edited elsewhere shows (edited) after its text', (
    tester,
  ) async {
    final server = three();
    server.messages[0]['editedAt'] = '2026-10-18T00:05:00Z';
    await show(tester, server);
    final mark = find.descendant(
      of: row('message-1'),
      matching: find.text('(edited)'),
    );
    expect(mark, findsOneWidget);
    expect(
      tester.getTopLeft(mark).dy,
      greaterThanOrEqualTo(tester.getTopLeft(find.text('My own words')).dy),
    );
    expect(find.text('(edited)'), findsOneWidget);
  });

  testWidgets('a deleted message with replies shows the deleted line, no '
      'actions, and keeps its thread line', (tester) async {
    final server = ConversationServer()..threads = true;
    server.append('Root to delete');
    server.append('A reply');
    server.messages[1]['thread'] = 'message-1';
    server.messages[1]['author'] = {
      'kind': 'person',
      'id': 'huy',
      'name': 'Huy',
    };
    server.deleteMessage('message-1');
    await show(tester, server);
    final line = find.descendant(
      of: row('message-1'),
      matching: find.text('This message was deleted.'),
    );
    expect(line, findsOneWidget);
    expect(tester.widget<Text>(line).style?.fontStyle, FontStyle.italic);
    await hover(tester, 'message-1');
    expect(more('message-1'), findsNothing);
    expect(
      find.descendant(
        of: row('message-1'),
        matching: find.byTooltip('Add reaction'),
      ),
      findsNothing,
    );
    expect(
      find.byKey(const ValueKey('super-thread-line-message-1')),
      findsOneWidget,
    );
  });

  test('a page read again drops a message deleted elsewhere and takes an '
      'edited text', () async {
    final server = ConversationServer()
      ..append('One')
      ..append('Two')
      ..append('Three');
    final c = server.controller();
    addTearDown(c.dispose);
    await c.refresh();
    expect(
      [for (final m in c.messages('lead')) m.text],
      ['One', 'Two', 'Three'],
    );

    server.deleteMessage('message-2');
    server.editMessage('message-3', 'Three, edited');
    await c.refresh();
    expect(
      [for (final m in c.messages('lead')) m.text],
      ['One', 'Three, edited'],
    );
    expect(c.messages('lead').last.editedAt, isNotNull);

    // The newest goes too, and then the only one left.
    server.deleteMessage('message-3');
    await c.refresh();
    expect([for (final m in c.messages('lead')) m.id], ['message-1']);
    server.deleteMessage('message-1');
    await c.refresh();
    expect(c.messages('lead'), isEmpty);
  });

  test('a tombstone read again replaces the message it was', () async {
    final server = ConversationServer()..threads = true;
    server.append('Root');
    server.append('Reply');
    server.messages[1]['thread'] = 'message-1';
    final c = server.controller();
    addTearDown(c.dispose);
    await c.refresh();
    server.deleteMessage('message-1');
    await c.refresh();
    final root = c.messages('lead').firstWhere((m) => m.id == 'message-1');
    expect(root.deletedAt, isNotNull);
    expect(root.deleted, isTrue);
    expect(root.text, 'This message was deleted.');
  });

  // A voice message plays only, and its words are never handed over (anh
  // Dee, 2026-11-04): no Copy message, no ⌘C and no Edit message on one.
  // Delete stays (#3335 review).
  group('a voice message of your own', () {
    const words = 'Ship the login fix today.';
    ConversationServer voice() => ConversationServer()
      ..append(
        words,
        attachments: [
          {
            'id': 'v1',
            'name': 'Voice message.wav',
            'mime': 'audio/wav',
            'size': 64044,
            'url': 'https://cdn.harness.autonomous.ai/v1/Voice%20message.wav',
            'voice': {
              'durationMs': 2000,
              'waveform': List.filled(48, 9),
              'transcribed': true,
            },
          },
        ],
      );

    late List<String> copied;
    setUp(() {
      copied = [];
      final messenger =
          TestWidgetsFlutterBinding.instance.defaultBinaryMessenger;
      messenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
        if (call.method == 'Clipboard.setData') {
          copied.add((call.arguments as Map)['text'] as String);
        }
        return null;
      });
      addTearDown(
        () => messenger.setMockMethodCallHandler(SystemChannels.platform, null),
      );
    });

    testWidgets('offers no Copy message', (tester) async {
      await show(tester, voice());
      await hover(tester, 'message-1');
      expect(
        find.descendant(
          of: row('message-1'),
          matching: find.byTooltip('Copy message'),
        ),
        findsNothing,
      );
    });

    testWidgets('⌘C on it copies nothing', (tester) async {
      await show(tester, voice());
      final focus = tester
          .widgetList<Focus>(
            find.descendant(of: row('message-1'), matching: find.byType(Focus)),
          )
          .map((widget) => widget.focusNode)
          .whereType<FocusNode>()
          .first;
      focus.requestFocus();
      await tester.pump();
      await tester.sendKeyDownEvent(LogicalKeyboardKey.metaLeft);
      await tester.sendKeyEvent(LogicalKeyboardKey.keyC);
      await tester.sendKeyUpEvent(LogicalKeyboardKey.metaLeft);
      await tester.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
      await tester.sendKeyEvent(LogicalKeyboardKey.keyC);
      await tester.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);
      await tester.pumpAndSettle();
      expect(copied, isNot(contains(words)));
      expect(find.text('Message copied'), findsNothing);
    });

    testWidgets('its More menu offers Delete message, never Edit', (
      tester,
    ) async {
      await show(tester, voice());
      await openMore(tester, 'message-1');
      expect(find.text('Delete message'), findsOneWidget);
      expect(find.text('Edit message'), findsNothing);
      expect(field('message-1'), findsNothing);
      expect(find.text(words), findsNothing);
    });
  });
}
