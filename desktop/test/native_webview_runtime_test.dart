import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/native_webview_runtime.dart';
import 'package:harness/core/runtime_platform.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/store/store_demo_dialog.dart';
import 'package:webview_flutter/webview_flutter.dart';

import 'support/fake_webview.dart';
import 'support/real_fonts.dart';

void main() {
  setUpAll(loadRealFonts);
  TestWidgetsFlutterBinding.ensureInitialized();
  final messenger =
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;

  tearDown(() {
    messenger.setMockMethodCallHandler(NativeWebViewRuntime.channel, null);
    NativeWebViewRuntime.available = false;
  });

  for (final available in [true, false]) {
    test(
      'native availability $available controls Linux viewer support',
      () async {
        messenger.setMockMethodCallHandler(NativeWebViewRuntime.channel, (
          call,
        ) async {
          expect(call.method, 'isAvailable');
          return available;
        });
        await NativeWebViewRuntime.initialize();
        expect(NativeWebViewRuntime.available, available);
      },
      skip: !RuntimePlatform.isLinux,
    );
  }

  group('WebView2 on Windows', () {
    const machine = r'C:\Program Files (x86)\Microsoft\EdgeWebView\Application';
    const user = r'C:\Users\a\AppData\Local\Microsoft\EdgeWebView\Application';
    const environment = {
      'ProgramFiles(x86)': r'C:\Program Files (x86)',
      'LOCALAPPDATA': r'C:\Users\a\AppData\Local',
    };

    test('is found installed for the computer or for this user', () {
      expect(
        windowsWebView2Installed(environment, exists: (at) => at == machine),
        isTrue,
      );
      expect(
        windowsWebView2Installed(environment, exists: (at) => at == user),
        isTrue,
      );
    });

    test('is missing when neither folder is there', () {
      expect(
        windowsWebView2Installed(environment, exists: (_) => false),
        isFalse,
      );
      expect(windowsWebView2Installed(const {}, exists: (_) => true), isFalse);
    });
  });

  test('missing native plugin keeps Harness usable', () async {
    await NativeWebViewRuntime.initialize();
    expect(NativeWebViewRuntime.available, isFalse);
  });

  test('native initialization errors disable the viewer', () async {
    messenger.setMockMethodCallHandler(NativeWebViewRuntime.channel, (_) async {
      throw PlatformException(code: 'unavailable');
    });
    await NativeWebViewRuntime.initialize();
    expect(NativeWebViewRuntime.available, isFalse);
  });
  testWidgets('Linux recordings offer browser playback without WebKitGTK', (
    tester,
  ) async {
    final platform = FakeWebViewPlatform();
    WebViewPlatform.instance = platform;
    NativeWebViewRuntime.available = false;
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        home: const StoreDemoDialog(
          name: 'Example',
          video: 'https://example.com/run.mp4',
        ),
      ),
    );
    expect(find.text('Watch this recording in your browser.'), findsOneWidget);
    expect(platform.controllers, isEmpty);
    await tester.pumpWidget(const SizedBox.shrink());
  }, skip: !RuntimePlatform.isLinux);
}
