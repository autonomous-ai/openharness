// Ordinary Windows application channels and single-instance delivery. Run with
// FLUTTER_TEST=1 and a unique HARNESS_DESKTOP_INSTANCE, never an installed app's
// instance. windows-desktop.yml owns the profile used by the integration runner.
// HARNESS_RUNNER_TEST_CHILD_EXE names a separately built normal Debug bundle
// targeting windows_runner_child.dart, without Flutter's test-host bootstrap.
// Coordination stays under its scratch directory. This checks startup before
// Dart's ready; the native pre-Listen race and interactive behavior are separate.
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/clipboard/native_clipboard.dart';
import 'package:integration_test/integration_test.dart';

const _links = MethodChannel('harness/community_links');
const _channelTimeout = Duration(seconds: 20);
const _fork =
    'harness://fork/starter-runner-test?request=0b6b4b8e-6f6a-4c64-9d1b-6f0d0c1a2b3c';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  final skip = !Platform.isWindows;
  late String childExecutable;
  setUpAll(() {
    if (skip) return;
    expect(Platform.environment['FLUTTER_TEST'], '1');
    expect(Platform.environment['HARNESS_DESKTOP_INSTANCE'], isNotEmpty);
    final path = Platform.environment['HARNESS_RUNNER_TEST_CHILD_EXE'];
    expect(
      path,
      isNotNull,
      reason: 'a separately built child bundle is required',
    );
    final child = File(path!);
    expect(
      child.isAbsolute,
      isTrue,
      reason: 'child executable must be absolute',
    );
    expect(child.existsSync(), isTrue, reason: 'child executable is missing');
    childExecutable = child.path;
  });

  testWidgets('fonts: installed families and concurrent answers agree', (
    tester,
  ) async {
    await tester.runAsync(() async {
      const channel = MethodChannel('harness/fonts');
      final answers = await Future.wait([
        for (var i = 0; i < 4; i++)
          channel.invokeListMethod<Object?>('listFonts'),
      ]).timeout(_channelTimeout);
      for (final raw in answers) {
        expect(raw, isNotEmpty);
        expect(raw, answers.first);
        final families = <String, bool>{};
        for (final entry in raw!) {
          expect(entry, isA<Map>());
          final row = entry! as Map;
          expect(row['family'], isA<String>());
          expect(row['mono'], isA<bool>());
          families[row['family'] as String] = row['mono'] as bool;
        }
        expect(families['Consolas'], isTrue);
        expect(families['Arial'], isFalse);
        expect(families.keys.where((name) => name.startsWith('@')), isEmpty);
      }
    });
  }, skip: skip);

  testWidgets('clipboard: PNG round-trips and JPEG rejection retains it', (
    tester,
  ) async {
    await tester.runAsync(() async {
      final png = await _png(3, 2, const Color(0xFF3366CC));
      expect(
        await NativeClipboard.writeImagePng(png).timeout(_channelTimeout),
        isTrue,
      );
      expect(
        await NativeClipboard.readImagePng().timeout(_channelTimeout),
        png,
      );
      // A valid 1x1 RGB JPEG: rejection must check PNG format, not just whether
      // an image decoder accepts these bytes. Independently decode the fixture.
      final jpeg = base64Decode(_jpeg);
      final codec = await ui.instantiateImageCodec(jpeg);
      try {
        final image = (await codec.getNextFrame()).image;
        try {
          expect((image.width, image.height), (1, 1));
        } finally {
          image.dispose();
        }
      } finally {
        codec.dispose();
      }
      expect(
        await NativeClipboard.writeImagePng(jpeg).timeout(_channelTimeout),
        isFalse,
      );
      expect(
        await NativeClipboard.readImagePng().timeout(_channelTimeout),
        png,
      );
    });
  }, skip: skip);

  testWidgets('clipboard: a bitmap without PNG is converted to PNG', (
    tester,
  ) async {
    await tester.runAsync(() async {
      await _powershell(r'''
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$bitmap = New-Object System.Drawing.Bitmap 5,4
try {
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try { $graphics.Clear([System.Drawing.Color]::FromArgb(255, 200, 30, 40)) }
  finally { $graphics.Dispose() }
  [System.Windows.Forms.Clipboard]::SetImage($bitmap)
  if ([System.Windows.Forms.Clipboard]::ContainsData('PNG')) { throw 'Unexpected PNG beside bitmap' }
} finally { $bitmap.Dispose() }
''');
      final png = await NativeClipboard.readImagePng().timeout(_channelTimeout);
      expect(png, isNotNull);
      expect(png!.take(8), [137, 80, 78, 71, 13, 10, 26, 10]);
      final codec = await ui.instantiateImageCodec(png);
      try {
        final image = (await codec.getNextFrame()).image;
        try {
          expect((image.width, image.height), (5, 4));
          final pixels = (await image.toByteData(
            format: ui.ImageByteFormat.rawRgba,
          ))!;
          expect(
            [for (var i = 0; i < 4; i++) pixels.getUint8(i)],
            [200, 30, 40, 255],
          );
        } finally {
          image.dispose();
        }
      } finally {
        codec.dispose();
      }
    });
  }, skip: skip);

  testWidgets('clipboard: copied files preserve paths and their order', (
    tester,
  ) async {
    await tester.runAsync(() async {
      final root = await _scratch('harness clip ');
      final odd = await Directory('${root.path}\\Nguyễn Văn A\'').create();
      final files = [
        await File('${odd.path}\\one & two %x% !.txt').writeAsString('1'),
        await File('${root.path}\\shot.png').writeAsBytes([0x89]),
      ];
      await _powershell(
        [
          'Add-Type -AssemblyName System.Windows.Forms',
          r'$files = New-Object System.Collections.Specialized.StringCollection',
          for (final file in files)
            "[void]\$files.Add('${file.path.replaceAll("'", "''")}')",
          r'[System.Windows.Forms.Clipboard]::SetFileDropList($files)',
        ].join('\n'),
      );
      expect(await NativeClipboard.readFilePaths().timeout(_channelTimeout), [
        for (final file in files) file.path,
      ]);
    });
  }, skip: skip);

  testWidgets('links: a later launch delivers once and exits', (tester) async {
    await tester.runAsync(() async {
      final opened = <String>[];
      _links.setMethodCallHandler((call) async {
        if (call.method == 'open') {
          expect(call.arguments, isA<String>());
          opened.add(call.arguments as String);
        }
      });
      addTearDown(() => _links.setMethodCallHandler(null));
      expect(
        await _links.invokeListMethod<String>('ready').timeout(_channelTimeout),
        isEmpty,
      );
      final later = await _startOwned(Platform.resolvedExecutable, [_fork]);
      expect(await later.exitCode.timeout(const Duration(seconds: 30)), 0);
      await _until(() => opened.isNotEmpty);
      await Future<void>.delayed(const Duration(seconds: 2));
      expect(opened, [_fork]);
    });
  }, skip: skip);

  testWidgets(
    'links: concurrent startup queues cold then warm exactly once; quit ends the primary',
    (tester) async {
      await tester.runAsync(() async {
        final root = await _scratch('harness race ');
        final log = File('${root.path}\\links.txt');
        final environment = await _childEnvironment(root, log);
        const cold =
            'harness://fork/starter-cold?request=1b6b4b8e-6f6a-4c64-9d1b-6f0d0c1a2b3c';
        const warm =
            'harness://fork/starter-warm?request=2b6b4b8e-6f6a-4c64-9d1b-6f0d0c1a2b3c';
        final first = await _startOwned(childExecutable, [
          cold,
        ], environment: environment);
        var firstExited = false;
        unawaited(
          first.exitCode.then((_) {
            firstExited = true;
          }),
        );
        // This marker is written by Dart in the actual primary. Hold Dart ready
        // while a later launch forwards into the runner's pending-link queue.
        await _until(
          () => File('${log.path}.waiting-before-ready').existsSync(),
          within: const Duration(seconds: 60),
        );
        expect(
          File('${log.path}.waiting-before-ready').readAsStringSync(),
          '${first.pid}',
        );
        debugPrint(
          'Child startup marker confirmed: PID ${first.pid}, $childExecutable',
        );
        expect(firstExited, isFalse);
        expect(log.existsSync(), isFalse);
        final second = await _startOwned(childExecutable, [
          warm,
        ], environment: environment);
        expect(
          await second.exitCode.timeout(const Duration(seconds: 30)),
          0,
          reason: 'the later launch forwarded and exited before Dart ready',
        );
        expect(firstExited, isFalse);
        await File('${log.path}.release').writeAsString('ready', flush: true);
        await _until(
          () => File('${log.path}.ready').existsSync(),
          within: const Duration(seconds: 30),
        );
        expect(File('${log.path}.ready').readAsStringSync(), '${first.pid}');
        List<String> lines() =>
            log.readAsLinesSync().where((line) => line.isNotEmpty).toList();
        await Future<void>.delayed(const Duration(seconds: 3));
        expect(lines(), [cold, warm]);
        expect(
          firstExited,
          isFalse,
          reason: 'only the original app remains running',
        );
        final quit = await _startOwned(childExecutable, [
          '--quit',
        ], environment: environment);
        expect(await quit.exitCode.timeout(_channelTimeout), 0);
        expect(
          await first.exitCode.timeout(_channelTimeout),
          0,
          reason: 'the primary exited after --quit',
        );
        expect(lines(), [cold, warm]);
      });
    },
    skip: skip,
  );

  testWidgets('notifications and tray answer application-channel calls', (
    tester,
  ) async {
    await tester.runAsync(() async {
      final answer = await const MethodChannel('harness/notifications')
          .invokeMethod<String>('authorize')
          .timeout(_channelTimeout);
      // CI normally lacks the installed Start Menu shortcut carrying the AUMID.
      // Windows may not know its setting until the first toast registers it.
      expect(['granted', 'denied', 'unavailable', 'unknown'], contains(answer));
      addTearDown(
        () => const MethodChannel('harness/status_menu')
            .invokeMethod<void>('update', {
              'entries': <Object?>[],
              'workingEntries': <Object?>[],
              'workspaceAvailable': false,
            })
            .timeout(_channelTimeout),
      );
      await const MethodChannel('harness/status_menu')
          .invokeMethod<void>('update', {
            'entries': [
              {
                'machineId': 'm',
                'agentId': 'a',
                'title': 'Fix & ship',
                'unread': true,
                'receivedAt': DateTime.now().millisecondsSinceEpoch,
              },
            ],
            'workingEntries': <Object?>[],
            'workspaceAvailable': true,
          })
          .timeout(_channelTimeout);
    });
  }, skip: skip);
}

