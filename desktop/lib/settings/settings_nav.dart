import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:harness/terminal/terminal_text.dart';

import '../shared/layouts/widgets/rail_section_header.dart';
import '../shared/layouts/widgets/sidebar_item.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/section_scaffold.dart';
import 'settings_section.dart';

/// The settings list: the way back, a field that narrows the list to what you
/// type, then one row per screen with the open one highlighted.
class SettingsNav extends StatefulWidget {
  const SettingsNav({super.key, required this.section, required this.onSelect});

  final SettingsSection section;
  final ValueChanged<SettingsSection> onSelect;

  /// The machine rail's own default width, so Settings opens without the left
  /// column jumping.
  static const double width = 260;

  @override
  State<SettingsNav> createState() => _SettingsNavState();
}

class _SettingsNavState extends State<SettingsNav> {
  String _query = '';
  final _search = TextEditingController();
  final _searchFocus = FocusNode(debugLabel: 'Search settings');

  @override
  void dispose() {
    _search.dispose();
    _searchFocus.dispose();
    super.dispose();
  }

  bool get _composing =>
      _search.value.composing.isValid && !_search.value.composing.isCollapsed;

  void _chooseMatch() {
    if (_composing || _query.trim().isEmpty) return;
    final match = _visible.expand((group) => group.sections).firstOrNull;
    if (match != null) widget.onSelect(match);
  }

  KeyEventResult _searchKey(FocusNode node, KeyEvent event) {
    if (event is! KeyDownEvent && event is! KeyRepeatEvent) {
      return KeyEventResult.ignored;
    }
    final keys = HardwareKeyboard.instance;
    if (keys.isControlPressed ||
        keys.isMetaPressed ||
        keys.isAltPressed ||
        keys.isShiftPressed) {
      return KeyEventResult.ignored;
    }
    final key = event.logicalKey;
    final enter =
        key == LogicalKeyboardKey.enter ||
        key == LogicalKeyboardKey.numpadEnter;
    final down = key == LogicalKeyboardKey.arrowDown;
    final up = key == LogicalKeyboardKey.arrowUp;
    if (!enter && !down && !up) return KeyEventResult.ignored;
    if (_composing) return KeyEventResult.skipRemainingHandlers;
    if (enter) {
      if (event is KeyDownEvent) _chooseMatch();
    } else if (down) {
      if (_visible.isNotEmpty) _searchFocus.nextFocus();
    } else {
      _searchFocus.previousFocus();
    }
    return KeyEventResult.handled;
  }

  /// The groups, narrowed to the query. Matching is a plain case-insensitive
  /// substring of the label — this list is short, so anything cleverer
  /// would be machinery no one can feel. A group's own title matches too, so
  /// typing "help" surfaces the whole run rather than nothing.
  List<SettingsGroup> get _visible {
    final query = _query.trim().toLowerCase();
    // The list this build actually has: [settingsGroups] drops the developer
    // rows a release build does not ship.
    final all = settingsGroups;
    if (query.isEmpty) return all;
    final groups = <SettingsGroup>[];
    for (final group in all) {
      if (group.title.toLowerCase().contains(query)) {
        groups.add(group);
        continue;
      }
      final rows = [
        for (final target in group.sections)
          if (target.label.toLowerCase().contains(query)) target,
      ];
      if (rows.isNotEmpty) groups.add(SettingsGroup(group.title, rows));
    }
    return groups;
  }

  @override
  Widget build(BuildContext context) {
    // The rail and the section begin below the native title bar.
    grid.AppTheme.watch(context);
    return Container(
      width: SettingsNav.width,
      color: grid.AppSurface.recess,
      child: Padding(
        // Rows add their own icon gutter: their glyphs and group captions sit
        // on the same 24px content inset as the section on the right.
        padding: const EdgeInsets.symmetric(
          horizontal: SectionScaffold.contentPadding - SidebarItem.iconGutter,
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const SizedBox(height: SectionScaffold.contentPadding),
            // A SidebarItem like the rows below, so the way out hovers,
            // highlights and aligns exactly like them instead of being a
            // shrink-wrapped button in its own grey.
            SizedBox(
              height: SectionScaffold.headingHeight(context),
              child: Center(
                child: SidebarItem(
                  key: const Key('settings-back-button'),
                  icon: LucideIcons.arrowLeft300,
                  label: 'Back to app',
                  onTap: () => Navigator.of(context).maybePop(),
                ),
              ),
            ),
            const SizedBox(height: 12),
            Focus(
              onKeyEvent: _searchKey,
              skipTraversal: true,
              child: _SearchField(
                controller: _search,
                focusNode: _searchFocus,
                onChanged: (value) => setState(() => _query = value),
                onSubmitted: (_) => _chooseMatch(),
              ),
            ),
            const SizedBox(height: 8),
            Expanded(child: _navList()),
          ],
        ),
      ),
    );
  }

  Widget _navList() {
    final visible = _visible;
    if (visible.isEmpty) return const _NoMatches();
    return ListView(
      padding: const EdgeInsets.only(bottom: 10),
      children: [
        for (final group in visible) ...[
          RailSectionHeader(label: group.title),
          for (final target in group.sections)
            SidebarItem(
              icon: target.icon,
              label: target.label,
              selected: target == widget.section,
              onTap: () => widget.onSelect(target),
            ),
        ],
      ],
    );
  }
}

/// The rail's filter, styled like the machine rail's own — the app has one
/// shape for "narrow this list".
class _SearchField extends StatelessWidget {
  const _SearchField({
    required this.controller,
    required this.focusNode,
    required this.onChanged,
    required this.onSubmitted,
  });

  final TextEditingController controller;
  final FocusNode focusNode;
  final ValueChanged<String> onChanged;
  final ValueChanged<String> onSubmitted;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    // Same as the rail's filter field: sized and filled by the theme at
    // AppControl.heightField (36) rather than clamped to a button's 32.
    return TextField(
      // Keyed because the Appearance pane now carries fields of its own, so a
      // test reaching for "the" TextField would find three.
      key: const Key('settings-search-field'),
      controller: controller,
      focusNode: focusNode,
      autofocus: true,
      onChanged: onChanged,
      onSubmitted: onSubmitted,
      onEditingComplete: () {},
      textInputAction: TextInputAction.search,
      style: grid.kFieldTextStyle,
      decoration: InputDecoration(
        hintText: 'Search settings',
        prefixIcon: Icon(
          LucideIcons.search300,
          size: grid.kFieldIconSize,
          color: grid.AppPalette.textFaint,
        ),
      ),
    );
  }
}

/// What the rail shows when the query matches nothing — so a typo reads as "no
/// results" rather than a rail that mysteriously emptied.
class _NoMatches extends StatelessWidget {
  const _NoMatches();

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(10, 16, 10, 0),
      child: Text(
        'No settings match',
        style: terminalTextStyle(color: grid.AppPalette.textFaint),
      ),
    );
  }
}
