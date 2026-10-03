// Files copied in a file manager: what the clipboard names, read off disk.
import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/clipboard/copied_files.dart';
import 'package:harness/clipboard/native_clipboard.dart';

void main() {
  late Directory dir;

  setUp(() => dir = Directory.systemTemp.createTempSync('copied-files-'));
  tearDown(() => dir.deleteSync(recursive: true));

  String write(String name, List<int> bytes) {
    final file = File('${dir.path}/$name')..writeAsBytesSync(bytes);
    return file.path;
  }

  test('files are read under their own names, in the order copied', () async {
    final copied = await readCopiedFiles([
      write('b.txt', [2, 2]),
      write('a.png', [1]),
    ], maxBytes: 16);
    expect([for (final file in copied.files) file.name], ['b.txt', 'a.png']);
    expect(copied.files.first.bytes, [2, 2]);
    expect(copied.tooLarge, isEmpty);
  });

  test('one over the limit is named and never read; the rest are', () async {
    final copied = await readCopiedFiles([
      write('movie.mov', List.filled(17, 0)),
      write('at-the-limit.bin', List.filled(16, 0)),
    ], maxBytes: 16);
    expect(copied.tooLarge, ['movie.mov']);
    expect(copied.files.single.name, 'at-the-limit.bin');
  });

  test('a folder, and a file that is gone, are left out', () async {
    Directory('${dir.path}/folder').createSync();
    final copied = await readCopiedFiles([
      '${dir.path}/folder',
      '${dir.path}/deleted.txt',
      write('kept.txt', [1]),
    ], maxBytes: 16);
    expect(copied.files.single.name, 'kept.txt');
    expect(copied.tooLarge, isEmpty);
  });

  group('the clipboard\'s file paths', () {
    TestWidgetsFlutterBinding.ensureInitialized();
    const channel = MethodChannel('harness/clipboard_image');
    final messenger =
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    tearDown(() => messenger.setMockMethodCallHandler(channel, null));

    test('are what the runner answers', () async {
      messenger.setMockMethodCallHandler(
        channel,
        (call) async =>
            call.method == 'readFilePaths' ? ['/tmp/a.png', '/tmp/b'] : null,
      );
      expect(await NativeClipboard.readFilePaths(), ['/tmp/a.png', '/tmp/b']);
    });

    test('are none on a runner built before the method existed', () async {
      expect(await NativeClipboard.readFilePaths(), isEmpty);
      messenger.setMockMethodCallHandler(
        channel,
        (call) async => throw PlatformException(code: 'broken'),
      );
      expect(await NativeClipboard.readFilePaths(), isEmpty);
    });
  }, skip: !Platform.isMacOS && !Platform.isLinux);
}
