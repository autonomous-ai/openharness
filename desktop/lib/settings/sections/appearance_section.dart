import 'package:flutter/material.dart';

import '../../shared/theme/app_theme.dart' as grid;
import '../appearance/palette_section.dart';
import '../appearance/wallpaper_section.dart';
import '../../shared/theme/appearance_prefs_store.dart';

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
    return SingleChildScrollView(
      padding: const EdgeInsets.all(20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const PaletteSection(),
          const SizedBox(height: 24),
          WallpaperSection(store: store),
          // Room under the last card so a scrolled-to-bottom pane does not end
          // flush against the window edge.
          const SizedBox(height: 8),
        ],
      ),
    );
  }
}
