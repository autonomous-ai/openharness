import 'package:harness/shared/theme/app_icons.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_dialog.dart';
import '../state/app_state.dart';
import 'desktop_chrome.dart';

/// ⇧⌘M — send the focused pane to another tab.
///
/// A list, not a grid: tabs are told apart by their NAMES, and a name is read,
/// not recognised by shape — which is the one thing that makes this different
/// from the layout palette it otherwise copies (arrows walk, digits jump,
/// Enter takes, Escape leaves).
///
/// The destinations are every other tab plus a new one. The Store tab is not
/// among them: it holds a storefront, not harnesses, and a terminal dropped
/// there would have nowhere to draw.
Future<void> showMovePanePalette(BuildContext context, AppNotifier notifier) {
  final paneId = notifier.focusedPaneId;
  if (paneId == null) return Future<void>.value();
  final sourceId = notifier.activeSwarmId;
  return showAppDialog<void>(
    context: context,
    builder: (context) => _MovePanePalette(
      notifier: notifier,
      sourceId: sourceId,
      paneId: paneId,
    ),
  );
}

/// One row: an existing tab, or the new one at the end.
class _Destination {
  const _Destination({required this.label, required this.detail, this.id});

  /// Null for "New Tab" — the tab does not exist until it is chosen.
  final String? id;
  final String label;
  final String detail;
}

List<_Destination> _destinationsFor(AppNotifier notifier, String sourceId) => [
  for (final swarm in notifier.swarms)
    if (swarm.id != sourceId && !swarm.isUtility && !swarm.isOrchestrator)
      _Destination(
        id: swarm.id,
        label: swarm.name,
        detail: switch (swarm.panes
            .where((pane) => pane.agentId != null)
            .length) {
          0 => 'No harnesses',
          1 => '1 harness',
          final count => '$count harnesses',
        },
      ),
  const _Destination(label: 'New Tab', detail: 'Create a tab'),
];

class _MovePanePalette extends StatefulWidget {
  const _MovePanePalette({
    required this.notifier,
    required this.sourceId,
    required this.paneId,
  });

  final AppNotifier notifier;
  final String sourceId;
  final int paneId;

  @override
  State<_MovePanePalette> createState() => _MovePanePaletteState();
}

class _MovePanePaletteState extends State<_MovePanePalette> {
  /// An explicit node, requested after the first frame: the route that opened
  /// this has already settled focus somewhere, so `autofocus` alone leaves the
  /// arrow keys unheard. Same reason the layout palette keeps one.
  final FocusNode _keys = FocusNode(debugLabel: 'move-pane-palette');
  int _cursor = 0;
  final _rows = <int, GlobalKey>{};

