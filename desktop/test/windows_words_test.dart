import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// A person on a Windows PC reads Windows words. These files may name a Mac:
/// each says it behind a platform check, or is Mac-only code.
const _sayMacBehindACheck = {
  'lib/core/browser_label.dart',
  'lib/core/process_responsibility.dart',
  'lib/core/repository_clone.dart',
  'lib/models/model_search_catalog.dart',
  'lib/notify/system_notifications.dart',
  'lib/settings/sections/terminal_section.dart',
  'lib/shortcuts/shortcut_recorder.dart',
  'lib/state/harness_monitor.dart',
  'lib/super_tabs/team_account_setup.dart',
  'lib/super_tabs/voice_row.dart',
  'lib/autonomous_device/autonomous_device_cli.dart',
  'lib/devices/wifi_robots.dart',
  'lib/bootstrap/environment_provisioner.dart',
  'lib/core/desktop_build.dart',
  'lib/shortcuts/app_shortcuts.dart',
  'lib/store/store_editorial.dart',
  'lib/widgets/box_chrome.dart',
  'lib/widgets/daemon_slot.dart',
  'lib/widgets/dsh_install_panel.dart',
  'lib/widgets/remote_folder_picker.dart',
  'lib/widgets/swarm_switcher.dart',
  'lib/widgets/terminal_panel.dart',
};

final _macWords = RegExp(
  r'''['"][^'"\n]*(this Mac|your Mac|macOS|⌘|System Settings|brew install)[^'"\n]*['"]''',
);

void main() {
  test('no screen shows a Mac word to a person on Windows', () {
    final offenders = <String>[];
    for (final file in Directory('lib').listSync(recursive: true)) {
      if (file is! File || !file.path.endsWith('.dart')) continue;
      if (file.path.endsWith('.g.dart')) continue;
      final path = file.path.replaceAll(r'\', '/');
      if (_sayMacBehindACheck.contains(path)) continue;
      final lines = file.readAsLinesSync();
      for (var i = 0; i < lines.length; i++) {
        final line = lines[i].trimLeft();
        if (line.startsWith('//')) continue;
        // A string naming every system together is true everywhere.
        if (line.contains('Windows')) continue;
        if (_macWords.hasMatch(line)) offenders.add('$path:${i + 1}: $line');
      }
    }
    expect(offenders, isEmpty);
  });
}
