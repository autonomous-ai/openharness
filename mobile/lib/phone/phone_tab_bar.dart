import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';

/// The three places a phone can be. Agents first: it is where the app opens and the only tab with
/// anything to act on.
///
/// Lucide, like the rest of the app's navigation — Settings' rail and the desktop machine rail are
/// both Lucide 300, and Material's own glyphs are a heavier, rounder family that reads as a
/// different product beside them. `smartToy`, the obvious Material pick for an agent, is a
/// toy robot head; these are terminals, which is what [PhoneTab.agents] actually lists.
enum PhoneTab {
  agents(
    LucideIcons.squareTerminal300,
    LucideIcons.squareTerminal400,
    'Agents',
  ),
  machines(
    LucideIcons.laptopMinimal300,
    LucideIcons.laptopMinimal400,
    'Machines',
  ),
  settings(LucideIcons.settings300, LucideIcons.settings400, 'Settings');

  const PhoneTab(this.icon, this.selectedIcon, this.label);

  final IconData icon;

  /// The tab you are on, drawn a weight heavier rather than filled.
  ///
  /// A line-art set has no filled variant to switch to, and Lucide ships the same glyph at 100–600
  /// instead — so the selected tab thickens where a Material one would solidify. Same purpose: a
  /// second signal beside colour, for anyone who cannot use the colour.
  final IconData selectedIcon;

  final String label;
}

/// The bar along the bottom of the phone's root pages.
///
/// Drawn only on the three root pages. A pushed page — a terminal, a machine's agents — covers it,
/// because a terminal needs the bottom of the screen for its composer and key row, and three
/// layers of chrome stacked under the thumb is what that would otherwise be.
class PhoneTabBar extends StatelessWidget {
  const PhoneTabBar({
    super.key,
    required this.current,
    required this.onSelect,
    this.waitingCount = 0,
  });

  final PhoneTab current;
  final ValueChanged<PhoneTab> onSelect;

  /// How many agents are waiting on an answer — the badge on the Agents tab. Zero draws none.
  final int waitingCount;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return DecoratedBox(
      decoration: BoxDecoration(
        color: AppPalette.panelBg,
        border: Border(top: BorderSide(color: AppGlass.hair)),
      ),
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.only(top: 6, bottom: 2),
          child: Row(
            children: [
              for (final tab in PhoneTab.values)
                Expanded(
                  child: _Tab(
                    tab: tab,
                    selected: tab == current,
                    badge: tab == PhoneTab.agents ? waitingCount : 0,
                    onTap: () => onSelect(tab),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

class _Tab extends StatelessWidget {
  const _Tab({
    required this.tab,
    required this.selected,
    required this.badge,
    required this.onTap,
  });

  final PhoneTab tab;
  final bool selected;
  final int badge;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final color = selected
        ? AppPalette.accentOnSurface
        : AppPalette.textSecondary;
    return Semantics(
      button: true,
      selected: selected,
      label: badge > 0 ? '${tab.label}, $badge waiting' : tab.label,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(10),
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 5),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              // The badge rides the icon, so the label below stays on one baseline across tabs.
              Stack(
                clipBehavior: Clip.none,
                children: [
                  Icon(
                    selected ? tab.selectedIcon : tab.icon,
                    size: 23,
                    color: color,
                  ),
                  if (badge > 0)
                    Positioned(top: -4, left: 14, child: _Badge(count: badge)),
                ],
              ),
              const SizedBox(height: 3),
              Text(
                tab.label,
                style: TextStyle(
                  color: color,
                  fontSize: 10.5,
                  fontWeight: FontWeight.w500,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _Badge extends StatelessWidget {
  const _Badge({required this.count});

  final int count;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return Container(
      constraints: const BoxConstraints(minWidth: 16),
      padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 1),
      decoration: BoxDecoration(
        color: AppPalette.warn,
        borderRadius: BorderRadius.circular(999),
        // A rim in the bar's own colour, so the badge reads as a separate mark rather than
        // smudging into the icon it overlaps.
        border: Border.all(color: AppPalette.panelBg, width: 1.5),
      ),
      alignment: Alignment.center,
      child: Text(
        // Past 99 the exact figure stops meaning anything and the pill would widen off the icon.
        count > 99 ? '99+' : '$count',
        style: TextStyle(
          // The ink follows the theme because the fill does: [AppPalette.warn] is a light amber in
          // dark (#FFB020) and a dark ochre in light (#B45309). One fixed ink cannot carry both —
          // measured, a dark numeral reads 9.71:1 on dark's fill but only 3.54:1 on light's, under
          // the 4.5:1 floor. White on light's fill is 5.02:1.
          color: AppTheme.pick(Colors.white, const Color(0xFF181818)),
          fontSize: 10,
          height: 1.2,
          fontWeight: FontWeight.w700,
          fontFeatures: AppFont.tabularFigures,
        ),
      ),
    );
  }
}
