@TestOn('browser')
library;

// In a browser a chat file is the browser's: a text file opens in a new tab
// rather than being fetched into a popup (a page cannot refuse a redirect or
// stop a download part way), and a viewer offers no Download, since a page
// cannot write a chosen path.
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/open_in_browser.dart';
import 'package:harness/super_tabs/attachment_chips.dart';
import 'package:harness/super_tabs/attachment_viewer.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/web/parts/attachment_text_viewer.dart';

void main() {
  testWidgets('a text file opens in the browser, not fetched in the page', (
    tester,
  ) async {
    final opened = <Uri>[], fetched = <Uri>[];
    final browser = browserOpener, fetcher = attachmentFetcher;
    browserOpener = (url) async {
      opened.add(url);
      return true;
    };
    attachmentFetcher = (url, {maxBytes}) async {
      fetched.add(url);
      return Uint8List(0);
    };
    addTearDown(() {
      browserOpener = browser;
      attachmentFetcher = fetcher;
    });
    final file = SuperTabAttachment.fromJson({
      'id': 'a1',
      'name': 'spec.md',
      'mime': 'text/markdown',
      'size': 5,
      'url': 'https://cdn.harness.autonomous.ai/a1/spec.md',
    });
    await tester.pumpWidget(
      MaterialApp(home: Scaffold(body: SuperTabAttachments([file]))),
    );

    await tester.tap(find.byKey(const ValueKey('super-attachment:a1')));
    await tester.pumpAndSettle();
    expect(opened, [Uri.parse(file.url)]);
    expect(fetched, isEmpty);
    expect(find.byType(AttachmentTextViewer), findsNothing);
  });

  testWidgets('a viewer in the browser has no Download', (tester) async {
    final file = SuperTabAttachment.fromJson({
      'id': 'a1',
      'name': 'spec.md',
      'mime': 'text/markdown',
      'size': 5,
      'url': 'https://cdn.harness.autonomous.ai/a1/spec.md',
    });
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: AttachmentViewerActions(file: file, url: Uri.parse(file.url)),
        ),
      ),
    );

    expect(find.text('Open in browser'), findsOneWidget);
    expect(find.text('Download'), findsNothing);
  });
}
