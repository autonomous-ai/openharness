// A picture whose link had ended, opened as the app starts: the ask for a
// fresh one failed once, and the message said "can't be shown here" until the
// chat was left and opened again (Desktop 1.3.68 on DESKTOP-0TFH0OJ, 2026-11-05).
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/attachment_image.dart';
import 'package:harness/super_tabs/attachment_upload.dart';
import 'package:harness/super_tabs/attachment_viewer.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/file_links.dart';
import 'package:harness/super_tabs/model.dart';

final _png = base64Decode(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
);

void main() {
  final now = DateTime.utc(2026, 11, 5, 12);
  const broken = 'shot.png can’t be shown here.';
  String signed({String sig = '1'}) =>
      'https://$kSuperTabFilesHost/bucket/super-tabs/tab/a1/shot.png'
      '?X-Goog-Signature=$sig';

  late ImageProvider Function(AttachmentImage) original;
  setUp(() {
    original = attachmentImage;
    attachmentImage = (_) => MemoryImage(_png);
    superTabFileClock = () => now;
  });
  tearDown(() {
    attachmentImage = original;
    superTabFileClock = DateTime.now;
  });

  SuperTabAttachment fresh() => SuperTabAttachment.fromJson({
    'id': 'a1',
    'name': 'shot.png',
    'mime': 'image/png',
    'size': 3000,
    'url': 'https://cdn.harness.autonomous.ai/a1/shot.png',
    'link': signed(sig: 'fresh'),
    'expiresAt': now.millisecondsSinceEpoch + 900000,
  });

  /// The picture, its link ended a minute ago; [ask] answers for a fresh one.
  Future<void> show(
    WidgetTester tester,
    Future<SuperTabAttachment> Function() ask,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SuperTabInlineImage(
            file: SuperTabFileRef(
              SuperTabAttachment.fromJson({
                'id': 'a1',
                'name': 'shot.png',
                'mime': 'image/png',
                'size': 3000,
                'url': 'https://cdn.harness.autonomous.ai/a1/shot.png',
                'link': signed(),
                'expiresAt': now.millisecondsSinceEpoch - 60000,
              }),
              conversationId: 'lead',
              messageId: 'm1',
              fresh: (_, _, _) => ask(),
            ),
          ),
        ),
      ),
    );
    await tester.pump();
    await tester.pump();
  }

  testWidgets('a fresh link that failed once is asked for again, and shows', (
    tester,
  ) async {
    var asked = 0;
    await show(tester, () async {
      asked++;
      if (asked == 1) throw StateError('still connecting');
      return fresh();
    });
    expect(asked, 1);
    expect(find.text(broken), findsNothing);

    await tester.pump(const Duration(seconds: 3));
    await tester.pump();
    expect(asked, 2);
    expect(find.text(broken), findsNothing);
    expect(find.byType(Image), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('it stops asking, and says so, when the link never comes', (
    tester,
  ) async {
    var asked = 0;
    await show(tester, () async {
      asked++;
      throw StateError('offline');
    });
    await tester.pump(const Duration(minutes: 1));
    await tester.pump(const Duration(minutes: 1));
    await tester.pump(const Duration(minutes: 1));
    await tester.pump();
    expect(asked, 4);
    expect(find.text(broken), findsOneWidget);

    await tester.pump(const Duration(minutes: 5));
    expect(asked, 4);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('a file that is gone says so at once and is not asked again', (
    tester,
  ) async {
    var asked = 0;
    await show(tester, () async {
      asked++;
      throw const SuperTabFailure('NOT_FOUND', 'Not found', statusCode: 404);
    });
    expect(asked, 1);
    expect(find.text(broken), findsOneWidget);
    await tester.pump(const Duration(minutes: 1));
    expect(asked, 1);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('leaving before the next ask leaves no timer behind', (
    tester,
  ) async {
    await show(tester, () async => throw StateError('offline'));
    await tester.pumpWidget(const SizedBox());
    // A pending timer would fail this test when it ends.
  });
}
