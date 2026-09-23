import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_dialog.dart';
import '../state/app_state.dart';

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
  if (notifier.focusedPaneId == null) return Future<void>.value();
  return showAppDialog<void>(
    context: context,
    builder: (context) => _MovePanePalette(notifier: notifier),
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

List<_Destination> _destinationsFor(AppNotifier notifier) => [
  for (final swarm in notifier.swarms)
    if (swarm.id != notifier.activeSwarmId && !swarm.isStore)
      _Destination(
        id: swarm.id,
        label: swarm.name,
        detail: switch (swarm.panes
            .where((pane) => pane.agentId != null)
            .length) {
          0 => 'empty',
          1 => '1 harness',
          final count => '$count harnesses',
        },
      ),
  const _Destination(label: 'New Tab', detail: 'a tab of its own'),
];

class _MovePanePalette extends StatefulWidget {
  const _MovePanePalette({required this.notifier});

  final AppNotifier notifier;

  @override
  State<_MovePanePalette> createState() => _MovePanePaletteState();
}

class _MovePanePaletteState extends State<_MovePanePalette> {
  /// An explicit node, requested after the first frame: the route that opened
  /// this has already settled focus somewhere, so `autofocus` alone leaves the
  /// arrow keys unheard. Same reason the layout palette keeps one.
  final FocusNode _keys = FocusNode(debugLabel: 'move-pane-palette');
  int _cursor = 0;

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
    final paneId = notifier.focusedPaneId;
    Navigator.of(context).pop();
    if (paneId == null) return;
    var targetId = destination.id;
    if (targetId == null) {
      // The tab is made from here, then stepped back out of, because the move
      // reads the pane from the tab in front: `newSwarm` selects what it makes.
      final source = notifier.activeSwarmId;
      notifier.newSwarm(newTabPage: true);
      targetId = notifier.activeSwarmId;
      if (targetId == source) return;
      notifier.selectSwarm(source);
    }
    notifier.movePaneToSwarm(paneId, targetId);
  }

  KeyEventResult _onKey(FocusNode node, KeyEvent event) {
    if (event is! KeyDownEvent && event is! KeyRepeatEvent) {
      return KeyEventResult.ignored;
    }
    final destinations = _destinationsFor(widget.notifier);
    final key = event.logicalKey;
    if (key == LogicalKeyboardKey.escape) {
      Navigator.of(context).pop();
      return KeyEventResult.handled;
    }
    if (key == LogicalKeyboardKey.enter ||
        key == LogicalKeyboardKey.numpadEnter) {
      _take(destinations[_cursor.clamp(0, destinations.length - 1)]);
      return KeyEventResult.handled;
    }
    if (key == LogicalKeyboardKey.arrowDown || key == LogicalKeyboardKey.tab) {
      setState(() => _cursor = (_cursor + 1) % destinations.length);
      return KeyEventResult.handled;
    }
    if (key == LogicalKeyboardKey.arrowUp) {
      setState(
        () =>
            _cursor = (_cursor - 1 + destinations.length) % destinations.length,
      );
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
    final destinations = _destinationsFor(widget.notifier);
    final cursor = _cursor.clamp(0, destinations.length - 1);
    return Focus(
      focusNode: _keys,
      onKeyEvent: _onKey,
      child: Dialog(
        key: const ValueKey('move-pane-palette'),
        backgroundColor: grid.AppGlass.surfaceFill,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(13),
          side: BorderSide(color: grid.AppGlass.hair),
        ),
        child: SizedBox(
          width: 360,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            mainAxisSize: MainAxisSize.min,
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(14, 12, 14, 8),
                child: Text(
                  'Move pane to',
                  style: grid.AppType.heading(
                    color: grid.AppPalette.textPrimary,
                  ),
                ),
              ),
              for (var i = 0; i < destinations.length; i++)
                _Row(
                  destination: destinations[i],
                  index: i,
                  selected: i == cursor,
                  onTap: () => _take(destinations[i]),
                  onHover: () => setState(() => _cursor = i),
                ),
              Padding(
                padding: const EdgeInsets.fromLTRB(14, 8, 14, 12),
                child: Text(
                  '↑↓ choose · ⏎ move · esc cancel',
                  style: grid.AppType.monoMeta(
                    color: grid.AppPalette.textFaint,
                  ),
                ),
              ),
            ],
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
    final ink = selected
        ? grid.AppPalette.textPrimary
        : grid.AppPalette.textSecondary;
    return MouseRegion(
      onEnter: (_) => onHover(),
      child: GestureDetector(
        onTap: onTap,
        behavior: HitTestBehavior.opaque,
        child: Container(
          key: ValueKey('move-pane-destination-$index'),
          margin: const EdgeInsets.symmetric(horizontal: 8, vertical: 1),
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 7),
          decoration: BoxDecoration(
            color: selected ? grid.AppSurface.selectedFill : null,
            borderRadius: BorderRadius.circular(5),
          ),
          child: Row(
            children: [
              SizedBox(
                width: 18,
                child: Text(
                  index < 9 ? '${index + 1}' : '',
                  style: grid.AppType.monoMeta(
                    color: grid.AppPalette.textFaint,
                  ),
                ),
              ),
              Expanded(
                child: Text(
                  destination.label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: grid.AppType.label(color: ink),
                ),
              ),
              const SizedBox(width: 8),
              Text(
                destination.detail,
                style: grid.AppType.monoMeta(color: grid.AppPalette.textFaint),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
