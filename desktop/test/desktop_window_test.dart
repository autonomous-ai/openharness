import 'package:harness/terminal/terminal_font_store.dart';

import 'dart:async';
import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/desktop_window.dart';
import 'package:harness/shared/theme/app_type.dart';
import 'package:harness/shared/theme/color_palette.dart';

const _windowChannel = MethodChannel('window_manager');
const _nativeChannel = MethodChannel('harness/swarm_tabs');
const _screenChannel = MethodChannel(
  'dev.leanflutter.plugins/screen_retriever',
);
const _screenEvents = MethodChannel(
  'dev.leanflutter.plugins/screen_retriever_event',
);
const _display = {
  'id': 'isolated-display',
  'size': {'width': 1920.0, 'height': 1080.0},
  'visiblePosition': {'dx': 0.0, 'dy': 0.0},
};

void main() {
  final binding = TestWidgetsFlutterBinding.ensureInitialized();
  final calls = <String>[];
  final nativeCalls = <MethodCall>[];
  Future<Object?> Function(MethodCall)? nativeReply;
  Future<Object?> Function(MethodCall)? windowReply;

  setUp(() {
    calls.clear();
    nativeCalls.clear();
    nativeReply = null;
    windowReply = null;
    binding.defaultBinaryMessenger.setMockMethodCallHandler(_windowChannel, (
      call,
    ) async {
      calls.add(call.method);
      switch (call.method) {
        case 'isFullScreen':
        case 'isMaximized':
        case 'isMinimized':
          return false;
        case 'getBounds':
          return {'x': 0.0, 'y': 0.0, 'width': 1280.0, 'height': 800.0};
        default:
          return await windowReply?.call(call);
      }
    });
    binding.defaultBinaryMessenger.setMockMethodCallHandler(_nativeChannel, (
      call,
    ) async {
      calls.add('native:${call.method}');
      nativeCalls.add(call);
      return nativeReply == null ? true : await nativeReply!(call);
    });
    binding.defaultBinaryMessenger.setMockMethodCallHandler(
      _screenChannel,
      (call) async => switch (call.method) {
        'getPrimaryDisplay' => _display,
        'getAllDisplays' => {
          'displays': [_display],
        },
        'getCursorScreenPoint' => {'dx': 100.0, 'dy': 100.0},
        _ => null,
      },
    );
    binding.defaultBinaryMessenger.setMockMethodCallHandler(
      _screenEvents,
      (_) async => null,
    );
  });

  tearDown(() {
    for (final channel in [
      _windowChannel,
      _nativeChannel,
      _screenChannel,
      _screenEvents,
    ]) {
      binding.defaultBinaryMessenger.setMockMethodCallHandler(channel, null);
    }
  });

  testWidgets('window readiness awaits native setup, show and focus', (
    tester,
  ) async {
    final nativeReady = Completer<Object?>();
    final shown = Completer<Object?>();
    final focused = Completer<Object?>();
    nativeReply = (_) => nativeReady.future;
    windowReply = (call) => switch (call.method) {
      'show' => shown.future,
      'focus' => focused.future,
      _ => Future.value(),
    };
    var finished = false;
    final setup = configureDesktopWindow().then((_) => finished = true);
    await tester.pump();
    final beforeNative = finished;
    expect(calls, contains('native:configure'));
    expect(calls, isNot(contains('show')));
    nativeReady.complete(true);
    await tester.pump();
    final beforeShow = finished;
    expect(calls, contains('show'));
    expect(calls, isNot(contains('focus')));
    shown.complete();
    await tester.pump();
    final beforeFocus = finished;
    expect(calls, contains('focus'));
    focused.complete();
    await tester.pump();
    await setup;

    expect([beforeNative, beforeShow, beforeFocus], [false, false, false]);
    expect(finished, isTrue);
  }, skip: !Platform.isMacOS);

  testWidgets('the initial native configuration contains the palette', (
    tester,
  ) async {
    final setup = configureDesktopWindow();
    await tester.pump();
    await setup;
    expect(nativeCalls.single.method, 'configure');
    expect(nativeCalls.single.arguments, {
      'palette': HarnessPalette.graphite.nativeColors,
      'fontFamily': terminalFontStore.value.fontFamily,
      'fontSize': AppType.chromeSize,
      'fontFallbacks': terminalFontStore.value.fontFamilyFallback,
    });
    expect(calls.indexOf('native:configure'), lessThan(calls.indexOf('show')));
  }, skip: !Platform.isMacOS);

  testWidgets('every saved palette reaches native setup before showing', (
    tester,
  ) async {
    for (final palette in HarnessPalette.values) {
      calls.clear();
      nativeCalls.clear();
      final setup = configureDesktopWindow(palette: palette);
      await tester.pump();
      await setup;
      expect(nativeCalls.single.arguments, {
        'palette': palette.nativeColors,
        'fontFamily': terminalFontStore.value.fontFamily,
        'fontSize': AppType.chromeSize,
        'fontFallbacks': terminalFontStore.value.fontFamilyFallback,
      });
      expect(
        calls.indexOf('native:configure'),
        lessThan(calls.indexOf('show')),
      );
      expect(calls.where((call) => call == 'show'), hasLength(1));
      expect(calls.where((call) => call == 'focus'), hasLength(1));
    }
  }, skip: !Platform.isMacOS);

  testWidgets('native setup failures propagate without showing the window', (
    tester,
  ) async {
    nativeReply = (_) async => throw PlatformException(code: 'SETUP_FAILED');
    final setup = configureDesktopWindow(palette: HarnessPalette.forest);
    final failed = expectLater(
      setup,
      throwsA(
        isA<PlatformException>().having((e) => e.code, 'code', 'SETUP_FAILED'),
      ),
    );
    await tester.pump();
    await failed;
    expect(calls, contains('native:configure'));
    expect(calls, isNot(contains('show')));
    expect(calls, isNot(contains('focus')));
  }, skip: !Platform.isMacOS);
}
