import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../state/app_state.dart';
import '../widgets/harness_customize_pane.dart';
import 'experimental_features.dart';
import 'settings_body.dart';
import 'settings_compact.dart';
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
  ExperimentalFeaturesStore? experimentalFeatures,
  Future<void> Function()? onCustomize,
  // Which door opened Settings. No longer read since analytics was removed;
  // kept so the callers need not change.
  required String source,
  // Narrower than this, the list and a section take turns on the screen (a
  // phone). Desktop passes nothing: its window never gets that narrow.
  double compactBelow = 0,
}) async {
  if (initialSection == SettingsSection.customize) {
    await (onCustomize?.call() ?? showHarnessCustomizePane(context));
    return;
  }
  final action = await Navigator.of(context).push<SettingsSection>(
    PageRouteBuilder<SettingsSection>(
      // Opaque: it covers the window, and letting the shell show through would
      // mean compositing four live terminals under it for nothing.
      pageBuilder: (context, animation, _) => SettingsScreen(
        notifier: notifier,
        initialSection: initialSection,
        experimentalFeatures: experimentalFeatures,
        source: source,
        compactBelow: compactBelow,
      ),
      transitionDuration: Duration.zero,
      reverseTransitionDuration: Duration.zero,
    ),
  );
  // Leave the opaque Settings route before opening the panel, keeping the
  // active terminals visible behind the controls and retaining caller focus.
  if (action == SettingsSection.customize && context.mounted) {
    await (onCustomize?.call() ?? showHarnessCustomizePane(context));
  }
}

/// Settings: pick on the left, work on the right.
class SettingsScreen extends StatefulWidget {
  const SettingsScreen({
    super.key,
    required this.notifier,
    this.initialSection,
    this.experimentalFeatures,
    this.source = 'unknown',
    this.compactBelow = 0,
  }) : assert(
         initialSection != SettingsSection.customize,
         'Open workspace actions through showSettingsScreen.',
       );

  final AppNotifier notifier;
  final ExperimentalFeaturesStore? experimentalFeatures;

  /// The door that opened this screen. Unread since analytics was removed.
  /// Defaulted only for tests that build the screen directly; every app door
  /// goes through [showSettingsScreen], where it is `required`.
  final String source;

  /// Which row Settings opens on. Null takes [kDefaultSettingsSection] — the
  /// first row of the first group, so the screen never opens on a pane its rail
  /// does not show as selected.
  final SettingsSection? initialSection;

  /// Below this width the list of sections and one section take turns on the
  /// screen instead of sitting side by side.
  final double compactBelow;

  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  late SettingsSection _section =
      widget.initialSection ?? kDefaultSettingsSection;

  /// Narrow screens only: a section is open over the list. Opening Settings on
  /// a named section starts there; otherwise the list comes first.
  late bool _sectionOpen = widget.initialSection != null;

  bool get _compact => MediaQuery.sizeOf(context).width < widget.compactBelow;

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

  /// Move to another pane, from the settings rail.
  void _show(SettingsSection target) {
    if (target == SettingsSection.customize) {
      Navigator.of(context).pop(target);
      return;
    }
    if (_compact) setState(() => _sectionOpen = true);
    if (target == _section) return;
    setState(() => _section = target);
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    // The native title bar already owns window dragging. Settings starts below
    // it, with the same content inset on both sides of the divider.
    final body = SettingsBody(
      section: _section,
      notifier: widget.notifier,
      experimentalFeatures: widget.experimentalFeatures,
    );
    if (_compact) {
      return SettingsCompactScreen(
        section: _section,
        sectionOpen: _sectionOpen,
        onSelect: _show,
        onBack: () => setState(() => _sectionOpen = false),
        onKeyEvent: _key,
        body: body,
      );
    }
    return Focus(
      onKeyEvent: _key,
      child: Scaffold(
        backgroundColor: grid.AppPalette.windowBg,
        body: Row(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            SettingsNav(section: _section, onSelect: _show),
            VerticalDivider(width: 1, color: grid.AppPalette.divider),
            Expanded(child: body),
          ],
        ),
      ),
    );
  }
}