  void _select(int index) {
    setState(() => _cursor = index);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final row = _rows[_cursor]?.currentContext;
      if (row != null) Scrollable.ensureVisible(row);
    });
  }

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _keys.requestFocus();
    });
  }

  @override
  void dispose() {
    _keys.dispose();
    super.dispose();
  }

  void _take(_Destination destination) {
    final notifier = widget.notifier;
    final paneId = widget.paneId;
    final sourceId = widget.sourceId;
    Navigator.of(context).pop();
    if (!notifier.swarms.any(
      (swarm) =>
          swarm.id == sourceId && swarm.panes.any((pane) => pane.id == paneId),
    )) {
      return;
    }
    var targetId = destination.id;
    if (targetId == null) {
      notifier.newSwarm(newTabPage: true);
      targetId = notifier.activeSwarmId;
      if (targetId == sourceId) return;
    }
    notifier.movePaneToSwarm(paneId, targetId, sourceSwarmId: sourceId);
  }

  KeyEventResult _onKey(FocusNode node, KeyEvent event) {
    if (event is! KeyDownEvent && event is! KeyRepeatEvent) {
      return KeyEventResult.ignored;
    }
    final destinations = _destinationsFor(widget.notifier, widget.sourceId);
    final key = event.logicalKey;
    if (key == LogicalKeyboardKey.escape) {
      Navigator.of(context).pop();
      return KeyEventResult.handled;
    }
    if (key == LogicalKeyboardKey.enter ||
        key == LogicalKeyboardKey.numpadEnter ||
        key == LogicalKeyboardKey.space) {
      _take(destinations[_cursor.clamp(0, destinations.length - 1)]);
      return KeyEventResult.handled;
    }
    if (key == LogicalKeyboardKey.arrowDown) {
      _select((_cursor + 1) % destinations.length);
      return KeyEventResult.handled;
    }
    if (key == LogicalKeyboardKey.arrowUp) {
      _select((_cursor - 1 + destinations.length) % destinations.length);
      return KeyEventResult.handled;
    }
    // ⌘1–⌘9 select a tab, so the same digits pick one here.
    for (var i = 0; i < 9 && i < destinations.length; i++) {
      if (key == _digits[i]) {
        _take(destinations[i]);
        return KeyEventResult.handled;
      }
    }
    return KeyEventResult.ignored;
  }

  static const _digits = [
    LogicalKeyboardKey.digit1,
    LogicalKeyboardKey.digit2,
    LogicalKeyboardKey.digit3,
    LogicalKeyboardKey.digit4,
    LogicalKeyboardKey.digit5,
    LogicalKeyboardKey.digit6,
    LogicalKeyboardKey.digit7,
    LogicalKeyboardKey.digit8,
    LogicalKeyboardKey.digit9,
  ];

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final destinations = _destinationsFor(widget.notifier, widget.sourceId);
    final cursor = _cursor.clamp(0, destinations.length - 1);
    return Focus(
      focusNode: _keys,
      onKeyEvent: _onKey,
      child: Dialog(
        key: const ValueKey('move-pane-palette'),
        insetPadding: const EdgeInsets.all(24),
        backgroundColor: Colors.transparent,
        elevation: 0,
        child: DesktopDialogSurface(
          child: SizedBox(
            width: grid.AppDesktop.formWidth,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              mainAxisSize: MainAxisSize.min,
              children: [
                DesktopDialogHeader(
                  title: 'Move Pane',
                  detail: 'Choose a destination tab.',
                  onClose: () => Navigator.of(context).pop(),
                ),
                Divider(height: 1, color: DesktopChrome.rim),
                Flexible(
                  child: SingleChildScrollView(
                    child: Column(
                      children: [
                        for (var i = 0; i < destinations.length; i++)
                          KeyedSubtree(
                            key: _rows.putIfAbsent(i, GlobalKey.new),
                            child: _Row(
                              destination: destinations[i],
                              index: i,
                              selected: i == cursor,
                              onTap: () => _take(destinations[i]),
                              onHover: () => setState(() => _cursor = i),
                            ),
                          ),
                      ],
                    ),
                  ),
                ),
                Divider(height: 1, color: DesktopChrome.rim),
                Padding(
                  padding: const EdgeInsets.fromLTRB(24, 16, 24, 20),
                  child: Text(
                    '↑↓ Select  ·  Return Move  ·  Esc Cancel',
                    style: DesktopChrome.metadata(),
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

class _Row extends StatelessWidget {
  const _Row({
    required this.destination,
    required this.index,
    required this.selected,
    required this.onTap,
    required this.onHover,
  });

  final _Destination destination;
  final int index;
  final bool selected;
  final VoidCallback onTap;
  final VoidCallback onHover;

  @override
  Widget build(BuildContext context) {
    final ink = selected ? DesktopChrome.onSelection : DesktopChrome.foreground;
    final muted = selected
        ? DesktopChrome.selectionDetail
        : DesktopChrome.muted;
    return Semantics(
      button: true,
      selected: selected,
      label: '${destination.label}, ${destination.detail}',
      onTap: onTap,
      child: ExcludeSemantics(
        child: MouseRegion(
          onEnter: (_) => onHover(),
          cursor: SystemMouseCursors.click,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
            child: InkWell(
              onTap: onTap,
              canRequestFocus: false,
              borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
              child: Container(
                key: ValueKey('move-pane-destination-$index'),
                padding: const EdgeInsets.symmetric(
                  horizontal: 12,
                  vertical: 12,
                ),
                decoration: BoxDecoration(
                  color: selected ? DesktopChrome.activeSelection : null,
                  borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
                ),
                child: Row(
                  children: [
                    Icon(
                      destination.id == null
                          ? AppIcons.plus
                          : AppIcons.panelsTopLeft,
                      color: ink,
                      size: 18,
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            destination.label,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: grid.AppType.label(color: ink),
                          ),
                          const SizedBox(height: 2),
                          Text(
                            destination.detail,
                            style: DesktopChrome.metadata(color: muted),
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(width: 12),
                    Text(
                      index < 9 ? '${index + 1}' : '',
                      style: grid.AppType.monoMeta(color: muted),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
