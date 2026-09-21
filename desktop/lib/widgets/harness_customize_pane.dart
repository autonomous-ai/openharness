import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../settings/sections/appearance_section.dart';
import '../settings/sections/terminal_section.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/theme/appearance_prefs_store.dart';
import '../shared/theme/harness_background.dart';
import 'swarm_wallpaper.dart';
import 'box_chrome.dart';
import 'prompt_customize.dart';

/// Page-local customization. Appearance and Terminal use their existing stores
/// and controls, so moving them here keeps the user's saved choices intact.
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
                          'Customize OpenHarness',
                          style: boxMonoStyle(
                            size: 14,
                            color: grid.AppPalette.textPrimary,
                            weight: FontWeight.w600,
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
                  labelStyle: boxMonoStyle(size: 12),
                  tabs: const [
                    Tab(key: ValueKey('customize-prompt'), text: 'Prompt'),
                    Tab(
                      key: ValueKey('customize-background'),
                      text: 'Wallpaper',
                    ),
                    Tab(
                      key: ValueKey('customize-appearance'),
                      text: 'Appearance',
                    ),
                    Tab(key: ValueKey('customize-terminal'), text: 'Terminal'),
                  ],
                ),
                Expanded(
                  child: TabBarView(
                    children: [
                      PromptCustomize(store: store ?? appearancePrefsStore),
                      _Backgrounds(store: store ?? appearancePrefsStore),
                      const AppearanceSection(),
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

class _Backgrounds extends StatelessWidget {
  const _Backgrounds({required this.store});
  final AppearancePrefsStore store;

  @override
  Widget build(BuildContext context) => SingleChildScrollView(
    padding: const EdgeInsets.all(20),
    child: ValueListenableBuilder<AppearancePrefs>(
      valueListenable: store,
      builder: (context, prefs, _) => LayoutBuilder(
        builder: (context, constraints) => Wrap(
          spacing: 12,
          runSpacing: 12,
          children: [
            for (final choice in HarnessBackground.values)
              SizedBox(
                width: (constraints.maxWidth - 12) / 2,
                child: _BackgroundChoice(
                  choice: choice,
                  selected: prefs.background == choice,
                  onChoose: () => unawaited(store.setBackground(choice)),
                ),
              ),
          ],
        ),
      ),
    ),
  );
}

class _BackgroundChoice extends StatelessWidget {
  const _BackgroundChoice({
    required this.choice,
    required this.selected,
    required this.onChoose,
  });
  final HarnessBackground choice;
  final bool selected;
  final VoidCallback onChoose;

  @override
  Widget build(BuildContext context) => Semantics(
    selected: selected,
    button: true,
    label: '${choice.label} wallpaper',
    onTap: onChoose,
    child: ExcludeSemantics(
      child: TextButton(
        key: ValueKey('background-${choice.name}'),
        onPressed: onChoose,
        style: TextButton.styleFrom(
          padding: const EdgeInsets.all(6),
          foregroundColor: grid.AppPalette.textPrimary,
          backgroundColor: grid.AppPalette.cardBg,
          side: BorderSide(
            color: selected
                ? grid.AppPalette.swarmAccent
                : grid.AppPalette.divider,
            width: 1.5,
          ),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(12),
          ),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            ClipRRect(
              borderRadius: BorderRadius.circular(7),
              child: AspectRatio(
                aspectRatio: 1.6,
                child: SwarmWallpaper(background: choice, thumbnail: true),
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(4, 8, 4, 4),
              child: Row(
                children: [
                  Expanded(child: Text(choice.label)),
                  const SizedBox(width: 4),
                  SizedBox(
                    width: 16,
                    child: selected ? const Icon(Icons.check, size: 16) : null,
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    ),
  );
}
