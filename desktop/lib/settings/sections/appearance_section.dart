import 'package:flutter/material.dart';

import '../../shared/theme/app_theme.dart' as grid;
import '../appearance/palette_section.dart';

/// Customize Harness ▸ Appearance: how the app looks on this Mac.
///
/// Palettes coordinate the workspace and terminal defaults. The shared font
/// and size are configured once in Customize Harness ▸ Terminal.
class AppearanceSection extends StatelessWidget {
  const AppearanceSection({super.key});

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return SingleChildScrollView(
      padding: const EdgeInsets.all(20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: const [
          PaletteSection(),
          // Room under the last card so a scrolled-to-bottom pane does not end
          // flush against the window edge.
          SizedBox(height: 8),
        ],
      ),
    );
  }
}
