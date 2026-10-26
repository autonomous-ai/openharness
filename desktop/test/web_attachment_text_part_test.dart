import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/attachment_text_viewer.dart' as viewer;
import 'package:harness/super_tabs/attachment_viewer.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/web/parts/attachment_text_viewer.dart' as web;

void main() {
  testWidgets('a browser downloads the text viewer, then opens the file in it', (
    tester,
  ) async {
    final fetcher = attachmentFetcher;
    attachmentFetcher = (url, {maxBytes}) async =>
        Uint8List.fromList(utf8.encode('# Spec'));
    addTearDown(() => attachmentFetcher = fetcher);
    final file = SuperTabAttachment.fromJson({
      'id': 'a1',
      'name': 'spec.md',
      'mime': 'text/markdown',
      'size': 5,
      'url': 'https://cdn.harness.autonomous.ai/a1/spec.md',
    });
    final url = Uri.parse(file.url);
    await tester.pumpWidget(
      MaterialApp(home: web.AttachmentTextViewer(file: file, url: url)),
    );
    expect(find.text('Loading…'), findsOneWidget);

    // A native test has no part to fetch; loadLibrary answers on a timer.
    await tester.pump(const Duration(milliseconds: 1));

    final opened = tester.widget<viewer.AttachmentTextViewer>(
      find.byType(viewer.AttachmentTextViewer),
    );
    expect(opened.file, same(file));
    expect(opened.url, url);
  });
}
