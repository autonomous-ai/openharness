import 'package:flutter/material.dart';
import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/services.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shortcuts/app_keymap.dart';
import '../shortcuts/keymap.dart';
import '../shortcuts/keymap_commands.dart';
import '../shortcuts/keymap_keyboard.dart';
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
      // From whichever door opened it, Settings says when it is on top: the
      // title-bar row stays live over it and closes it before acting.
      pageBuilder: (context, animation, _) => _OnTop(
        child: SettingsScreen(
          notifier: notifier,
          initialSection: initialSection,
          experimentalFeatures: experimentalFeatures,
          source: source,
          compactBelow: compactBelow,
        ),
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

/// The Settings page while it is the current route, nothing over it; null
/// otherwise. A page, not a dialog: the workspace keeps its title-bar row live
/// over it, and a click there pops it ([ModalRoute.navigator]) before acting.
final settingsPageOnTop = ValueNotifier<ModalRoute<Object?>?>(null);

class _OnTop extends StatefulWidget {
  const _OnTop({required this.child});

  final Widget child;

  @override
  State<_OnTop> createState() => _OnTopState();
}

class _OnTopState extends State<_OnTop> {
  ModalRoute<Object?>? _route;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _route = ModalRoute.of(context);
    if (ModalRoute.isCurrentOf(context) ?? false) {
      settingsPageOnTop.value = _route;
    } else {
      _leave();
    }
  }

  void _leave() {
    if (settingsPageOnTop.value == _route) settingsPageOnTop.value = null;
  }

  @override
  void dispose() {
    _leave();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => widget.child;
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
      !kIsWeb && widget.initialSection == SettingsSection.privacy
      ? SettingsSection.experimental
      : widget.initialSection ?? kDefaultSettingsSection;

  /// Narrow screens only: a section is open over the list. Opening Settings on
  /// a named section starts there; otherwise the list comes first.
  late bool _sectionOpen = widget.initialSection != null;

  bool get _compact => MediaQuery.sizeOf(context).width < widget.compactBelow;

  /// Escape, or Close Tab's key (⌘W unless the person moved it), leaves
  /// Settings as Back to app does. Signed out there is no workspace under it
  /// to hear ⌘W, so Settings hears it itself (Scholes's end-to-end test).
  KeyEventResult _key(FocusNode node, KeyEvent event) {
    if (event is! KeyDownEvent ||
        ModalRoute.of(context)?.isCurrent == false ||
        !(_isEscape(event) || _isCloseTab(event))) {
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

  bool _isEscape(KeyEvent event) {
    final keys = HardwareKeyboard.instance;
    return event.logicalKey == LogicalKeyboardKey.escape &&
        !keys.isControlPressed &&
        !keys.isAltPressed &&
        !keys.isMetaPressed &&
        !keys.isShiftPressed;
  }

  bool _isCloseTab(KeyEvent event) {
    final stroke = keyStrokeForEvent(event);
    if (stroke == null) return false;
    final keymap =
        KeymapTheme.of(context, listen: false)?.current ?? harnessDefaultKeymap;
    return keymap
        .bindingsFor(KeymapContext.workspace)
        .any(
          (binding) =>
              binding.command == 'swarm.close' &&
              binding.keys.length == 1 &&
              binding.keys.single == stroke,
        );
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
    // A scope, not a plain Focus: a click that takes the keyboard off a field
    // leaves it here, where Escape and ⌘W are still heard, rather than on the
    // route above this page.
    return FocusScope(
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
