import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../analytics/analytics.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../state/app_state.dart';
import '../widgets/harness_customize_pane.dart';
import 'sections/about_section.dart';
import 'sections/account_section.dart';
import 'sections/profiles_section.dart';
import 'sections/debug_section.dart';
import 'sections/devices_section.dart';
import 'sections/shortcuts_section.dart';
import 'sections/tracking_section.dart';
import 'sections/usage_section.dart';
import 'settings_nav.dart';
import 'settings_section.dart';

/// Opens Settings over the app.
///
/// A screen, not a dialog: the sections outgrew a 360px box the moment there
/// was more than one of them, and a settings *place* is what every desktop app
/// this one sits beside offers. It takes the whole window because none of this
/// is daily work, so it does not belong in the rail you drive terminals from.
///
/// Pushed as a route rather than switched into the shell: [AppNotifier] carries
/// no notion of "which screen", and a route needs none — the way back is
/// [Navigator.pop], and the shell underneath keeps its panes attached and its
/// terminals streaming while this is up.
Future<void> showSettingsScreen(
  BuildContext context,
  AppNotifier notifier, {
  SettingsSection? initialSection,
  // Which door opened Settings — see [AnalyticsEvents.screenView]. `required`,
  // because a pane reachable several ways is close to meaningless as a bare
  // count.
  required String source,
}) async {
  if (initialSection == SettingsSection.customize) {
    await showHarnessCustomizePane(context);
    return;
  }
  final action = await Navigator.of(context).push<SettingsSection>(
    PageRouteBuilder<SettingsSection>(
      // Opaque: it covers the window, and letting the shell show through would
      // mean compositing four live terminals under it for nothing.
      pageBuilder: (context, animation, _) => SettingsScreen(
        notifier: notifier,
        initialSection: initialSection,
        source: source,
      ),
      transitionDuration: Duration.zero,
      reverseTransitionDuration: Duration.zero,
    ),
  );
  // Leave the opaque Settings route before opening the panel, keeping the
  // active terminals visible behind the controls and retaining caller focus.
  if (action == SettingsSection.customize && context.mounted) {
    await showHarnessCustomizePane(context);
  }
}

/// Settings: pick on the left, work on the right.
class SettingsScreen extends StatefulWidget {
  const SettingsScreen({
    super.key,
    required this.notifier,
    this.initialSection,
    this.source = 'unknown',
  }) : assert(
         initialSection != SettingsSection.customize,
         'Open workspace actions through showSettingsScreen.',
       );

  final AppNotifier notifier;

  /// The door that opened this screen, reported with the first `screen_view`.
  /// Defaulted only for tests that build the screen directly; every app door
  /// goes through [showSettingsScreen], where it is `required`.
  final String source;

  /// Which row Settings opens on. Null takes [kDefaultSettingsSection] — the
  /// first row of the first group, so the screen never opens on a pane its rail
  /// does not show as selected.
  final SettingsSection? initialSection;

  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  late SettingsSection _section =
      widget.initialSection ?? kDefaultSettingsSection;

  KeyEventResult _key(FocusNode node, KeyEvent event) {
    if (event is! KeyDownEvent ||
        event.logicalKey != LogicalKeyboardKey.escape ||
        HardwareKeyboard.instance.isControlPressed ||
        HardwareKeyboard.instance.isAltPressed ||
        HardwareKeyboard.instance.isMetaPressed ||
        HardwareKeyboard.instance.isShiftPressed ||
        ModalRoute.of(context)?.isCurrent == false) {
      return KeyEventResult.ignored;
    }
    final editing = FocusManager.instance.primaryFocus?.context
        ?.findAncestorStateOfType<EditableTextState>()
        ?.widget
        .controller
        .value;
    if (editing != null &&
        editing.composing.isValid &&
        !editing.composing.isCollapsed) {
      return KeyEventResult.skipRemainingHandlers;
    }
    Navigator.of(context).maybePop();
    return KeyEventResult.handled;
  }

  @override
  void initState() {
    super.initState();
    // The pane Settings opens on is a screen view like any other — without it
    // the section a user lands on is the one section the stream never sees.
    // This one carries the door that OPENED Settings; every later view in this
    // visit came from the rail.
    analytics.screenView(_screenName(_section), source: widget.source);
  }

  /// Move to another pane, from the settings rail.
  void _show(SettingsSection target) {
    if (target == SettingsSection.customize) {
      Navigator.of(context).pop(target);
      return;
    }
    if (target == _section) return;
    analytics.screenView(_screenName(target), source: 'rail');
    setState(() => _section = target);
  }

  /// The section's stable name, never its label: labels are rewritten and a
  /// renamed label would read as a new screen. `SettingsSection.usage` becomes
  /// `settings_usage`, so a settings pane cannot collide with a top-level screen
  /// that happens to share a word.
  static String _screenName(SettingsSection section) =>
      'settings_${section.name}';

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    // The native title bar already owns window dragging. Settings starts below
    // it, with the same content inset on both sides of the divider.
    return Focus(
      onKeyEvent: _key,
      child: Scaffold(
        backgroundColor: grid.AppPalette.windowBg,
        body: Row(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            SettingsNav(section: _section, onSelect: _show),
            VerticalDivider(width: 1, color: grid.AppPalette.divider),
            Expanded(
              child: _SettingsBody(
                section: _section,
                notifier: widget.notifier,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// The screen behind a [SettingsSection].
///
/// Switch immediately, disposing the previous section instead of retaining it
/// for a cross-fade while the new section starts its work.
class _SettingsBody extends StatelessWidget {
  const _SettingsBody({required this.section, required this.notifier});

  final SettingsSection section;
  final AppNotifier notifier;

  @override
  Widget build(BuildContext context) {
    final screen = switch (section) {
      SettingsSection.account => AccountSection(notifier: notifier),
      SettingsSection.profiles => ProfilesSection(notifier: notifier),
      SettingsSection.usage => const UsageSection(),
      SettingsSection.customize => throw StateError(
        'Customization opens over the workspace.',
      ),
      SettingsSection.devices => const DevicesSection(),
      SettingsSection.shortcuts => const ShortcutsSection(),
      SettingsSection.debug => const DebugSection(),
      SettingsSection.tracking => const TrackingSection(),
      SettingsSection.about => AboutSection(notifier: notifier),
    };
    return KeyedSubtree(key: ValueKey(section), child: screen);
  }
}
