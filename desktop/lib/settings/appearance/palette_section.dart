import 'dart:async';

import 'package:flutter/material.dart';
import 'package:harness/terminal/terminal_text.dart';

import '../../shared/theme/app_theme.dart' as grid;
import '../../shared/theme/appearance_prefs_store.dart';
import '../../shared/theme/color_palette.dart';
import '../../shared/widgets/section_heading.dart';

class PaletteSection extends StatelessWidget {
  const PaletteSection({super.key, this.store});
  final AppearancePrefsStore? store;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final preferences = store ?? appearancePrefsStore;
    return ValueListenableBuilder<AppearancePrefs>(
      valueListenable: preferences,
      builder: (context, prefs, _) => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const SectionHeading('Color palette'),
          const SizedBox(height: 12),
          LayoutBuilder(
            builder: (context, constraints) {
              final columns = constraints.maxWidth >= 660
                  ? 3
                  : constraints.maxWidth >= 360
                  ? 2
                  : 1;
              final width =
                  (constraints.maxWidth - 12 * (columns - 1)) / columns;
              return Wrap(
                spacing: 12,
                runSpacing: 12,
                children: [
                  for (final palette in HarnessPalette.values)
                    SizedBox(
                      width: width,
                      child: _PaletteChoice(
                        palette: palette,
                        selected: prefs.palette == palette,
                        onChoose: () =>
                            unawaited(preferences.setPalette(palette)),
                      ),
                    ),
                ],
              );
            },
          ),
          const SizedBox(height: 24),
        ],
      ),
    );
  }
}

class _PaletteChoice extends StatelessWidget {
  const _PaletteChoice({
    required this.palette,
    required this.selected,
    required this.onChoose,
  });
  final HarnessPalette palette;
  final bool selected;
  final VoidCallback onChoose;

  @override
  Widget build(BuildContext context) {
    TerminalFontScope.watch(context);
    return Semantics(
      button: true,
      selected: selected,
      onTap: onChoose,
      label: '${palette.label} palette',
      child: ExcludeSemantics(
        child: TextButton(
          key: ValueKey('palette-${palette.name}'),
          onPressed: onChoose,
          style: ButtonStyle(
            padding: const WidgetStatePropertyAll(EdgeInsets.all(8)),
            backgroundColor: WidgetStatePropertyAll(palette.panel),
            overlayColor: const WidgetStatePropertyAll(Colors.white10),
            side: WidgetStateProperty.resolveWith(
              (states) => BorderSide(
                color: selected || states.contains(WidgetState.focused)
                    ? palette.accent
                    : Colors.white12,
                width: selected || states.contains(WidgetState.focused)
                    ? 1.5
                    : 1,
              ),
            ),
            shape: WidgetStatePropertyAll(
              RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
            ),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              _WorkspacePreview(palette: palette),
              const SizedBox(height: 8),
              Row(
                children: [
                  Expanded(
                    child: Text(
                      palette.label,
                      style: terminalTextStyle(
                        color: Colors.white,
                        fontWeight: FontWeight.w500,
                      ),
                    ),
                  ),
                  SizedBox(
                    width: 16,
                    child: selected
                        ? Icon(Icons.check, size: 16, color: palette.accent)
                        : null,
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _WorkspacePreview extends StatelessWidget {
  const _WorkspacePreview({required this.palette});
  final HarnessPalette palette;

  @override
  Widget build(BuildContext context) {
    TerminalFontScope.watch(context);
    return ClipRRect(
      borderRadius: BorderRadius.circular(4),
      child: SizedBox(
        height: 76,
        child: ColoredBox(
          color: palette.workspace,
          child: Column(
            children: [
              ColoredBox(
                color: palette.tabBar,
                child: SizedBox(
                  height: 16,
                  child: Row(
                    children: [
                      const SizedBox(width: 6),
                      for (var i = 0; i < 3; i++)
                        Padding(
                          padding: const EdgeInsets.only(right: 3),
                          child: Container(
                            width: 3,
                            height: 3,
                            decoration: const BoxDecoration(
                              color: Colors.white38,
                              shape: BoxShape.circle,
                            ),
                          ),
                        ),
                      const SizedBox(width: 6),
                      Container(
                        width: 40,
                        height: 12,
                        margin: const EdgeInsets.only(top: 4),
                        color: palette.workspace,
                      ),
                      const Spacer(),
                      Container(
                        width: 28,
                        height: 6,
                        margin: const EdgeInsets.only(right: 6),
                        decoration: BoxDecoration(
                          color: palette.search,
                          borderRadius: BorderRadius.circular(3),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
              Expanded(
                child: Padding(
                  padding: const EdgeInsets.all(4),
                  child: Row(
                    children: [
                      for (var pane = 0; pane < 2; pane++) ...[
                        if (pane > 0) const SizedBox(width: 4),
                        Expanded(
                          child: Container(
                            padding: const EdgeInsets.all(6),
                            decoration: BoxDecoration(
                              color: palette.background,
                              borderRadius: BorderRadius.circular(3),
                              border: pane == 0
                                  ? Border.all(
                                      color: palette.accent.withValues(
                                        alpha: 0.65,
                                      ),
                                    )
                                  : null,
                            ),
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Container(
                                  width: 20,
                                  height: 3,
                                  color: palette.accent,
                                ),
                                const SizedBox(height: 6),
                                FractionallySizedBox(
                                  widthFactor: 0.85,
                                  child: Container(
                                    height: 2,
                                    color: Colors.white54,
                                  ),
                                ),
                                const SizedBox(height: 4),
                                FractionallySizedBox(
                                  widthFactor: 0.6,
                                  child: Container(
                                    height: 2,
                                    color: Colors.white30,
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ),
                      ],
                    ],
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
