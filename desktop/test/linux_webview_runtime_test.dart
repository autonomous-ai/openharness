import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/linux_webview_runtime.dart';
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
    messenger.setMockMethodCallHandler(LinuxWebViewRuntime.channel, null);
    LinuxWebViewRuntime.available = false;
  });

  for (final available in [true, false]) {
    test(
      'native availability $available controls Linux viewer support',
      () async {
        messenger.setMockMethodCallHandler(LinuxWebViewRuntime.channel, (
          call,
        ) async {
          expect(call.method, 'isAvailable');
          return available;
        });
        await LinuxWebViewRuntime.initialize();
        expect(LinuxWebViewRuntime.available, available);
      },
      skip: !RuntimePlatform.isLinux,
    );
  }

  test('missing native plugin keeps Harness usable', () async {
    await LinuxWebViewRuntime.initialize();
    expect(LinuxWebViewRuntime.available, isFalse);
  });

  test('native initialization errors disable the viewer', () async {
    messenger.setMockMethodCallHandler(LinuxWebViewRuntime.channel, (_) async {
      throw PlatformException(code: 'unavailable');
    });
    await LinuxWebViewRuntime.initialize();
    expect(LinuxWebViewRuntime.available, isFalse);
  });
  testWidgets('Linux recordings offer browser playback without WebKitGTK', (
    tester,
  ) async {
    final platform = FakeWebViewPlatform();
    WebViewPlatform.instance = platform;
    LinuxWebViewRuntime.available = false;
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
