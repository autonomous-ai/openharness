import 'dart:async';

import 'package:flutter/material.dart';

import '../../shared/theme/app_theme.dart' as grid;
import '../appearance/palette_section.dart';
import '../../shared/theme/appearance_prefs_store.dart';
import '../../shared/widgets/setting_row.dart';
import '../../shortcuts/app_keymap.dart';
import '../../widgets/key_hints.dart';

/// Customize Harness ▸ Appearance: how the app looks on this Mac.
///
/// Palettes coordinate the workspace and terminal defaults. The shared font
/// and size are configured once in Customize Harness ▸ Terminal.
class AppearanceSection extends StatelessWidget {
  const AppearanceSection({super.key, this.store});
  final AppearancePrefsStore? store;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final preferences = store ?? appearancePrefsStore;
    final shortcut = KeyHints.visibleOf(context)
        ? effectiveCommandHint(context, 'pane.toggle_shading')
        : null;
    return SingleChildScrollView(
      padding: const EdgeInsets.all(20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          ValueListenableBuilder<AppearancePrefs>(
            valueListenable: preferences,
            builder: (context, prefs, _) => SettingRow(
              title: 'Shade inactive panes',
              controlSemanticLabel: 'Shade inactive panes',
              detail:
                  'Add a gray shade to panes that aren’t selected.'
                  '${shortcut == null ? '' : ' Toggle with $shortcut.'}',
              control: Align(
                alignment: Alignment.centerLeft,
                child: Switch(
                  key: const ValueKey('shade-inactive-panes'),
                  value: prefs.shadeInactivePanes,
                  onChanged: (enabled) =>
                      unawaited(preferences.setShadeInactivePanes(enabled)),
                ),
              ),
            ),
          ),
          const SizedBox(height: 10),
          ValueListenableBuilder<AppearancePrefs>(
            valueListenable: preferences,
            builder: (context, prefs, _) => SettingRow(
              title: 'Auto rename',
              controlSemanticLabel: 'Auto rename tabs',
              detail:
                  'Names a tab for its repo and the work in it, in the '
                  'background — e.g. Harness TUI LMStudio',
              control: Align(
                alignment: Alignment.centerLeft,
                child: Switch(
                  key: const ValueKey('auto-rename-tabs'),
                  value: prefs.autoRenameTabs,
                  onChanged: (enabled) =>
                      unawaited(preferences.setAutoRenameTabs(enabled)),
                ),
              ),
            ),
          ),
          const SizedBox(height: 24),
          PaletteSection(store: store),
          // Room under the last card so a scrolled-to-bottom pane does not end
          // flush against the window edge.
          const SizedBox(height: 8),
        ],
      ),
    );
  }
}
