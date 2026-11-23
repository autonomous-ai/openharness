import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/core/native_webview_runtime.dart';
import 'package:harness/core/open_in_browser.dart';
import 'package:harness/state/terminal_pane.dart';
import 'package:harness/widgets/web_pane_panel.dart';
import 'package:webview_flutter/webview_flutter.dart';
import 'package:webview_win_floating/webview_win_floating.dart';

import 'swarm_state_test.dart' show createApp;

const _viewerUrl = 'http://127.0.0.1:4179/';
const _windowsWebView = MethodChannel('webview_win_floating');

Future<void> _openPane(WidgetTester tester) async {
  final app = createApp();
  addTearDown(app.dispose);
  app.stateOf('m')!.agents = [
    Agent(
      id: 'a0',
      name: 'Fixture',
      engine: 'claude',
      dsh: 'autonomous/web-studio',
    ),
  ];
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: WebPanePanel(
          notifier: app,
          pane: TerminalPane(
            id: 1,
            machineId: 'm',
            kind: PaneKind.web,
            ownerAgentId: 'a0',
            url: _viewerUrl,
          ),
          ownerName: 'Fixture',
          ownerEngine: 'claude',
        ),
      ),
    ),
  );
  await tester.pump();
}

void main() {
  setUp(() {
    final previousRuntime = NativeWebViewRuntime.available;
    final previousAvailability = WebPanePanel.webviewAvailableForTest;
    addTearDown(() {
      NativeWebViewRuntime.available = previousRuntime;
      WebPanePanel.webviewAvailableForTest = previousAvailability;
    });
  });

  testWidgets('the locked Windows WebView mounts and follows page completion', (
    tester,
  ) async {
    final messenger = tester.binding.defaultBinaryMessenger;
    final calls = <MethodCall>[];
    messenger.setMockMethodCallHandler(_windowsWebView, (call) async {
      calls.add(call);
      return switch (call.method) {
        'create' || 'loadUrl' || 'clearAll' || 'updateBounds' => true,
        'canGoBack' || 'canGoForward' => false,
        _ => null,
      };
    });
    final previousWebView = WebViewPlatform.instance;
    WindowsWebViewPlatform.registerWith();
    NativeWebViewRuntime.available = true;
    WebPanePanel.webviewAvailableForTest = true;
    addTearDown(() {
      messenger.setMockMethodCallHandler(_windowsWebView, null);
      if (previousWebView != null) WebViewPlatform.instance = previousWebView;
    });

    await _openPane(tester);
    expect(tester.takeException(), isNull);
    expect(find.byType(WinWebViewWidget), findsOneWidget);
    expect(
      calls.where((call) => call.method == 'loadUrl').single.arguments['url'],
      _viewerUrl,
    );

    final view = tester.widget<WinWebViewWidget>(find.byType(WinWebViewWidget));
    final create = calls.where((call) => call.method == 'create').single;
    const navigated = 'http://127.0.0.1:4179/menu?day=mon';
    await messenger.handlePlatformMessage(
      _windowsWebView.name,
      const StandardMethodCodec().encodeMethodCall(
        MethodCall('onPageFinished', {
          'webviewId': create.arguments['webviewId'],
          'url': navigated,
          'errCode': 0,
        }),
      ),
      (_) {},
    );
    await tester.pump();
    final address = tester.widget<TextField>(
      find.byKey(const ValueKey('web-pane-address')),
    );
    expect(address.controller!.text, navigated);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump();
    await view.controller.dispose();
  });

  for (final available in [true, false]) {
    testWidgets(
      'browser fallback only suggests WebView2 when absent ($available)',
      (tester) async {
        // With no controller to draw, the install hint follows runtime availability.
        NativeWebViewRuntime.available = available;
        WebPanePanel.webviewAvailableForTest = false;
        final opened = <Uri>[];
        final previousOpener = browserOpener;
        browserOpener = (url) async {
          opened.add(url);
          return true;
        };
        addTearDown(() => browserOpener = previousOpener);
        await _openPane(tester);

        expect(
          find.textContaining('Install Microsoft Edge WebView2'),
          available ? findsNothing : findsOneWidget,
        );
        await tester.tap(
          find.byKey(const ValueKey('web-pane-open-in-browser')),
        );
        await tester.pump();
        expect(opened, [Uri.parse(_viewerUrl)]);
      },
      variant: TargetPlatformVariant.only(TargetPlatform.windows),
    );
  }
}
