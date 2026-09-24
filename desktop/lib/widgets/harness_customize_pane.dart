import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../settings/appearance/wallpaper_section.dart';
import '../settings/sections/appearance_section.dart';
import '../settings/sections/terminal_section.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/theme/appearance_prefs_store.dart';
import '../shared/widgets/app_dialog.dart';
import 'prompt_customize.dart';

/// Opens customization over the workspace so appearance changes remain visible
/// on the terminals. All global entry points use this same right-side panel.
Future<void> showHarnessCustomizePane(BuildContext context) =>
    showAppDialog<void>(
      context: context,
      veilTint: Colors.transparent,
      veilBlur: 0,
      transitionDuration: Duration.zero,
      builder: (context) => Align(
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
    );

/// Customization tabs share the app's existing preference stores.
class HarnessCustomizePane extends StatelessWidget {
  const HarnessCustomizePane({super.key, required this.onClose, this.store});
  final VoidCallback onClose;
  final AppearancePrefsStore? store;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return Material(
      key: const ValueKey('harness-customize-pane'),
      color: grid.AppPalette.panelBg,
      shape: Border(left: BorderSide(color: grid.AppPalette.divider)),
      child: FocusScope(
        child: CallbackShortcuts(
          bindings: {const SingleActivator(LogicalKeyboardKey.escape): onClose},
          child: DefaultTabController(
            length: 4,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Padding(
                  padding: const EdgeInsets.fromLTRB(20, 12, 8, 8),
                  child: Row(
                    children: [
                      Expanded(
                        child: Text(
                          'Customize Harness',
                          style: grid.AppType.heading(
                            color: grid.AppPalette.textPrimary,
                          ),
                        ),
                      ),
                      IconButton(
                        key: const ValueKey('harness-customize-close'),
                        autofocus: true,
                        tooltip: 'Close customization',
                        onPressed: onClose,
                        icon: const Icon(Icons.close, size: 20),
                      ),
                    ],
                  ),
                ),
                TabBar(
                  isScrollable: true,
                  tabAlignment: TabAlignment.start,
                  labelColor: grid.AppPalette.swarmAccent,
                  unselectedLabelColor: grid.AppPalette.textSecondary,
                  indicatorColor: grid.AppPalette.swarmAccent,
                  dividerColor: grid.AppPalette.divider,
                  labelStyle: grid.AppType.label(),
                  tabs: const [
                    Tab(key: ValueKey('customize-prompt'), text: 'Status'),
                    Tab(
                      key: ValueKey('customize-appearance'),
                      text: 'Appearance',
                    ),
                    Tab(
                      key: ValueKey('customize-wallpaper'),
                      text: 'Wallpaper',
                    ),
                    Tab(key: ValueKey('customize-terminal'), text: 'Terminal'),
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
