import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/linux_webview_runtime.dart';
import 'package:integration_test/integration_test.dart';
import 'package:webview_flutter/webview_flutter.dart';

// Run on Linux with WebKitGTK installed using flutter test -d linux.
void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('optional Linux runtime and retained native page', (
    tester,
  ) async {
    await LinuxWebViewRuntime.initialize();
    expect(LinuxWebViewRuntime.available, isTrue);

    final loaded = Completer<void>();
    final controller = WebViewController();
    await controller.setJavaScriptMode(JavaScriptMode.unrestricted);
    await controller.setNavigationDelegate(
      NavigationDelegate(
        onPageFinished: (_) {
          if (!loaded.isCompleted) loaded.complete();
        },
      ),
    );
    await controller.loadHtmlString(
      '<html><body>Linux viewer<script>window.retained = 42;</script></body></html>',
    );
    Widget page(bool visible) => MaterialApp(
      home: Scaffold(
        body: visible
            ? WebViewWidget(controller: controller)
            : const SizedBox.shrink(),
      ),
    );
    await tester.pumpWidget(page(true));
    await tester.runAsync(
      () => loaded.future.timeout(const Duration(seconds: 30)),
    );
    expect(
      await controller.runJavaScriptReturningResult('window.retained'),
      42,
    );
    await tester.pumpWidget(page(false));
    await tester.pump();
    await tester.pumpWidget(page(true));
    await tester.pump();
    expect(
      await controller.runJavaScriptReturningResult('window.retained'),
      42,
    );
    await tester.pumpWidget(const SizedBox.shrink());
    await controller.loadHtmlString('<html></html>');
  });
}
