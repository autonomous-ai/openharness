import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/clipboard/native_clipboard.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const channel = MethodChannel('harness/clipboard_image');
  final messenger =
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
  final supported = Platform.isMacOS || Platform.isLinux;
  tearDown(() => messenger.setMockMethodCallHandler(channel, null));

  test('image clipboard exchanges the exact PNG bytes', () async {
    final png = Uint8List.fromList([137, 80, 78, 71]);
    Object? written;
    messenger.setMockMethodCallHandler(channel, (call) async {
      if (call.method == 'readImagePng') return png;
      written = call.arguments;
      return true;
    });
    expect(await NativeClipboard.readImagePng(), supported ? png : null);
    expect(await NativeClipboard.writeImagePng(png), supported);
    expect(written, supported ? png : null);
  });

  test('missing platform handler falls back to text', () async {
    expect(await NativeClipboard.readImagePng(), isNull);
    expect(await NativeClipboard.writeImagePng(Uint8List(0)), isFalse);
  });

  for (final reply in ['empty', 'refused', 'failed']) {
    test('clipboard $reply does not interrupt terminal input', () async {
      messenger.setMockMethodCallHandler(channel, (call) async {
        if (reply == 'failed') throw PlatformException(code: 'unavailable');
        return call.method == 'writeImagePng' && reply == 'refused'
            ? false
            : null;
      });
      expect(await NativeClipboard.readImagePng(), isNull);
      expect(await NativeClipboard.writeImagePng(Uint8List(0)), isFalse);
    });
  }
}
