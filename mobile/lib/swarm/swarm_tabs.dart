import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/phone/out_of_sight.dart';
import 'package:harness_mobile/phone/tty.dart';
import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/app_type.dart';

import 'swarm_needs_page.dart';
import 'swarm_page.dart';
import 'swarm_session.dart';
import 'swarm_style.dart';
import 'swarm_you_page.dart';

/// Swarm's four tabs, along the foot of the screen in this order, as Tony's
/// prototype C draws them (2026-10-30).
enum SwarmTab {
  /// Swarm Home: the Swarms' projects, and what moved in them.
  home,

  /// The person's Buddy in each project.
  buddies,

  /// What needs the person, and what came for them.
  activity,

  /// The person: their status, models, devices and Settings.
  you,
}

/// A count on a tab's glyph: blue, or yellow ([warn]) for what waits on the
/// person.
typedef SwarmTabBadge = ({int count, bool warn});

/// One of [SwarmTabsPage]'s tabs: its name and glyph on the bar, the screen
/// it opens, and maybe a count on it.
class SwarmTabEntry {
  const SwarmTabEntry({
    required this.tab,
    required this.label,
    required this.icon,
    required this.screen,
    this.badge,
  });

  final SwarmTab tab;
  final String label;
  final IconData icon;

  /// The tab's screen: made the first time the tab opens, then kept as it
  /// was left, out of sight ([OutOfSight]), while another is open.
  final WidgetBuilder screen;

  /// The count on the glyph, from the account's Swarm, read again whenever
  /// the Swarm changes; none for null or 0.
  final SwarmTabBadge? Function(SwarmSession session)? badge;
}

/// Swarm's tabs, in the bar's order: each part of Swarm plugs its screen in
/// here, one entry each: Home, Needs you with what waits on the person
/// counted, and You. [onSettings] opens the phone's Settings over the tabs,
/// from Home's drawer and from You.
///
/// Buddies is not on the bar until its screen comes (part b of direction
/// C): main has no list of Buddies, each is in its project.
List<SwarmTabEntry> swarmTabs({
  void Function(BuildContext context)? onSettings,
}) => [
  SwarmTabEntry(
    tab: SwarmTab.home,
    label: 'Home',
    icon: LucideIcons.house300,
    screen: (_) => SwarmPage(onSettings: onSettings),
  ),
  SwarmTabEntry(
    tab: SwarmTab.activity,
    label: 'Activity',
    icon: LucideIcons.bell300,
    screen: (_) => const SwarmNeedsPage(),
    badge: (session) => (count: session.inbox.needs.length, warn: true),
  ),
  SwarmTabEntry(
    tab: SwarmTab.you,
    label: 'You',
    icon: LucideIcons.circleUser300,
    screen: (_) => SwarmYouPage(onSettings: onSettings),
  ),
];

/// Opens [tab] of the tabs [context] is under; false under none, as on a
/// page pushed over them.
bool showSwarmTab(BuildContext context, SwarmTab tab) {
  final scope = context.getInheritedWidgetOfExactType<_SwarmTabsScope>();
  if (scope == null) return false;
  scope.show(tab);
  return true;
}

/// Swarm at the root of the phone's stack: one screen at a time over the
/// tab bar ([SwarmTabBar]), Swarm Home first. A page opened from a tab (a
/// project, a chat) covers the bar until it closes.
///
/// Each screen is made the first time its tab opens, and kept, out of sight,
/// while another is open: the person comes back to it as they left it.
/// Back on another tab goes to Home first; at Home, and while Harness covers
/// the tabs, back is not the tabs'.
class SwarmTabsPage extends StatefulWidget {
  const SwarmTabsPage({super.key, this.onSettings, this.tabs});

  /// The phone's Settings over the tabs, from Home's drawer and from You.
  final void Function(BuildContext context)? onSettings;

  /// The tabs, in the bar's order; [swarmTabs] when null.
  final List<SwarmTabEntry>? tabs;

  @override
  State<SwarmTabsPage> createState() => _SwarmTabsPageState();
}

class _SwarmTabsPageState extends State<SwarmTabsPage> {
  late final List<SwarmTabEntry> _tabs =
      widget.tabs ?? swarmTabs(onSettings: widget.onSettings);

  late SwarmTab _open = _tabs.first.tab;

  /// Each screen as it was first made, by its tab: handed back unchanged
  /// after, so opening a tab builds nothing under the others.
  final _screens = <SwarmTab, Widget>{};

