import 'dart:async';

import 'package:flutter/material.dart';

import '../../shared/theme/app_icons.dart';
import '../../shared/theme/app_theme.dart' as grid;
import '../appearance/palette_section.dart';
import '../../shared/theme/appearance_prefs_store.dart';
import '../../shared/widgets/app_select_field.dart';
import '../../shared/widgets/setting_row.dart';
import '../../shortcuts/app_keymap.dart';
import '../../widgets/key_hints.dart';

/// Appearance ▸ Workspace: inactive pane shading, automatic tab names and the
/// colour palette. (The class keeps its old name; the tab was Appearance.)
///
/// Palettes coordinate the workspace and terminal defaults. The shared font
/// and size are configured once in Appearance ▸ Terminal.
class AppearanceSection extends StatelessWidget {
  const AppearanceSection({super.key, this.store});
  final AppearancePrefsStore? store;

  /// Fits both pane styles' names and icons at the app's text size.
  static const double _paneStyleWidth = 260;

  /// A switch whose track, not its touch margin, ends at the row's edge: on the
  /// line the fields and buttons above and below it end on.
  static Widget _edgeSwitch({
    required Key key,
    required bool value,
    required ValueChanged<bool> onChanged,
  }) => Align(
    alignment: Alignment.centerLeft,
    child: Switch(
      key: key,
      value: value,
      materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
      onChanged: onChanged,
    ),
  );

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
            builder: (context, prefs, _) {
              final panes = prefs.panes;
              void set(PanePrefs next) => unawaited(preferences.setPanes(next));
              Widget toggle({
                required String title,
                required String key,
                required String detail,
                required bool value,
                required ValueChanged<bool> onChanged,
              }) => Padding(
                padding: const EdgeInsets.only(bottom: 10),
                child: SettingRow(
                  title: title,
                  controlSemanticLabel: title,
                  // Every row here says what it does: a row with no detail
                  // draws no card, and its control ends at another edge.
                  detail: detail,
                  control: _edgeSwitch(
                    key: ValueKey(key),
                    value: value,
                    onChanged: onChanged,
                  ),
                ),
              );
              return Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Padding(
                    padding: const EdgeInsets.only(bottom: 10),
                    child: SettingRow(
                      title: 'Pane style',
                      detail: 'Compact panes are square and touch each other.',
                      // A set width: beside the title it would otherwise take
                      // all it likes, squeezing the words to nothing in the
                      // narrow Customize pane, and past its edge at larger text.
                      control: SizedBox(
                        width: _paneStyleWidth,
                        child: SegmentedButton<PaneStyle>(
                          key: const ValueKey('pane-style'),
                          showSelectedIcon: false,
                          expandedInsets: EdgeInsets.zero,
                          style: SegmentedButton.styleFrom(
                            selectedBackgroundColor: grid.AppDesktop.selection,
                            selectedForegroundColor:
                                grid.AppDesktop.onSelection,
                          ),
                          segments: [
                            for (final style in PaneStyle.values)
                              ButtonSegment(
                                value: style,
                                icon: Icon(
                                  style == PaneStyle.compact
                                      ? AppIcons.panelsTopLeft
                                      : AppIcons.layoutGrid,
                                  size: AppIcons.inlineSize,
                                ),
                                label: Text(
                                  style.label,
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                ),
                              ),
                          ],
                          selected: {panes.style},
                          onSelectionChanged: (selection) =>
                              set(panes.copyWith(style: selection.first)),
                        ),
                      ),
                    ),
                  ),
                  toggle(
                    title: 'Highlight active pane edges',
                    key: 'highlight-active-pane',
                    detail: 'Draw a blue edge around the selected pane.',
                    value: panes.highlightActive,
                    onChanged: (enabled) =>
                        set(panes.copyWith(highlightActive: enabled)),
                  ),
                  Padding(
                    padding: const EdgeInsets.only(bottom: 10),
                    child: SettingRow(
                      title: 'Fade inactive panes',
                      detail:
                          'Fade panes that aren’t selected.'
                          '${shortcut == null ? '' : ' Toggle with $shortcut.'}',
                      control: Align(
                        alignment: Alignment.centerLeft,
                        child: AppSelectField<PaneFade>(
                          key: const ValueKey('fade-inactive-panes'),
                          width: 180,
                          value: panes.fade,
                          options: [
                            for (final fade in PaneFade.values)
                              SelectOption(value: fade, label: fade.label),
                          ],
                          onChanged: (fade) => set(panes.copyWith(fade: fade)),
                        ),
                      ),
                    ),
                  ),
                  toggle(
                    title: 'Autobalance splits',
                    key: 'autobalance-splits',
                    detail: 'Even out pane sizes when you split a pane or move one.',
                    value: panes.autobalanceSplits,
                    onChanged: (enabled) =>
                        set(panes.copyWith(autobalanceSplits: enabled)),
                  ),
                  toggle(
                    title: 'Focus follows mouse',
                    key: 'focus-follows-mouse',
                    detail: 'Select a pane by pointing at it.',
                    value: panes.focusFollowsMouse,
                    onChanged: (enabled) =>
                        set(panes.copyWith(focusFollowsMouse: enabled)),
                  ),
                ],
              );
            },
          ),
          ValueListenableBuilder<AppearancePrefs>(
            valueListenable: preferences,
            builder: (context, prefs, _) => SettingRow(
              title: 'Auto rename',
              controlSemanticLabel: 'Auto rename tabs',
              detail:
                  'Names a tab for its repo and the work in it, in the '
                  'background — e.g. Harness TUI LMStudio',
              control: _edgeSwitch(
                key: const ValueKey('auto-rename-tabs'),
                value: prefs.autoRenameTabs,
                onChanged: (enabled) =>
                    unawaited(preferences.setAutoRenameTabs(enabled)),
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
