import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/linux_webview_runtime.dart';
import 'package:harness/widgets/native_webview_host.dart';
import 'package:harness/widgets/pane_menu.dart';
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
        body: NativeWebViewHost(
          visible: visible,
          child: WebViewWidget(controller: controller),
        ),
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
    final context = tester.element(find.byType(NativeWebViewHost));
    final menu = showPaneMenu<void>(
      context: context,
      position: const RelativeRect.fromLTRB(20, 20, 20, 0),
      children: (close) => [
        paneMenuItem(
          onTap: () => close(null),
          child: const Text('Close native test menu'),
        ),
      ],
    );
    await tester.pumpAndSettle();
    expect(find.byType(WebViewWidget), findsNothing);
    await tester.tap(find.text('Close native test menu'));
    await menu;
    await tester.pumpAndSettle();
    expect(find.byType(WebViewWidget), findsOneWidget);
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
