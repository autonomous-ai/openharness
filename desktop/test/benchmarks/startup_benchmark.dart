// Run explicitly: flutter test --no-pub test/benchmarks/startup_benchmark.dart
// Measures settings initialization in the debug runner with temporary files.
// It does not measure a cold process launch, native window or first frame.
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/harness_file_store.dart';
import 'package:harness/core/snapshot_store.dart';
import 'package:harness/core/startup.dart';
import 'package:harness/notify/alert_sounds.dart';
import 'package:harness/notify/system_notifications.dart';
import 'package:harness/shared/theme/appearance_prefs_store.dart';
import 'package:harness/shared/theme/color_palette.dart';
import 'package:harness/shortcuts/app_keymap.dart';
import 'package:harness/shortcuts/keymap_commands.dart';
import 'package:harness/shortcuts/keymap_store.dart';
import 'package:harness/stats/harness_stats.dart';
import 'package:harness/terminal/terminal_font_store.dart';
import 'package:harness/terminal/terminal_theme_store.dart';

Map<String, num> distribution(List<int> times) {
  times.sort();
  return {
    'samples': times.length,
    'medianMs': times[times.length ~/ 2] / 1000,
    'p95Ms': times[(times.length * .95).ceil() - 1] / 1000,
  };
}

void main() {
  test('isolated persisted settings and keyboard initialization', () async {
    final directory = await Directory.systemTemp.createTemp(
      'harness-startup-benchmark-',
    );
    addTearDown(() => directory.delete(recursive: true));
    final preferences = Directory('${directory.path}/preferences');
    final storage = HarnessFileStore(directory: preferences);
    await storage.write('terminal_font_family', 'menlo');
    await storage.write('terminal_font_size', '17');
    await storage.write('app_ui_font_family', 'Helvetica Neue');
    await storage.write('app_ui_font_size', '16');
    await storage.write('app_color_palette', 'forest');
    final statsStore = FileSnapshotStore('stats', directory: directory);
    await statsStore.write(
      jsonEncode({
        'version': 1,
        'agentsSpawned': 12,
        'turns': 34,
        'workedMs': 56000,
      }),
    );
    final keymapFile = File('${directory.path}/config/keybindings.jsonc');
    await keymapFile.parent.create();
    await keymapFile.writeAsString(
      '{"bindings":[{"keys":"cmd+g","command":"swarm.new"}]}',
    );

    for (final withKeymap in [false, true]) {
      final times = <int>[];
      // Fresh store objects, warm filesystem. Never read the user's settings.
      for (var sample = -20; sample < 100; sample++) {
        final storage = HarnessFileStore(directory: preferences);
        final font = TerminalFontStore(storage: storage);
        final scheme = TerminalThemeStore(storage: storage);
        final appearance = AppearancePrefsStore(storage: storage);
        final stats = HarnessStats(store: statsStore);
        final keymapStore = KeymapStore(
          file: keymapFile,
          defaults: harnessDefaultBindings,
          commands: harnessCommandById.keys.toSet(),
          validate: (map) =>
              AppKeymap.validateNativeKeys(map, macOS: Platform.isMacOS),
        );
        final keymap = AppKeymap(store: keymapStore);
        try {
          final watch = Stopwatch()..start();
          await Future.wait([
            loadPersistedSettings(
              terminalFont: font,
              terminalTheme: scheme,
              appearance: appearance,
              stats: stats,
              alertSounds: AlertSoundStore(storage: storage),
              screenAlerts: ScreenAlertStore(storage: storage),
              desktopNotifications: DesktopNotificationStore(storage: storage),
            ),
            if (withKeymap) keymap.start(),
          ]);
          watch.stop();
          if (sample >= 0) times.add(watch.elapsedMicroseconds);
          expect(font.family, TerminalFontChoice.menlo);
          expect(font.size, 17);
          expect(appearance.value.uiFamily, 'Helvetica Neue');
          expect(appearance.value.uiSize, 16);
          expect(appearance.value.palette, HarnessPalette.forest);
          expect(stats.summary.agentsSpawned, 12);
          if (withKeymap) {
            expect(keymap.error, isNull);
            expect(keymap.bindings('swarm.new').length, 2);
          }
        } finally {
          keymap.dispose();
          keymapStore.dispose();
          stats.dispose();
          font.dispose();
          scheme.dispose();
          appearance.dispose();
        }
      }
      // Only timing and a fixed workload label leave the fixture.
      debugPrint(
        'STARTUP_BENCH ${jsonEncode({'kind': 'headless_debug_warm_filesystem', 'operation': withKeymap ? 'settings_and_keymap' : 'settings', ...distribution(times)})}',
      );
    }
  });
}