Future<Directory> _scratch(String prefix) async {
  final root = await Directory.systemTemp.createTemp(prefix);
  addTearDown(() async {
    if (await root.exists()) await root.delete(recursive: true);
  });
  return root;
}

Future<Map<String, String>> _childEnvironment(Directory root, File log) async {
  final profile = await Directory('${root.path}\\profile').create();
  final roaming = await Directory('${profile.path}\\AppData\\Roaming')
      .create(recursive: true);
  final local = await Directory('${profile.path}\\AppData\\Local')
      .create(recursive: true);
  return {
    'FLUTTER_TEST': '1',
    'HARNESS_DESKTOP_INSTANCE':
        'race-$pid-${root.path.split(Platform.pathSeparator).last}',
    'HARNESS_RUNNER_TEST_CHILD': log.path,
    'HOME': profile.path,
    'USERPROFILE': profile.path,
    'APPDATA': roaming.path,
    'LOCALAPPDATA': local.path,
    'TEMP': root.path,
    'TMP': root.path,
  };
}

Future<Process> _startOwned(
  String executable,
  List<String> arguments, {
  Map<String, String>? environment,
}) async {
  final process = await Process.start(
    executable,
    arguments,
    environment: environment,
    workingDirectory: File(executable).isAbsolute
        ? File(executable).parent.path
        : File(Platform.resolvedExecutable).parent.path,
  );
  var exited = false;
  final output = StringBuffer();
  var drained = Future<void>.value();
  // Register before starting another resource; terminate only this owned PID.
  addTearDown(() async {
    if (!exited) process.kill();
    await process.exitCode.timeout(
      const Duration(seconds: 10),
      onTimeout: () => throw TimeoutException(
        'owned PID ${process.pid} did not exit:\n$output',
      ),
    );
    await drained.timeout(const Duration(seconds: 10));
  });
  unawaited(
    process.exitCode.then((code) {
      exited = true;
      if (code != 0) {
        debugPrint('Owned PID ${process.pid} exited $code:\n$output');
      }
    }),
  );
  drained = Future.wait([
    process.stdout
        .transform(const Utf8Decoder(allowMalformed: true))
        .forEach(output.write),
    process.stderr
        .transform(const Utf8Decoder(allowMalformed: true))
        .forEach(output.write),
  ]).then((_) {});
  return process;
}

