import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';

import '../../shared/theme/app_icons.dart';
import '../../shared/theme/app_theme.dart' as grid;
import '../../shared/theme/file_type_icon.dart';
import '../../theme/app_theme.dart';
import '../finder_models.dart';
import '../finder_tabs.dart';
import 'finder_click.dart';

/// The open tabs, as Orca's tab bar draws them: a preview tab in italics
/// (the next single click replaces it), a dot for unsaved edits that turns
/// into × under the pointer, a double click to keep it, a middle click to
/// close it.
class FinderTabBar extends StatelessWidget {
  const FinderTabBar({super.key, required this.tabs, required this.onClose});

  final FinderTabs tabs;
  final ValueChanged<FinderTab> onClose;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return SizedBox(
      height: 32,
      child: ListView(
        scrollDirection: Axis.horizontal,
        children: [
          for (final tab in tabs.tabs)
            // Each tab hears its own file: saving clears its dot without
            // the tab list changing.
            ListenableBuilder(
              key: ValueKey('finder-tab-${tab.id}'),
              listenable: tab.document ?? tab.diff!,
              builder: (context, _) => _Tab(
                tab: tab,
                active: tab.id == tabs.activeId,
                onTap: () => tabs.activate(tab.id),
                onPin: () => tabs.pin(tab.id),
                onClose: () => onClose(tab),
              ),
            ),
        ],
      ),
    );
  }
}

class _Tab extends StatefulWidget {
  const _Tab({
    required this.tab,
    required this.active,
    required this.onTap,
    required this.onPin,
    required this.onClose,
  });

  final FinderTab tab;
  final bool active;
  final VoidCallback onTap, onPin, onClose;

  @override
  State<_Tab> createState() => _TabState();
}

class _TabState extends State<_Tab> {
  final _clicks = FinderClickTracker();
  bool _hovered = false;

  @override
  Widget build(BuildContext context) {
    final tab = widget.tab;
    final diff = tab.diff;
    return Listener(
      onPointerDown: (event) {
        if (event.buttons == kMiddleMouseButton) widget.onClose();
      },
      child: MouseRegion(
        onEnter: (_) => setState(() => _hovered = true),
        onExit: (_) => setState(() => _hovered = false),
        child: GestureDetector(
          // A second click pins, told apart by time: an onDoubleTap here
          // would hold every click — the × included — for the double-tap
          // window.
          onTap: () {
            widget.onTap();
            if (_clicks.isDouble(widget.tab.id)) widget.onPin();
          },
          child: Container(
            padding: const EdgeInsets.only(left: 10, right: 4),
            decoration: BoxDecoration(
              color: widget.active
                  ? grid.AppPalette.windowBg
                  : _hovered
                  ? AppColors.rowHover
                  : Colors.transparent,
              border: Border(
                right: BorderSide(color: AppColors.border),
                top: BorderSide(
                  color: widget.active ? AppColors.accent : Colors.transparent,
                  width: 2,
                ),
              ),
            ),
            child: Row(
              children: [
                Icon(
                  diff == null ? fileTypeIcon(tab.title) : AppIcons.fileDiff,
                  size: 13,
                  color: AppColors.mutedStrong,
                ),
                const SizedBox(width: 6),
                Text(
                  diff == null
                      ? tab.title
                      : '${tab.title} ${_side(diff.change)}',
                  style: grid.AppType.label(
                    color: widget.active
                        ? AppColors.text
                        : AppColors.mutedStrong,
                    fontWeight: FontWeight.w400,
                    fontStyle: tab.preview ? FontStyle.italic : null,
                  ),
                ),
                const SizedBox(width: 4),
                _CloseMark(
                  dirty: tab.dirty,
                  visible: _hovered || widget.active,
                  hovered: _hovered,
                  onPressed: widget.onClose,
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  String _side(GitChange change) => switch (change.area) {
    GitArea.staged => '(Index)',
    GitArea.untracked => '(Untracked)',
    _ => '(Working Tree)',
  };
}

/// ● while the tab has unsaved edits, × to close under the pointer.
class _CloseMark extends StatelessWidget {
  const _CloseMark({
    required this.dirty,
    required this.visible,
    required this.hovered,
    required this.onPressed,
  });

  /// The × shows on the front tab and under the pointer, as in Orca.
  final bool dirty, visible, hovered;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    final showDot = dirty && !hovered;
    return SizedBox.square(
      dimension: 20,
      // One button either way: the dot of unsaved edits closes the tab too.
      child: IconButton(
        key: const ValueKey('finder-tab-close'),
        padding: EdgeInsets.zero,
        iconSize: 12,
        tooltip: dirty ? 'Close (unsaved)' : 'Close',
        onPressed: onPressed,
        icon: showDot
            ? Container(
                key: const ValueKey('finder-tab-dirty'),
                width: 7,
                height: 7,
                decoration: BoxDecoration(
                  color: AppColors.text,
                  shape: BoxShape.circle,
                ),
              )
            : Icon(
                AppIcons.close,
                color: visible ? AppColors.mutedStrong : Colors.transparent,
              ),
      ),
    );
  }
}
