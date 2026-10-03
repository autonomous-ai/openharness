import 'package:harness/shared/theme/app_icons.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../settings/appearance/wallpaper_section.dart';
import '../settings/sections/appearance_section.dart';
import '../settings/sections/terminal_section.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/theme/appearance_prefs_store.dart';
import '../shared/widgets/app_dialog.dart';
import 'desktop_chrome.dart';
import 'prompt_customize.dart';

/// Opens customization over the workspace so appearance changes remain visible
/// on the terminals. All global entry points use this same right-side panel.
Future<void> showHarnessCustomizePane(
  BuildContext context, {
  ValueChanged<bool>? onCurrentChanged,
  double bottomInset = 0,
}) => showAppDialog<void>(
  context: context,
  onCurrentChanged: onCurrentChanged,
  veilTint: Colors.transparent,
  veilBlur: 0,
  transitionDuration: Duration.zero,
  builder: (context) => Padding(
    padding: EdgeInsets.only(bottom: bottomInset),
    child: Align(
      alignment: Alignment.centerRight,
      child: SizedBox(
        width: (440 * grid.appTextScaleOf(context)).clamp(
          0,
          MediaQuery.sizeOf(context).width,
        ),
        height: double.infinity,
        child: HarnessCustomizePane(onClose: () => Navigator.pop(context)),
      ),
    ),
  ),
);

/// Customization tabs share the app's existing preference stores.
class HarnessCustomizePane extends StatelessWidget {
  const HarnessCustomizePane({super.key, required this.onClose, this.store});
  final VoidCallback onClose;
  final AppearancePrefsStore? store;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final tabHeight = (MediaQuery.textScalerOf(context).scale(13) * 1.25 + 20)
        .clamp(44.0, double.infinity);
    return Material(
      key: const ValueKey('harness-customize-pane'),
      color: grid.AppPalette.panelBg,
      shape: Border(
        left: BorderSide(
          color: MediaQuery.highContrastOf(context)
              ? DesktopChrome.foreground.withValues(alpha: .45)
              : DesktopChrome.rim,
        ),
      ),
      child: FocusScope(
        child: CallbackShortcuts(
          bindings: {const SingleActivator(LogicalKeyboardKey.escape): onClose},
          child: DefaultTabController(
            length: 4,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Padding(
                  padding: const EdgeInsets.fromLTRB(24, 16, 16, 12),
                  child: Row(
                    children: [
                      Expanded(
                        child: Text(
                          'Customize Harness',
                          style: DesktopChrome.heading(),
                        ),
                      ),
                      IconButton(
                        key: const ValueKey('harness-customize-close'),
                        autofocus: true,
                        tooltip: 'Close customization',
                        onPressed: onClose,
                        style:
                            IconButton.styleFrom(
                              minimumSize: const Size(32, 32),
                              padding: const EdgeInsets.all(6),
                            ).copyWith(
                              side: WidgetStateProperty.resolveWith(
                                (states) => BorderSide(
                                  width: 1.5,
                                  color: states.contains(WidgetState.focused)
                                      ? DesktopChrome.accent
                                      : Colors.transparent,
                                ),
                              ),
                            ),
                        icon: const Icon(AppIcons.close, size: 20),
                      ),
                    ],
                  ),
                ),
                TabBar(
                  isScrollable: true,
                  tabAlignment: TabAlignment.start,
                  padding: const EdgeInsets.symmetric(horizontal: 12),
                  labelPadding: const EdgeInsets.symmetric(horizontal: 4),
                  labelColor: DesktopChrome.foreground,
                  unselectedLabelColor: DesktopChrome.muted,
                  indicatorColor: DesktopChrome.accent,
                  dividerColor: grid.AppPalette.divider,
                  labelStyle: DesktopChrome.control(medium: true),
                  unselectedLabelStyle: DesktopChrome.control(),
                  overlayColor: WidgetStateProperty.resolveWith(
                    (states) => DesktopChrome.foreground.withValues(
                      alpha: states.contains(WidgetState.pressed)
                          ? .12
                          : states.contains(WidgetState.hovered)
                          ? .05
                          : 0,
                    ),
                  ),
                  tabs: [
                    Tab(
                      key: const ValueKey('customize-prompt'),
                      height: tabHeight,
                      child: const _CustomizeTabLabel('Status'),
                    ),
                    Tab(
                      key: const ValueKey('customize-appearance'),
                      height: tabHeight,
                      child: const _CustomizeTabLabel('Appearance'),
                    ),
                    Tab(
                      key: const ValueKey('customize-wallpaper'),
                      height: tabHeight,
                      child: const _CustomizeTabLabel('Wallpaper'),
                    ),
                    Tab(
                      key: const ValueKey('customize-terminal'),
                      height: tabHeight,
                      child: const _CustomizeTabLabel('Terminal'),
                    ),
                  ],
                ),
                Expanded(
                  child: TabBarView(
                    children: [
                      PromptCustomize(store: store ?? appearancePrefsStore),
                      AppearanceSection(store: store),
                      SingleChildScrollView(
                        padding: const EdgeInsets.all(20),
                        child: WallpaperSection(store: store),
                      ),
                      const TerminalSection(),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _CustomizeTabLabel extends StatelessWidget {
  const _CustomizeTabLabel(this.label);
  final String label;

  @override
  Widget build(BuildContext context) => DecoratedBox(
    decoration: BoxDecoration(
      borderRadius: BorderRadius.circular(DesktopChrome.controlRadius),
      border: Border.all(
        width: 1.5,
        color: Focus.of(context).hasFocus
            ? DesktopChrome.accent
            : Colors.transparent,
      ),
    ),
    child: Padding(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
      child: Text(label),
    ),
  );
}
