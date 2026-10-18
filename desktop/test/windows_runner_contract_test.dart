// The Windows runner's C++ cannot run on the Mac that implements it, and its
// contracts are with Dart and with the launcher (`Harness.exe`, C4), which
// read none of it. This reads the source, as `nativeIconLoaderOpens` reads
// SwarmTitlebar.swift, so a renamed constant or a source file left out of the
// build fails here first. Windows CI then compiles the runner, and
// integration_test/windows_runner_test.dart runs it.
@TestOn('vm')
library;

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

String runner(String name) => File('windows/runner/$name').readAsStringSync();

void main() {
  test('every runner source is in the build', () {
    final cmake = runner('CMakeLists.txt');
    final sources = Directory('windows/runner')
        .listSync()
        .whereType<File>()
        .map((file) => file.uri.pathSegments.last)
        .where((name) => name.endsWith('.cpp'));
    for (final name in sources) {
      expect(cmake, contains('"$name"'), reason: '$name is not compiled');
    }
  });

  group('single instance', () {
    test('the launcher finds the app by a fixed window and quits it by a '
        'fixed message', () {
      final header = runner('single_instance.h');
      // Harness.exe registers the same name (pty/src/desktop/win.rs, QUIT_MESSAGE).
      expect(
        header,
        contains(
          'constexpr wchar_t kHarnessQuitMessageName[] = '
          'L"Autonomous.Harness.Quit";',
        ),
      );
      expect(
        header,
        contains(
          'static constexpr wchar_t kWindowClass[] = L"HarnessSingleInstance";',
        ),
      );
      expect(
        header,
        contains(
          'constexpr ULONG_PTR kHarnessCopyDataCommandLine = 0x48524E53;',
        ),
      );
      final source = runner('single_instance.cpp');
      expect(source, contains(r'L"Local\\Harness-"'));
      expect(source, contains('L"HARNESS_DESKTOP_INSTANCE"'));
      expect(source, contains('FindWindowExW(HWND_MESSAGE'));
      expect(
        source,
        contains('RegisterWindowMessageW(kHarnessQuitMessageName)'),
      );
      // The launcher posts it to the main window, not the single-instance one.
      final window = runner('flutter_window.cpp');
      expect(window, contains('IsHarnessQuitMessage(message)'));
    });

    test('a later launch forwards at most once and opens no window', () {
      final source = runner('single_instance.cpp');
      // A send that timed out may still be read: it is never sent again.
      expect(source, contains('ERROR_TIMEOUT ? Delivery::kUnknown'));
      final main = runner('main.cpp');
      final acquire = main.indexOf('single_instance.Acquire()');
      expect(acquire, isNonNegative);
      expect(
        main.indexOf('FlutterWindow window(project)'),
        greaterThan(acquire),
        reason: 'no window before the instance is this process',
      );
      expect(
        main.indexOf('single_instance.Listen('),
        greaterThan(main.indexOf('window.Create(')),
      );
      expect(main, contains('"--quit"'));
    });
  });

  test('links reach Dart on the channel macOS and Linux use', () {
    final links = runner('community_links.cpp');
    expect(links, contains('"harness/community_links"'));
    expect(links, contains('"ready"'));
    expect(links, contains('"open"'));
    expect(links, contains('kMaxLinkLength = 240'));
    expect(links, contains('kMaxPending = 20'));
    expect(
      runner('flutter_window.cpp'),
      contains('DeliverCommandLine(command_line)'),
    );
    final main = runner('main.cpp');
    final deliver = main.indexOf('DeliverArguments(command_line_arguments)');
    expect(deliver, isNonNegative, reason: 'a link at launch waits for ready');
    expect(
      main.indexOf('std::move(command_line_arguments)'),
      greaterThan(deliver),
    );
  });
}
