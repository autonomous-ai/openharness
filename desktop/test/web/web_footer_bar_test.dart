@TestOn('browser')
library;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/state/workspace_chrome.dart';
import 'package:harness/web/footer/web_footer_bar.dart';
import 'package:harness/widgets/web_download_button.dart';

Future<void> _footer(WidgetTester tester, {WorkspaceFooterItem? share}) =>
    tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Align(
            alignment: Alignment.bottomCenter,
            child: WebFooterBar(
              footer: WorkspaceFooter(
                summary: 'Studio Mac',
                items: const [WorkspaceFooterItem(title: 'Studio Mac')],
                share: share,
              ),
            ),
          ),
        ),
      ),
    );

void main() {
  // Audit finding S9: the store bar over the page is a phone's one download.
  for (final platform in [TargetPlatform.iOS, TargetPlatform.android]) {
    testWidgets('a ${platform.name} browser\'s footer has no Download app', (
      tester,
    ) async {
      debugDefaultTargetPlatformOverride = platform;
      await _footer(tester);
      expect(find.byType(WebDownloadButton), findsNothing);
      // Share keeps its place when it is on.
      await _footer(
        tester,
        share: WorkspaceFooterItem(title: 'Share', onPressed: () {}),
      );
      expect(find.byKey(const ValueKey('workspace-share-button')), findsOne);
      expect(find.byType(WebDownloadButton), findsNothing);
      debugDefaultTargetPlatformOverride = null;
    });
  }

  for (final platform in [
    TargetPlatform.macOS,
    TargetPlatform.windows,
    TargetPlatform.linux,
  ]) {
    testWidgets('a narrow ${platform.name} browser keeps Download app', (
      tester,
    ) async {
      debugDefaultTargetPlatformOverride = platform;
      await _footer(tester);
      expect(find.byType(WebDownloadButton), findsOneWidget);
      debugDefaultTargetPlatformOverride = null;
    });
  }
}
