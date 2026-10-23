// The Windows runner answers the same clipboard and font channels as the
// macOS and Linux runners. These pin that the Dart side asks it.
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/clipboard/native_clipboard.dart';
import 'package:harness/terminal/installed_fonts.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('the clipboard runner answers on macOS, Linux and Windows only', () {
    expect(NativeClipboard.runnerAnswers('macos'), isTrue);
    expect(NativeClipboard.runnerAnswers('linux'), isTrue);
    expect(NativeClipboard.runnerAnswers('windows'), isTrue);
    expect(NativeClipboard.runnerAnswers('web'), isFalse);
    expect(NativeClipboard.runnerAnswers('android'), isFalse);
  });

  test('Windows reads its fonts from the runner, as macOS does', () async {
    const channel = MethodChannel('harness/fonts');
    final messenger =
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(channel, (call) async {
      expect(call.method, 'listFonts');
      return [
        {'family': 'Consolas', 'mono': true},
        {'family': 'Arial', 'mono': false},
        {'family': 'Cascadia Mono', 'mono': true},
      ];
    });
    addTearDown(() => messenger.setMockMethodCallHandler(channel, null));
    final lister = platformFontLister('windows');
    expect(lister, isNotNull);
    expect(lister, platformFontLister('macos'));
    expect(sortInstalledFonts(await lister!()), const [
      InstalledFont('Cascadia Mono', monospace: true),
      InstalledFont('Consolas', monospace: true),
      InstalledFont('Arial', monospace: false),
    ]);
    expect(platformFontLister('linux'), isNotNull);
    expect(platformFontLister('web'), isNull);
  });
}
