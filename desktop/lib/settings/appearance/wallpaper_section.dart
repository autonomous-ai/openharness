import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../shared/theme/app_theme.dart' as grid;
import '../../shared/theme/appearance_prefs_store.dart';
import '../../shared/theme/harness_background.dart';
import '../../terminal/terminal_text.dart';
import '../../widgets/swarm_wallpaper.dart';

class WallpaperSection extends StatelessWidget {
  const WallpaperSection({super.key, this.store});
  final AppearancePrefsStore? store;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    TerminalFontScope.watch(context);
    final prefs = store ?? appearancePrefsStore;
    return ValueListenableBuilder<AppearancePrefs>(
      valueListenable: prefs,
      builder: (context, value, _) => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'Wallpaper',
            style: terminalTextStyle(
              color: grid.AppPalette.textPrimary,
              fontWeight: FontWeight.w600,
            ),
          ),
          const SizedBox(height: 8),
          Text(
            'A little curiosity for your new tabs.',
            style: terminalTextStyle(color: grid.AppPalette.textSecondary),
          ),
          const SizedBox(height: 16),
          LayoutBuilder(
            builder: (context, constraints) {
              final columns =
                  constraints.maxWidth >=
                      300 * math.max(1, terminalTextScaleOf(context))
                  ? 2
                  : 1;
              final width =
                  (constraints.maxWidth - (columns - 1) * 12) / columns;
              return Wrap(
                spacing: 12,
                runSpacing: 16,
                children: [
                  for (final choice in HarnessBackground.gallery)
                    SizedBox(
                      width: width,
                      child: Semantics(
                        button: true,
                        selected: value.background == choice,
                        label: '${choice.label} wallpaper',
                        child: Material(
                          color: Colors.transparent,
                          child: InkWell(
                            key: ValueKey('wallpaper-${choice.name}'),
                            onTap: () => prefs.setBackground(choice),
                            borderRadius: BorderRadius.circular(8),
                            child: Padding(
                              padding: const EdgeInsets.all(3),
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Container(
                                    clipBehavior: Clip.antiAlias,
                                    decoration: BoxDecoration(
                                      borderRadius: BorderRadius.circular(8),
                                      border: Border.all(
                                        color: value.background == choice
                                            ? grid.AppPalette.swarmAccent
                                            : grid.AppPalette.divider,
                                        width: 2,
                                      ),
                                    ),
                                    child: AspectRatio(
                                      aspectRatio: 16 / 9,
                                      child: Stack(
                                        fit: StackFit.expand,
                                        children: [
                                          SwarmWallpaper(
                                            background: choice,
                                            thumbnail: true,
                                          ),
                                          if (value.background == choice)
                                            const Positioned(
                                              right: 8,
                                              bottom: 8,
                                              child: Icon(
                                                Icons.check_circle,
                                                color: Colors.white,
                                                size: 20,
                                              ),
                                            ),
                                        ],
                                      ),
                                    ),
                                  ),
                                  const SizedBox(height: 8),
                                  Text(
                                    choice.label,
                                    style: terminalTextStyle(
                                      color: grid.AppPalette.textPrimary,
                                    ),
                                  ),
                                ],
                              ),
                            ),
                          ),
                        ),
                      ),
                    ),
                ],
              );
            },
          ),
        ],
      ),
    );
  }
}