  void _show(SwarmTab tab) {
    if (tab == _open || !_tabs.any((entry) => entry.tab == tab)) return;
    setState(() => _open = tab);
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final home = _tabs.first.tab;
    // Harness over the tabs: its back, not theirs.
    final hidden = OutOfSight.of(context);
    for (final entry in _tabs) {
      if (entry.tab == _open) _screens[entry.tab] ??= entry.screen(context);
    }
    return PopScope<Object?>(
      canPop: _open == home || hidden,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) _show(home);
      },
      child: _SwarmTabsScope(
        show: _show,
        child: Scaffold(
          backgroundColor: Tty.of(context).ground,
          body: Stack(
            fit: StackFit.expand,
            children: [
              for (final entry in _tabs)
                if (_screens[entry.tab] case final screen?)
                  KeptOutOfSight(
                    key: ValueKey('swarm-tab-screen-${entry.tab.name}'),
                    hidden: entry.tab != _open,
                    child: screen,
                  ),
            ],
          ),
          bottomNavigationBar: SwarmTabBar(
            tabs: _tabs,
            open: _open,
            onOpen: _show,
          ),
        ),
      ),
    );
  }
}

/// How a screen under the tabs opens another ([showSwarmTab]).
class _SwarmTabsScope extends InheritedWidget {
  const _SwarmTabsScope({required this.show, required super.child});

  final ValueChanged<SwarmTab> show;

  @override
  bool updateShouldNotify(_SwarmTabsScope oldWidget) => false;
}

/// The bar along the foot of Swarm's tabs: each tab its glyph over its name,
/// a quarter of the width and at least 52 points tall, the open one in the
/// main ink, a count on a glyph while there is one; over the home indicator,
/// under a hairline.
class SwarmTabBar extends StatelessWidget {
  const SwarmTabBar({
    super.key,
    required this.tabs,
    required this.open,
    required this.onOpen,
  });

  final List<SwarmTabEntry> tabs;
  final SwarmTab open;
  final ValueChanged<SwarmTab> onOpen;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final session = SwarmScope.of(context);
    Widget bar(SwarmSession? session) => DecoratedBox(
      decoration: BoxDecoration(
        color: Tty.of(context).ground,
        border: Border(top: BorderSide(color: AppGlass.hair)),
      ),
      child: SafeArea(
        top: false,
        child: Row(
          children: [
            for (final entry in tabs)
              Expanded(
                child: _TabButton(
                  entry: entry,
                  open: entry.tab == open,
                  badge: session == null ? null : entry.badge?.call(session),
                  onTap: () => onOpen(entry.tab),
                ),
              ),
          ],
        ),
      ),
    );
    if (session == null || tabs.every((entry) => entry.badge == null)) {
      return bar(null);
    }
    return ListenWhileInSight(
      listenable: Listenable.merge([session, session.inbox, session.home]),
      builder: (context) => bar(session),
    );
  }
}

/// One tab on the bar: its glyph, with its count, over its name.
class _TabButton extends StatelessWidget {
  const _TabButton({
    required this.entry,
    required this.open,
    required this.badge,
    required this.onTap,
  });

  final SwarmTabEntry entry;
  final bool open;
  final SwarmTabBadge? badge;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final ink = open ? AppPalette.textPrimary : AppPalette.textSecondary;
    final name = entry.tab.name;
    final count = badge?.count ?? 0;
    void tap() {
      if (!open) HapticFeedback.selectionClick();
      onTap();
    }

    return Semantics(
      key: ValueKey('swarm-tab-$name'),
      button: true,
      selected: open,
      label: count > 0 ? '${entry.label}, $count' : entry.label,
      onTap: tap,
      excludeSemantics: true,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: tap,
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 52),
          child: Padding(
            padding: const EdgeInsets.only(
              top: AppSpace.s,
              bottom: AppSpace.xs,
            ),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Stack(
                  clipBehavior: Clip.none,
                  children: [
                    Icon(entry.icon, size: 26, color: ink),
                    if (count > 0)
                      Positioned(
                        left: 15,
                        top: -7,
                        child: SwarmBadge(
                          count,
                          key: ValueKey('swarm-tab-badge-$name'),
                          warn: badge!.warn,
                        ),
                      ),
                  ],
                ),
                const SizedBox(height: 3),
                Text(
                  entry.label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: AppType.caption(
                    color: ink,
                    fontWeight: open ? AppFont.semibold : AppFont.medium,
                    height: 1.2,
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