Future<void> _until(
  bool Function() done, {
  Duration within = _channelTimeout,
}) async {
  final watch = Stopwatch()..start();
  while (!done()) {
    if (watch.elapsed >= within) fail('condition not met within $within');
    await Future<void>.delayed(const Duration(milliseconds: 50));
  }
}

Future<void> _powershell(String script) async {
  final units = ("\$ErrorActionPreference = 'Stop'\n$script").codeUnits;
  final bytes = Uint8List(units.length * 2);
  for (var i = 0; i < units.length; i++) {
    bytes[2 * i] = units[i] & 0xff;
    bytes[2 * i + 1] = units[i] >> 8;
  }
  final process = await _startOwned('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-STA',
    '-EncodedCommand',
    base64Encode(bytes),
  ]);
  expect(await process.exitCode.timeout(_channelTimeout), 0);
}

Future<Uint8List> _png(int width, int height, Color color) async {
  final recorder = ui.PictureRecorder();
  ui.Canvas(recorder).drawRect(
    Rect.fromLTWH(0, 0, width.toDouble(), height.toDouble()),
    Paint()..color = color,
  );
  final picture = recorder.endRecording();
  try {
    final image = await picture.toImage(width, height);
    try {
      final data = (await image.toByteData(format: ui.ImageByteFormat.png))!;
      return data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes);
    } finally {
      image.dispose();
    }
  } finally {
    picture.dispose();
  }
}

const _jpeg =
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDBooor7U8E/9k=';
