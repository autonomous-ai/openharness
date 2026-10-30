import 'dart:async';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/update/started_marker.dart';

void main() {
  late Directory root;
  late String exe;

  setUp(() {
    root = Directory.systemTemp.createTempSync('started-marker-');
    final folder = Directory('${root.path}/app/1.2.3')
      ..createSync(recursive: true);
    exe = '${folder.path}/harness-desktop.exe';
    File(exe).writeAsStringSync('');
  });

  tearDown(() => root.deleteSync(recursive: true));

  File marker() => File('${root.path}/app/1.2.3/.started');

  test(
    'on Windows the marker appears beside the exe after the first frame',
    () async {
      final frame = Completer<void>();
      final done = markStartedAfterFirstFrame(
        firstFrame: frame.future,
        executablePath: exe,
        isWindows: true,
      );
      await Future<void>.delayed(Duration.zero);
      expect(marker().existsSync(), isFalse, reason: 'not before the frame');
      frame.complete();
      await done;
      expect(marker().existsSync(), isTrue);
    },
  );

  test('a marker already there is left as it is', () async {
    marker().writeAsStringSync('first start\n');
    await markStartedAfterFirstFrame(
      firstFrame: Future.value(),
      executablePath: exe,
      isWindows: true,
    );
    expect(marker().readAsStringSync(), 'first start\n');
  });

  test('macOS and Linux write nothing', () async {
    expect(startedMarkerFile(executablePath: exe, isWindows: false), isNull);
    await markStartedAfterFirstFrame(
      firstFrame: Future.value(),
      executablePath: exe,
      isWindows: false,
    );
    expect(marker().existsSync(), isFalse);
  });

  test('a folder that cannot be written is not an error', () async {
    await markStartedAfterFirstFrame(
      firstFrame: Future.value(),
      executablePath: '${root.path}/missing/harness-desktop.exe',
      isWindows: true,
    );
    expect(Directory('${root.path}/missing').existsSync(), isFalse);
  });
}
