// Paste in the New Harness box: a picture on the clipboard becomes an
// attachment, and text still goes into the task.
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/clipboard/copied_files.dart';
import 'package:harness/clipboard/pasted_text.dart';
import 'package:harness/state/harness_attachments.dart';
import 'package:harness/widgets/new_harness_attachments.dart';
import 'package:harness/widgets/new_harness_paste.dart';

/// A real 1×1 PNG, so a chip has something to draw.
final _png = base64Decode(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA'
  '60e6kgAAAABJRU5ErkJggg==',
);

void main() {
  /// What the system clipboard holds as text; null is none.
  String? clipboardText;

  setUp(() {
    clipboardText = null;
    debugDefaultTargetPlatformOverride = TargetPlatform.macOS;
    final messenger =
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
      return switch (call.method) {
        'Clipboard.getData' =>
          clipboardText == null ? null : {'text': clipboardText},
        'Clipboard.hasStrings' => {'value': clipboardText != null},
        _ => null,
      };
    });
    addTearDown(
      () => messenger.setMockMethodCallHandler(SystemChannels.platform, null),
    );
  });

  Future<({HarnessAttachments files, TextEditingController task})> mount(
    WidgetTester tester, {
    Uint8List? image,
    CopiedFiles copied = (files: const [], tooLarge: const []),
    bool enabled = true,
  }) async {
    final files = HarnessAttachments();
    final task = TextEditingController();
    final focus = FocusNode();
    addTearDown(files.dispose);
    addTearDown(task.dispose);
    addTearDown(focus.dispose);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: NewHarnessPasteTarget(
            attachments: files,
            enabled: enabled,
            focusNode: focus,
            readFiles: () async => copied,
            readImage: () async => image,
            child: TextField(controller: task, focusNode: focus),
          ),
        ),
      ),
    );
    focus.requestFocus();
    await tester.pump();
    return (files: files, task: task);
  }

  Future<void> paste(WidgetTester tester) async {
    await tester.sendKeyDownEvent(LogicalKeyboardKey.metaLeft);
    await tester.sendKeyEvent(LogicalKeyboardKey.keyV);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.metaLeft);
    await tester.pumpAndSettle();
  }

  List<String> names(HarnessAttachments files) => [
    for (final file in files.files) file.name,
  ];

  testWidgets('a picture on the clipboard is attached, each paste its own', (
    tester,
  ) async {
    final box = await mount(tester, image: _png);
    await paste(tester);
    expect(names(box.files), [kPastedImageName]);
    expect(box.files.files.single.bytes, _png);
    expect(box.task.text, isEmpty);

    await paste(tester);
    expect(names(box.files), [kPastedImageName, 'pasted-image-2.png']);
    debugDefaultTargetPlatformOverride = null;
  });

  testWidgets('text pastes into the task, a picture beside it or not', (
    tester,
  ) async {
    clipboardText = 'fix the login screen';
    final box = await mount(tester, image: _png);
    await paste(tester);
    expect(box.task.text, 'fix the login screen');
    expect(box.files.isEmpty, isTrue);
    debugDefaultTargetPlatformOverride = null;
  });

  testWidgets("a copied image's own web address does not hide the image", (
    tester,
  ) async {
    clipboardText = 'https://example.com/cat.png';
    final box = await mount(tester, image: _png);
    await paste(tester);
    expect(names(box.files), [kPastedImageName]);
    expect(box.task.text, isEmpty);
    debugDefaultTargetPlatformOverride = null;
  });

  testWidgets('with no picture, paste is the field\'s own', (tester) async {
    clipboardText = 'https://example.com/docs';
    final box = await mount(tester);
    await paste(tester);
    expect(box.task.text, 'https://example.com/docs');
    expect(box.files.isEmpty, isTrue);
    debugDefaultTargetPlatformOverride = null;
  });

  testWidgets('copied files are attached under their own names, and come '
      'before the name and icon a file manager leaves beside them', (
    tester,
  ) async {
    // What Finder's Copy leaves: the files, their names as text, an icon.
    clipboardText = 'report.pdf\nshot.png';
    final box = await mount(
      tester,
      image: _png,
      copied: (
        files: [
          (name: 'report.pdf', bytes: Uint8List.fromList([1, 2])),
          (name: 'shot.png', bytes: _png),
        ],
        tooLarge: const [],
      ),
    );
    await paste(tester);
    expect(names(box.files), ['report.pdf', 'shot.png']);
    expect(box.task.text, isEmpty);

    // The same copy pasted again stands beside the first, never over it.
    await paste(tester);
    expect(names(box.files), [
      'report.pdf',
      'shot.png',
      'report-2.pdf',
      'shot-2.png',
    ]);
    debugDefaultTargetPlatformOverride = null;
  });

  testWidgets('a copied file over the limit is named, the rest attached', (
    tester,
  ) async {
    final box = await mount(
      tester,
      copied: (
        files: [
          (name: 'notes.txt', bytes: Uint8List.fromList([1])),
        ],
        tooLarge: const ['movie.mov'],
      ),
    );
    await paste(tester);
    expect(names(box.files), ['notes.txt']);
    expect(find.textContaining('movie.mov is over'), findsOneWidget);
    debugDefaultTargetPlatformOverride = null;
  });

  testWidgets('a locked box attaches nothing', (tester) async {
    final box = await mount(tester, image: _png, enabled: false);
    await paste(tester);
    expect(box.files.isEmpty, isTrue);
    debugDefaultTargetPlatformOverride = null;
  });

  testWidgets('a picture over the limit is refused, and says so', (
    tester,
  ) async {
    final box = await mount(
      tester,
      image: Uint8List(HarnessAttachments.maxBytes + 1),
    );
    await paste(tester);
    expect(box.files.isEmpty, isTrue);
    expect(find.textContaining('$kPastedImageName is over'), findsOneWidget);
    debugDefaultTargetPlatformOverride = null;
  });

  testWidgets('a picture\'s chip shows the picture; a file\'s, the file mark', (
    tester,
  ) async {
    final files = HarnessAttachments()
      ..add([
        HarnessAttachment(kPastedImageName, _png),
        HarnessAttachment('notes.txt', Uint8List.fromList(utf8.encode('hi'))),
      ]);
    addTearDown(files.dispose);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: NewHarnessAttachmentChips(attachments: files, enabled: true),
        ),
      ),
    );
    expect(
      find.byKey(
        const ValueKey('new-harness-attachment-preview:$kPastedImageName'),
      ),
      findsOneWidget,
    );
    expect(
      find.byKey(const ValueKey('new-harness-attachment-preview:notes.txt')),
      findsNothing,
    );
    expect(tester.takeException(), isNull);
    debugDefaultTargetPlatformOverride = null;
  });

  test('pasted files are numbered, never swapped for one of their name', () {
    final files = HarnessAttachments()
      ..add([HarnessAttachment('image.png', _png)]);
    addTearDown(files.dispose);
    files.addPasted([
      HarnessAttachment('image.png', _png),
      HarnessAttachment('image.png', _png),
      HarnessAttachment('Makefile', _png),
      HarnessAttachment('Makefile', _png),
    ]);
    expect(
      [for (final file in files.files) file.name],
      ['image.png', 'image-2.png', 'image-3.png', 'Makefile', 'Makefile-2'],
    );
  });

  test('text wins a paste unless it is only a web address', () {
    expect(pastedTextWins(null), isFalse);
    expect(pastedTextWins('  \n'), isFalse);
    expect(pastedTextWins('https://example.com/cat.png'), isFalse);
    expect(pastedTextWins('see https://example.com/cat.png'), isTrue);
    expect(pastedTextWins('Screenshot 2026-10-02.png'), isTrue);
    expect(pastedTextWins('line one\nline two'), isTrue);
  });
}
