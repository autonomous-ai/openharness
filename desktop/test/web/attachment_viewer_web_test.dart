@TestOn('browser')
library;

// A browser cannot write a chosen path, so a chat file's viewer offers no
// Download there; Open in browser hands the file to the browser instead.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/attachment_viewer.dart';
import 'package:harness/super_tabs/model.dart';

void main() {
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
