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

  test('toasts post under the AUMID and open their link when clicked', () {
    final main = runner('main.cpp');
    final aumid = main.indexOf(
      'SetCurrentProcessExplicitAppUserModelID(L"Autonomous.Harness")',
    );
    expect(aumid, isNonNegative);
    expect(aumid, lessThan(main.indexOf('single_instance.Acquire()')));
    final toast = runner('notifications.cpp');
    expect(toast, contains('L"Autonomous.Harness"'));
    expect(toast, contains(r'activationType=\"protocol\"'));
    expect(toast, contains('"harness/notifications"'));
    for (final method in ['"authorize"', '"show"', '"withdraw"']) {
      expect(toast, contains(method));
    }
    final cmake = runner('CMakeLists.txt');
    expect(cmake, contains('"windowsapp.lib"'));
    expect(cmake, contains('set_source_files_properties("notifications.cpp"'));
  });

  test('only the WinRT toast source requires C++20', () {
    final cmake = runner('CMakeLists.txt');
    expect(
      cmake,
      contains('add_library(harness_notifications OBJECT "notifications.cpp")'),
    );
    expect(cmake, contains('apply_standard_settings(harness_notifications)'));
    expect(
      cmake,
      contains(
        'target_compile_features(harness_notifications PRIVATE cxx_std_20)',
      ),
    );
    expect(
      cmake,
      contains(
        'target_link_libraries(\${BINARY_NAME} PRIVATE harness_notifications '
        '"windowsapp.lib")',
      ),
    );
    final executableSources = RegExp(r'add_executable\([\s\S]*?\n\)')
        .firstMatch(cmake)!
        .group(0)!;
    expect(executableSources, isNot(contains('"notifications.cpp"')));
    expect(
      File('windows/CMakeLists.txt').readAsStringSync(),
      contains('target_compile_features(\${TARGET} PUBLIC cxx_std_17)'),
    );
  });

  test('the tray mirrors the macOS status menu, and the close button hides '
      'to it', () {
    final tray = runner('tray.cpp');
    for (final text in [
      '"harness/status_menu"',
      '"update"',
      '"quit"',
      '"selected"',
      '"openApp"',
      '"hidden"',
      'L"All caught up"',
      'L"Open Harness to get started"',
      'L"Open Harness"',
      'L"Quit"',
    ]) {
      expect(tray, contains(text));
    }
    final window = runner('flutter_window.cpp');
    final close = window.indexOf('message == WM_CLOSE && !quitting_');
    expect(close, isNonNegative);
    expect(
      close,
      lessThan(window.indexOf('HandleTopLevelWindowProc')),
      reason: 'decided before Flutter and window_manager see WM_CLOSE',
    );
  });
  test('the clipboard and fonts answer the names Dart calls', () {
    final clipboard = runner('clipboard_image.cpp');
    for (final text in [
      '"harness/clipboard_image"',
      '"readImagePng"',
      '"writeImagePng"',
      '"readFilePaths"',
      'L"PNG"',
      'CF_DIBV5',
      'CF_HDROP',
      'GUID_ContainerFormatPng',
    ]) {
      expect(clipboard, contains(text));
    }
    final fonts = runner('fonts.cpp');
    for (final text in [
      '"harness/fonts"',
      '"listFonts"',
      'EnumFontFamiliesExW',
      'RASTER_FONTTYPE',
      '"family"',
      '"mono"',
    ]) {
      expect(fonts, contains(text));
    }
    expect(runner('CMakeLists.txt'), contains('"windowscodecs.lib"'));
  });
}
