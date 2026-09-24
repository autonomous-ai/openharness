import '../sharing/shared_harness_panel.dart';

import 'dart:async';
import 'dart:typed_data';

import 'package:desktop_drop/desktop_drop.dart';
import 'package:flutter/material.dart';
import 'package:xterm/xterm.dart';

import 'window_chrome.dart';

import '../clipboard/image_bytes.dart';
import '../core/dsh_catalog.dart' show DshEntry;
import '../core/models.dart' show Agent, kUntitledPane;
import '../clipboard/native_clipboard.dart';
import '../shared/theme/app_theme.dart' as grid;
// `hide TerminalKey`: this file's own shortcut-label class, unused here, collides with xterm's
// `TerminalKey` (needed for the local image-drop Ctrl+V nudge — see `_dropImage`).
import '../shortcuts/app_shortcuts.dart' hide TerminalKey;
import '../state/app_state.dart';
import '../state/pane_preset.dart';
import '../state/pane_arrangement.dart';
import '../state/terminal_pane.dart';
import '../terminal/terminal_binary.dart';
import '../terminal/terminal_text.dart';
import '../terminal/terminal_session.dart';
import '../theme/app_theme.dart';
import 'agent_drag.dart';
import 'harness_join_guide_screen.dart';
import 'link_machine_screen.dart';
import 'new_agent_dialog.dart';
import 'delete_agent_dialog.dart';
import 'restart_agent_action.dart';
import 'terminal_panel.dart';
import 'web_pane_panel.dart';
import 'pane_resize_handle.dart';
import 'box_chrome.dart';
import 'pane_minimize.dart';

/// Terminal views arranged by the chosen preset. Swarms keep each view under
/// one stable parent as its rectangle, visibility and keyboard focus change.
class PaneGrid extends StatelessWidget {
  const PaneGrid({
    super.key,
    required this.notifier,
    this.swarmMode = false,
    this.empty,
  });

  final AppNotifier notifier;
  final bool swarmMode;
  final Widget? empty;

  @override
  Widget build(BuildContext context) {
    TerminalFontScope.watch(context);
    return ValueListenableBuilder<AgentDragRef?>(
      valueListenable: agentDrag,
      builder: (context, dragging, _) {
        if (swarmMode) {
          return _SwarmCanvas(
            notifier: notifier,
            dragging: dragging,
            empty: empty,
          );
        }
        final panes = notifier.panes;
        final zoomed = notifier.zoomedPaneId;
        final visible = zoomed == null
            ? panes
            : panes.where((p) => p.id == zoomed).toList();
        Widget cell(TerminalPane pane, {bool visible = true}) => _PaneCell(
          key: pane.cellKey,
          notifier: notifier,
          pane: pane,
          dragging: dragging,
          visible: visible,
          swarmMode: swarmMode,
        );
        final cells = <Widget>[
          for (final pane in visible) cell(pane),
          if (!swarmMode && dragging != null && notifier.canAddPane)
            _DropZone(
              notifier: notifier,
              paneId: null,
              dragging: dragging,
              child: const _AddSlot(),
            ),
        ];
        return panes.isEmpty
            ? empty ?? _EmptyGrid(notifier: notifier)
            : _arrange(cells);
      },
    );
  }

  /// Keyed on the number of CELLS, not of panes: mid-drag an extra drop slot
  /// joins them, and the grid on screen is the one the shape has to describe.
  Widget _arrange(List<Widget> cells) {
    final preset = notifier.presetFor(cells.length);

    if (preset != null &&
        (preset.usesTileGeometry ||
            (preset == PanePreset.rows && cells.length > 2))) {
      return _PresetCells(cells: cells, preset: preset);
    }

    // Lattices use a stated or measured column count. Spanning presets keep
    // their own geometry, including the default five-pane middle column.
    if (cells.length == 5 && preset == PanePreset.middleMain) {
      // The one five-tile shape that is not a lattice: a full-height column down
      // the middle, two stacked either side. Read in TILE order — 1 and 4 to the
      // left, 2 in the middle, 3 and 5 to the right — which is how a person
      // numbers them, and it is the same order `PanePreset.tilesFor` describes,
      // so the picker's drawing and this cannot disagree.
      return _Axis(
        axis: Axis.horizontal,
        children: [
          _Axis(axis: Axis.vertical, children: [cells[0], cells[3]]),
          cells[1],
          _Axis(axis: Axis.vertical, children: [cells[2], cells[4]]),
        ],
      );
    }
    if (cells.length > 4) {
      return _Lattice(
        cells: cells,
        columns: preset?.statedColumns,
        onColumns: (c) => notifier.gridColumns = c,
      );
    }

    switch (cells.length) {
      case 1:
        return cells[0];
      case 2:
        return LayoutBuilder(
          builder: (context, constraints) {
            // `splitLong` halves whichever side is longer, so two tiles on a
            // wide window are columns and two on a tall one are rows: a
            // terminal's usable size is its column count first, and halving the
            // short axis is what protects it. The other two say it outright.
            final side = switch (preset) {
              PanePreset.columns => Axis.horizontal,
              PanePreset.rows => Axis.vertical,
              _ =>
                constraints.maxWidth >= constraints.maxHeight
                    ? Axis.horizontal
                    : Axis.vertical,
            };
            return _Axis(axis: side, children: cells);
          },
        );
      case 3:
        // Three across has no spanning tile, so it is the lattice with its
        // column count stated rather than measured — the same widget the
        // five-and-up grid uses, which is what makes its walls, its 40-column
        // floor and its scroll fallback behave identically everywhere.
        if (preset == PanePreset.cols3) {
          return _Lattice(cells: cells, columns: 3);
        }
        // The rest each have ONE spanning tile — the whole reason three is not
        // a grid. Which tile spans, and on which side, is the choice.
        return switch (preset) {
          PanePreset.oneOverTwo => _Axis(
            axis: Axis.vertical,
            children: [
              cells[0],
              _Axis(axis: Axis.horizontal, children: [cells[1], cells[2]]),
            ],
          ),
          PanePreset.mainLeft => _Axis(
            axis: Axis.horizontal,
            children: [
              cells[0],
              _Axis(axis: Axis.vertical, children: [cells[1], cells[2]]),
            ],
          ),
          _ => _Axis(
            axis: Axis.vertical,
            children: [
              _Axis(axis: Axis.horizontal, children: [cells[0], cells[1]]),
              cells[2],
            ],
          ),
        };
      default:
        if (preset == PanePreset.cols4) {
          return _Lattice(cells: cells, columns: 4);
        }
        if (preset == PanePreset.mainAndStack) {
          return _Axis(
            axis: Axis.horizontal,
            children: [
              cells[0],
              _Axis(
                axis: Axis.vertical,
                children: [cells[1], cells[2], cells[3]],
              ),
            ],
          );
        }
        // The square. Both rows are cut at the same place, so the column wall
        // is one line down the whole grid rather than a staircase.
        return _Axis(
          axis: Axis.vertical,
          children: [
            _Axis(axis: Axis.horizontal, children: [cells[0], cells[1]]),
            _Axis(axis: Axis.horizontal, children: [cells[2], cells[3]]),
          ],
        );
    }
  }
}

/// Switching layouts must not reparent terminal subtrees. GlobalKey grafting
/// preserves State but invalidates inherited dependencies throughout each view.
/// This canvas changes rectangles under a single Stack instead, including when
/// a large Swarm needs to scroll. Unvisited views remain unmounted.
class _SwarmCanvas extends StatefulWidget {
  const _SwarmCanvas({
    required this.notifier,
    required this.dragging,
    this.empty,
  });
  final AppNotifier notifier;
  final AgentDragRef? dragging;
  final Widget? empty;
  @override
  State<_SwarmCanvas> createState() => _SwarmCanvasState();
}

class _SwarmCanvasState extends State<_SwarmCanvas> {
  final _scroll = ScrollController(keepScrollOffset: false);
  final _horizontalScroll = ScrollController(keepScrollOffset: false);
  final _offsets = <String, Offset>{};
  final _inputLayers = <int, GlobalKey<_PaneLayerState>>{};
  final _idleFocus = FocusNode(
    debugLabel: 'Swarm navigation',
    skipTraversal: true,
  );
  late Object _lastInputDestination;
  final _resizeFocus = FocusNode(debugLabel: 'Resize focused agent');
  final _resizeHelp = OverlayPortalController();
  late int _resizeRequest;
  late String _activeId;
  late int _focusRequest;
  Size? _viewportSize;
  bool _focusRevealPending = false;

  Object get _inputDestination => (
    widget.notifier.activeSwarmId,
    widget.notifier.focusedPaneId,
    widget.notifier.paneFocusRequest,
    widget.notifier.zoomedPaneId,
  );

  @override
  void initState() {
    super.initState();
    _lastInputDestination = _inputDestination;
    _resizeRequest = widget.notifier.paneResizeRequest;
    _activeId = widget.notifier.activeSwarmId;
    _focusRequest = widget.notifier.paneFocusRequest;
    widget.notifier.addListener(_onAppChanged);
    terminalFontStore.addListener(_onFontChanged);
  }

  @override
  void didUpdateWidget(_SwarmCanvas oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!identical(oldWidget.notifier, widget.notifier)) {
      oldWidget.notifier.removeListener(_onAppChanged);
      widget.notifier.addListener(_onAppChanged);
      _offsets.clear();
      _activeId = widget.notifier.activeSwarmId;
      _focusRequest = widget.notifier.paneFocusRequest;
      _resizeRequest = widget.notifier.paneResizeRequest;
      _lastInputDestination = _inputDestination;
      if (_scroll.hasClients) _scroll.jumpTo(0);
      if (_horizontalScroll.hasClients) _horizontalScroll.jumpTo(0);
    }
  }

  void _onAppChanged() {
    final app = widget.notifier;
    if (_lastInputDestination != _inputDestination) {
      _lastInputDestination = _inputDestination;
      _syncInputFocus();
    }
    if (_resizeRequest != app.paneResizeRequest) {
      _resizeRequest = app.paneResizeRequest;
      _resizeFocus.requestFocus();
      _resizeHelp.show();
    }
    if (_activeId != app.activeSwarmId) {
      if (_resizeHelp.isShowing) _resizeHelp.hide();
      _offsets[_activeId] = Offset(
        _horizontalScroll.hasClients ? _horizontalScroll.offset : 0,
        _scroll.hasClients ? _scroll.offset : 0,
      );
      _activeId = app.activeSwarmId;
      // The notification precedes the frame. Restore before layout/paint so
      // switching never briefly displays the previous Swarm's scroll offset.
      final offset = _offsets[_activeId] ?? Offset.zero;
      if (_scroll.hasClients) _scroll.jumpTo(offset.dy);
      if (_horizontalScroll.hasClients) _horizontalScroll.jumpTo(offset.dx);
      final open = app.swarms.map((s) => s.id).toSet();
      _offsets.removeWhere((id, _) => !open.contains(id));
    }
    if (_focusRequest != app.paneFocusRequest) {
      _focusRequest = app.paneFocusRequest;
      _focusRevealPending = true;
      _revealFocusedPane();
    }
    setState(() {});
  }

  void _syncInputFocus() {
    final app = widget.notifier;
    final visible = {
      for (final pane in app.panes)
        if (app.zoomedPaneId == null || pane.id == app.zoomedPaneId) pane.id,
    };
    // Exclude the outgoing views and enable the destination's existing focus
    // tree now. Painting/layout still happens in the normal scheduled frame.
    for (final entry in _inputLayers.entries) {
      entry.value.currentState?.prepareInput(visible.contains(entry.key));
    }
    if (!_idleFocus.canRequestFocus ||
        ModalRoute.of(context)?.isCurrent == false) {
      return;
    }
    if (app.focusedPane?.session?.focusInput() != true) {
      // Blank pages and not-yet-mounted destinations must release the old
      // terminal's text client immediately, without focusing welcome search.
      _idleFocus.requestFocus();
    }
  }

  void _revealFocusedPane({bool correctingLayout = false}) {
    final viewport = _viewportSize;
    if (viewport == null || !_scroll.hasClients) return;
    final app = widget.notifier;
    final panes = app.panes
        .where((p) => app.zoomedPaneId == null || p.id == app.zoomedPaneId)
        .toList();
    final index = panes.indexWhere((p) => p.id == app.focusedPaneId);
    if (index < 0) return;
    final geometry = _SwarmGeometry(
      count: panes.length,
      viewport: viewport,
      preset: app.presetFor(panes.length),
      minimum: _MinTile.of(),
      sizes: app.activeSwarm.paneSizes,
    );
    final rect = geometry.rectangles[index];
    void reveal(
      ScrollController scroll,
      double start,
      double end,
      double viewportExtent,
      double canvasExtent,
    ) {
      if (!scroll.hasClients) return;
      final current = scroll.offset;
      final offset = start < current || end - start > viewportExtent
          ? start
          : end > current + viewportExtent
          ? end - viewportExtent
          : current;
      final target = offset.clamp(
        0.0,
        (canvasExtent - viewportExtent).clamp(0.0, double.infinity),
      );
      if (target != current) {
        if (correctingLayout) {
          // Correct before the scroll view lays out, without notifying during
          // layout. Both axes retain their controllers and terminal children.
          scroll.position.correctPixels(target);
        } else {
          scroll.jumpTo(target);
        }
      }
    }

    reveal(_scroll, rect.top, rect.bottom, viewport.height, geometry.height);
    reveal(
      _horizontalScroll,
      rect.left,
      rect.right,
      viewport.width,
      geometry.width,
    );
  }

  void _onFontChanged() => setState(() {});

  @override
  void dispose() {
    widget.notifier.removeListener(_onAppChanged);
    terminalFontStore.removeListener(_onFontChanged);
    _resizeFocus.dispose();
    _idleFocus.dispose();
    _scroll.dispose();
    _horizontalScroll.dispose();
    super.dispose();
  }

  /// Cache retained terminal presentation, including read-only output.
  /// Never-attached connection/setup views still read their complete state.
  /// Theme/font dependencies continue updating retained descendants directly.
  Object? _presentation(TerminalPane pane, bool visible) {
    if (!visible) return null;
    final app = widget.notifier;
    final machine = app.stateOf(pane.machineId);
    final agent = machine?.agents
        .where((a) => a.id == pane.agentId)
        .firstOrNull;
    final session = pane.session;
    if (session == null) return Object();
    return (
      notifier: app,
      location: (app.activeSwarmId, app.panes.indexOf(pane)),
      layoutRequest: (
        app.paneLayoutRequest,
        app.panes.length,
        app.zoomedPaneId,
      ),
      machine: machine?.machine,
      local: machine?.isLocalMachine,
      online: machine?.nodeOnline,
      needsLink: machine?.needsLink,
      localTransport: machine?.usesLocalTransport,
      agent: agent,
      project: agent == null ? null : machine?.projectOf(agent),
      session: session,
      terminal: session.terminal,
      name: session.agentName,
      status: session.status,
      error: session.errorMessage ?? session.errorCode,
      link: session.linkMode,
      upload: session.uploadProgress,
      focused: app.isPaneFocused(pane.id),
      focusRequest: app.isPaneFocused(pane.id) ? app.paneFocusRequest : 0,
      focusByUser: app.paneFocusByUser,
      single: app.panes.length == 1,
      pinned: app.isPanePinned(pane),
      zoomed: app.zoomedPaneId == pane.id,
      composer: pane.composerVisible,
      blocked:
          app.questionFor(pane.machineId, pane.agentId ?? session.agentId) !=
          null,
      dragging: widget.dragging,
    );
  }

  @override
  Widget build(BuildContext context) {
    TerminalFontScope.watch(context);
    return LayoutBuilder(
      builder: (context, constraints) {
        final app = widget.notifier;
        final viewportChanged = _viewportSize != constraints.biggest;
        _viewportSize = constraints.biggest;
        if (_focusRevealPending && viewportChanged) {
          _revealFocusedPane(correctingLayout: true);
        }
        _focusRevealPending = false;
        final visible = [
          for (final pane in app.panes)
            if (app.zoomedPaneId == null || pane.id == app.zoomedPaneId) pane,
        ];
        final layout = _SwarmGeometry(
          count: visible.length,
          viewport: constraints.biggest,
          preset: app.presetFor(visible.length),
          minimum: _MinTile.of(),
          sizes: app.activeSwarm.paneSizes,
        );
        if (app.zoomedPaneId == null) {
          app.activeSwarm.arranged = layout.arrangement;
          app.activeSwarm.arrangedKey = layout.key;
          final minimum = _MinTile.of();
          app.activeSwarm.arrangedMinimum = Size(
            (minimum.width + kPaneGap) / (layout.width + kPaneGap),
            (minimum.height + kPaneGap) / (layout.height + kPaneGap),
          );
        }
        if (layout.columns != null) app.gridColumns = layout.columns;
        final rectangles = {
          for (var i = 0; i < visible.length; i++)
            visible[i].id: layout.rectangles[i],
        };
        final retainedIds = app.allPanes.map((pane) => pane.id).toSet();
        _inputLayers.removeWhere((id, _) => !retainedIds.contains(id));
        final scrollBehavior = ScrollConfiguration.of(context);
        // Both scroll views stay mounted when content fits. Stable ancestry
        // retains terminal views as a split grows or shrinks the canvas.
        return Focus(
          focusNode: _idleFocus,
          includeSemantics: false,
          child: Scrollbar(
            key: const ValueKey('swarm-horizontal-scrollbar'),
            controller: _horizontalScroll,
            thumbVisibility: layout.width > constraints.maxWidth,
            scrollbarOrientation: ScrollbarOrientation.bottom,
            notificationPredicate: (notification) =>
                notification.depth == 1 &&
                notification.metrics.axis == Axis.horizontal,
            // Keep the horizontal thumb at the viewport's bottom even when the
            // workspace also scrolls vertically. Terminals retain their bars.
            child: SingleChildScrollView(
              controller: _scroll,
              child: ScrollConfiguration(
                behavior: scrollBehavior.copyWith(scrollbars: false),
                child: SingleChildScrollView(
                  controller: _horizontalScroll,
                  scrollDirection: Axis.horizontal,
                  child: ScrollConfiguration(
                    behavior: scrollBehavior,
                    child: SizedBox(
                      width: layout.width,
                      height: layout.height,
                      child: Stack(
                        children: [
                          if (visible.isEmpty)
                            Positioned.fill(
                              child: widget.empty ?? _EmptyGrid(notifier: app),
                            ),
                          for (final pane in app.allPanes)
                            if (rectangles.containsKey(pane.id) ||
                                pane.lastViewSize != null)
                              Positioned.fromRect(
                                key: ValueKey(pane.id),
                                rect:
                                    rectangles[pane.id] ??
                                    Offset.zero & pane.lastViewSize!,
                                child: _PaneLayer(
                                  key: _inputLayers.putIfAbsent(
                                    pane.id,
                                    () => GlobalKey<_PaneLayerState>(),
                                  ),
                                  session: pane.session,
                                  visible: rectangles.containsKey(pane.id),
                                  presentation: _presentation(
                                    pane,
                                    rectangles.containsKey(pane.id),
                                  ),
                                  child: _PaneCell(
                                    key: pane.cellKey,
                                    notifier: app,
                                    pane: pane,
                                    dragging: widget.dragging,
                                    visible: rectangles.containsKey(pane.id),
                                    swarmMode: true,
                                  ),
                                ),
                              ),
                          if (app.zoomedPaneId == null &&
                              layout.arrangement?.dividers.isNotEmpty == true)
                            Positioned.fill(child: _resizeLayer(layout)),
                        ],
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        );
      },
    );
  }

  Widget _resizeLayer(_SwarmGeometry layout) {
    final app = widget.notifier;
    final swarmId = app.activeSwarmId;
    final arrangement = layout.arrangement!;
    final focused = app.panes.indexWhere(
      (pane) => pane.id == app.focusedPaneId,
    );
    final preferred = arrangement.dividers
        .where((divider) => divider.touches(focused))
        .firstOrNull;
    final extent = Size(layout.width + kPaneGap, layout.height + kPaneGap);
    final floor = _MinTile.of();
    final minimum = Size(
      (floor.width + kPaneGap) / extent.width,
      (floor.height + kPaneGap) / extent.height,
    );
    return OverlayPortal(
      controller: _resizeHelp,
      overlayChildBuilder: (context) => Positioned(
        bottom: 24,
        left: 24,
        right: 24,
        child: IgnorePointer(
          child: Center(
            child: TerminalBox(
              key: const ValueKey('pane-resize-hint'),
              child: Padding(
                padding: const EdgeInsets.symmetric(
                  horizontal: 12,
                  vertical: 8,
                ),
                child: Wrap(
                  spacing: 18,
                  runSpacing: 6,
                  children: [
                    Text(
                      'resize >',
                      style: boxMonoStyle(color: grid.AppPalette.swarmAccent),
                    ),
                    for (final (key, action) in const [
                      ('arrows', 'resize'),
                      ('shift', 'larger steps'),
                      ('tab', 'next divider'),
                      ('esc', 'done'),
                    ])
                      Text.rich(
                        TextSpan(
                          children: [
                            TextSpan(
                              text: '$key  ',
                              style: const TextStyle(color: Colors.white70),
                            ),
                            TextSpan(text: action),
                          ],
                        ),
                        style: kBoxFaintStyle,
                      ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
      child: FocusScope(
        onFocusChange: (focused) {
          if (!focused && _resizeHelp.isShowing) _resizeHelp.hide();
        },
        child: Stack(
          children: [
            for (final divider in arrangement.dividers)
              Positioned.fromRect(
                key: ValueKey('resize:$swarmId:${layout.key}:${divider.id}'),
                rect: divider.axis == PaneResizeAxis.x
                    ? Rect.fromLTWH(
                        divider.position * extent.width - kPaneGap,
                        divider.start * extent.height,
                        kPaneGap,
                        (divider.end - divider.start) * extent.height -
                            kPaneGap,
                      )
                    : Rect.fromLTWH(
                        divider.start * extent.width,
                        divider.position * extent.height - kPaneGap,
                        (divider.end - divider.start) * extent.width - kPaneGap,
                        kPaneGap,
                      ),
                child: PaneResizeHandle(
                  arrangement: arrangement,
                  divider: divider,
                  extent: extent,
                  minimum: minimum,
                  focusNode: identical(divider, preferred)
                      ? _resizeFocus
                      : null,
                  onChanged: (next, persist) => app.resizePanes(
                    swarmId,
                    layout.key!,
                    next,
                    persist: persist,
                  ),
                  onLeave: () {
                    final id = app.focusedPaneId;
                    if (id != null) app.focusPane(id, reveal: true);
                  },
                ),
              ),
          ],
        ),
      ),
    );
  }
}

/// Convert the same unit rectangles used by the layout picker and keyboard
/// navigation to pixels. A boundary at fraction f maps to f * (extent + gap);
/// subtracting one gap from each tile preserves spanning and nested cuts.
class _SwarmGeometry {
  _SwarmGeometry({
    required int count,
    required Size viewport,
    required PanePreset? preset,
    required Size minimum,
    Map<String, PaneArrangement> sizes = const {},
  }) : width = viewport.width,
       height = viewport.height {
    if (count == 0) return;
    if (count == 1) {
      rectangles = [Offset.zero & viewport];
      arrangement = PaneArrangement(const [Rect.fromLTRB(0, 0, 1, 1)]);
      key = '1:single';
      return;
    }
    var shape = preset ?? PanePreset.defaultFor(count)!;
    if (shape == PanePreset.splitLong && viewport.height > viewport.width) {
      shape = PanePreset.rows;
    }
    final manual = sizes['$count:manual'];
    if (manual == null &&
        (shape == PanePreset.auto || shape.statedColumns != null)) {
      columns =
          (shape.statedColumns ?? (viewport.width / minimum.width).floor())
              .clamp(1, count);
      final rows = (count / columns!).ceil();
      height = (rows * minimum.height + kPaneGap * (rows - 1)).clamp(
        viewport.height,
        double.infinity,
      );
    }
    key = manual != null
        ? '$count:manual'
        : '$count:${(preset ?? PanePreset.defaultFor(count))!.id}:${columns ?? 0}:${shape.id}';
    arrangement =
        sizes[key] ?? PaneArrangement(shape.tilesFor(count, columns: columns));
    for (final tile in arrangement!.tiles) {
      if (manual != null) {
        width = ((minimum.width + kPaneGap) / tile.width - kPaneGap).clamp(
          width,
          double.infinity,
        );
      }
      height = ((minimum.height + kPaneGap) / tile.height - kPaneGap).clamp(
        height,
        double.infinity,
      );
    }
    rectangles = [
      for (final tile in arrangement!.tiles)
        Rect.fromLTWH(
          tile.left * (width + kPaneGap),
          tile.top * (height + kPaneGap),
          (tile.width * (width + kPaneGap) - kPaneGap).clamp(
            0,
            double.infinity,
          ),
          (tile.height * (height + kPaneGap) - kPaneGap).clamp(
            0,
            double.infinity,
          ),
        ),
    ];
  }
  String? key;
  PaneArrangement? arrangement;
  double width, height;
  int? columns;
  List<Rect> rectangles = const [];
}

/// Non-retained grids use the same geometry for the new spanning presets.
/// The active Swarm canvas continues to keep all terminal subtrees in place.
class _PresetCells extends StatelessWidget {
  const _PresetCells({required this.cells, required this.preset});

  final List<Widget> cells;
  final PanePreset preset;

  @override
  Widget build(BuildContext context) {
    TerminalFontScope.watch(context);
    return LayoutBuilder(
      builder: (context, constraints) {
        final minimum = _MinTile.of();
        final geometry = _SwarmGeometry(
          count: cells.length,
          viewport: constraints.biggest,
          preset: preset,
          minimum: Size(minimum.width, minimum.height),
        );
        final canvas = SizedBox(
          width: constraints.maxWidth,
          height: geometry.height,
          child: Stack(
            children: [
              for (var i = 0; i < cells.length; i++)
                Positioned.fromRect(
                  rect: geometry.rectangles[i],
                  child: ClipRect(child: cells[i]),
                ),
            ],
          ),
        );
        return geometry.height > constraints.maxHeight
            ? SingleChildScrollView(child: canvas)
            : canvas;
      },
    );
  }
}

/// A hidden view retains its last configuration and geometry. Status changes
/// update a replaced session; showing it applies fresh machine/agent metadata.
class _PaneLayer extends StatefulWidget {
  const _PaneLayer({
    super.key,
    required this.session,
    required this.visible,
    required this.presentation,
    required this.child,
  });

  final TerminalSession? session;
  final bool visible;
  final Object? presentation;
  final Widget child;

  @override
  State<_PaneLayer> createState() => _PaneLayerState();
}

class _PaneLayerState extends State<_PaneLayer> {
  final _focus = FocusNode(canRequestFocus: false, skipTraversal: true);
  late Widget _layer = _buildLayer();

  @override
  void initState() {
    super.initState();
    prepareInput(widget.visible);
  }

  void prepareInput(bool visible) {
    _focus.descendantsAreFocusable = visible;
    _focus.descendantsAreTraversable = visible;
  }

  @override
  void didUpdateWidget(_PaneLayer oldWidget) {
    super.didUpdateWidget(oldWidget);
    prepareInput(widget.visible);
    if (oldWidget.visible != widget.visible ||
        oldWidget.presentation != widget.presentation ||
        !identical(oldWidget.session, widget.session)) {
      _layer = _buildLayer();
    }
  }

  @override
  Widget build(BuildContext context) {
    TerminalFontScope.watch(context);
    return _layer;
  }

  @override
  void dispose() {
    _focus.dispose();
    super.dispose();
  }

  Widget _buildLayer() => Offstage(
    offstage: !widget.visible,
    child: TickerMode(
      enabled: widget.visible,
      child: Focus.withExternalFocusNode(
        focusNode: _focus,
        includeSemantics: false,
        child: widget.child,
      ),
    ),
  );
}

/// Five or more tiles: a grid, sized by what a terminal actually needs.
///
/// The column count is NOT ceil(sqrt(n)). A terminal is unusable below 40
/// columns — both this app and the daemon clamp there, and the daemon does it
/// silently, so a tile narrower than that shows a grid wider than its own box
/// and simply loses the right-hand text. So width decides how many columns
/// there can be, and the rows fall out of that.
///
/// Every line is draggable, and each axis remembers its own fractions.
class _Lattice extends StatelessWidget {
  const _Lattice({required this.cells, this.columns, this.onColumns});

  final List<Widget> cells;

  /// Told what was actually laid out.
  ///
  /// `auto` is the one shape whose column count is not in its own description —
  /// it is measured from the window here — and ⌘↑ / ⌘↓ have to know the real
  /// shape to move by a row. A plain field write, never a notify: this runs
  /// inside build, and telling the tree to rebuild from inside its own build is
  /// how a frame loop starts.
  final ValueChanged<int>? onColumns;

  /// A column count the shape asked for, instead of the one the width implies.
  /// Still bounded by the floor below — a shape cannot conjure room that is
  /// not there, and four columns on a narrow window is four unusable tiles.
  final int? columns;

  @override
  Widget build(BuildContext context) {
    TerminalFontScope.watch(context);
    final minTile = _MinTile.of();
    return LayoutBuilder(
      builder: (context, constraints) {
        final n = cells.length;
        // As many columns as the width can carry at the floor, never more than
        // the tiles to put in them, and never fewer than one.
        final byWidth = (constraints.maxWidth / minTile.width).floor();
        final wanted = this.columns ?? byWidth;
        final columns = wanted.clamp(1, n);
        final rows = (n / columns).ceil();
        onColumns?.call(columns);

        // Does the window have the height for this many rows at the floor?
        //
        // When it does not, the grid SCROLLS rather than squeezing. Squeezing
        // is the tempting answer and it is wrong twice over: the daemon clamps
        // the terminal at twelve rows regardless, so the shrunk tile shows a
        // grid taller than its own box, and the pane's own chrome overflows —
        // measured at six tiles in 736px, which is 115px each against a 46px
        // header. Nine usable tiles behind a scrollbar beat nine unusable ones
        // in view.
        final needed = rows * minTile.height + kPaneGap * (rows - 1);
        final scrolls = needed > constraints.maxHeight;

        final grid = _Axis(
          axis: Axis.vertical,
          children: [
            for (var r = 0; r < rows; r++)
              _Axis(
                axis: Axis.horizontal,
                children: [
                  for (var c = 0; c < columns; c++)
                    // The last row can be short. An empty box rather than a
                    // stretched neighbour: a tile that silently grows to twice
                    // its siblings reads as a layout bug, not as a spare slot.
                    // Clipped, because a tile can be squeezed below the floor:
                    // the grid still has to draw every pane it was given, and
                    // a window too small for this many is the user's call to
                    // make. What it must NOT do is let a pane paint outside
                    // its own box — that is a render overflow, which is a bug
                    // whatever the window size.
                    if (r * columns + c < n)
                      ClipRect(child: cells[r * columns + c])
                    else
                      const SizedBox.shrink(),
                ],
              ),
          ],
        );

        if (!scrolls) return grid;
        return SingleChildScrollView(
          child: SizedBox(height: needed, child: grid),
        );
      },
    );
  }
}

/// N children along one axis, sharing the space evenly, with a gap between each
/// pair.
///
/// The proportions come from the SHAPE — which nesting it puts the tiles in —
/// and nothing moves them. Dragging a
/// boundary used to be how you got a layout the app did not offer; now the
/// shapes themselves are the list, and a boundary that cannot be dragged does
/// not need a grab strip, a cursor, a floor to clamp against, or a remembered
/// position — all of which have gone with it.
class _Axis extends StatelessWidget {
  const _Axis({required this.axis, required this.children});

  final Axis axis;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    TerminalFontScope.watch(context);
    if (children.length < 2) {
      return children.isEmpty ? const SizedBox.shrink() : children.first;
    }
    final laid = <Widget>[];
    for (var i = 0; i < children.length; i++) {
      // Equal shares, and no arithmetic here to disagree with the box being
      // divided — every shape in this grid turns out to be an even cut at some
      // level of nesting, including the main-and-stack one: half the width, and
      // three equal rows in that half.
      laid.add(Expanded(child: children[i]));
      if (i < children.length - 1) laid.add(_Gap(axis: axis));
    }
    return Flex(
      direction: axis,
      // Stretch, so a gap spans the cross axis without being told a height it
      // cannot know.
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: laid,
    );
  }
}

/// The smallest a tile may be dragged to, in pixels.
///
/// MEASURED, not guessed, and it is the whole reason a divider clamps at all:
/// both ends already floor a terminal at 40 columns and 12 rows, and the daemon
/// applies that floor SILENTLY (`boundedSize` in tmuxStream.ts). Drag a tile
/// narrower than 40 columns and nothing reports it — the pane simply shows a
/// grid wider than the space it has, clipped, with nothing on screen saying
/// why. So the divider stops where the terminal does.
///
/// The font is one process-wide setting, so one measurement serves every tile.
class _MinTile {
  static TerminalStyle? _forStyle;
  static Size _cached = Size.zero;

  static Size of() {
    final style = terminalFontStore.value;
    if (identical(style, _forStyle)) return _cached;
    // The renderer measures its cell by laying out ten 'm' and dividing; do the
    // same here rather than inventing a second idea of how wide a column is.
    final painter = TextPainter(
      text: TextSpan(
        text: 'mmmmmmmmmm',
        style: terminalTextStyle(height: style.height),
      ),
      textDirection: TextDirection.ltr,
    )..layout();
    final cellW = painter.width / 10;
    final cellH = painter.height;
    painter.dispose();
    _forStyle = style;
    // 46 is the pane header, which is chrome the terminal never gets.
    _cached = Size(40 * cellW + 16, 46 + 12 * cellH + 8);
    return _cached;
  }
}

/// Pane gaps share the outer workspace inset in both directions.
const double kPaneGap = kWorkspaceInset;

/// What shows through the gaps.
///
/// Space only separates when the two sides differ, and every tile is the
/// window's own colour — so on the window's own background the gaps would be
/// invisible and the grid would read as one enormous terminal with seams in it.
/// The first attempt used [AppPalette.cardBg], one step off the window — six
/// values apart in dark (#181818 against #1E1E1E). That is enough to see across
/// a whole panel and not nearly enough at the scale that matters here: a corner
/// curve is a few antialiased pixels wide, and against a background almost the
/// same colour it does not read as a curve at all, it reads as a dirty notch.
/// So the field is a deliberate step, not a nudge.
class GridField extends StatelessWidget {
  const GridField({super.key, required this.child});

  /// `linear-gradient(160deg, …)`. A CSS angle runs clockwise from north, so 160° points down and to
  /// the right — which is (sin160, cos160) as an alignment pair, give or take the sign convention.
  static const _plum = LinearGradient(
    begin: Alignment(-0.342, -0.940),
    end: Alignment(0.342, 0.940),
    colors: [Color(0xFF3A1F2E), Color(0xFF4A2438), Color(0xFF1E1224)],
    stops: [0, 0.5, 1],
  );

  /// `radial-gradient(55% 60% at 80% 18%, rgba(255,200,140,.6) 0, transparent 62%)`. A CSS percentage
  /// position maps to an Alignment as `2p - 1`: 80% → 0.6, 18% → -0.64.
  static const _amber = RadialGradient(
    center: Alignment(0.6, -0.64),
    radius: 0.55,
    colors: [Color(0x99FFC88C), Color(0x00FFC88C)],
    stops: [0, 0.62],
  );

  /// `radial-gradient(50% 55% at 12% 88%, rgba(230,90,110,.5) 0, transparent 62%)`.
  static const _rose = RadialGradient(
    center: Alignment(-0.76, 0.76),
    radius: 0.5,
    colors: [Color(0x80E65A6E), Color(0x00E65A6E)],
    stops: [0, 0.62],
  );

  final Widget child;

  @override
  Widget build(BuildContext context) {
    TerminalFontScope.watch(context);
    return DecoratedBox(
      decoration: const BoxDecoration(gradient: _plum),
      child: DecoratedBox(
        decoration: const BoxDecoration(gradient: _rose),
        child: DecoratedBox(
          decoration: const BoxDecoration(gradient: _amber),
          child: child,
        ),
      ),
    );
  }
}

/// The space between two tiles.
///
/// It was a one-pixel line, and before that nine pixels of draggable grab strip
/// around one. A drawn boundary is the wrong tool here: every tile is already a
/// self-contained thing with its own header, its own engine and its own machine,
/// and a shared line asks the eye to work out which side each edge belongs to.
/// Set the tiles apart instead and the grouping needs no drawing at all — the
/// page shows through, and each pane reads as a card the way it reads on the
/// dial and in the rail.
///
/// Empty on purpose: what fills it is whatever is behind the grid, so a theme
/// change moves the background and this follows with no colour of its own.
class _Gap extends StatelessWidget {
  const _Gap({required this.axis});

  /// The axis the tiles are laid along — so the space between two columns is
  /// vertical, and this is [Axis.horizontal].
  final Axis axis;

  @override
  Widget build(BuildContext context) {
    TerminalFontScope.watch(context);
    return SizedBox(
      width: axis == Axis.horizontal ? kPaneGap : null,
      height: axis == Axis.horizontal ? null : kPaneGap,
    );
  }
}

/// How round a card's corners are — a pane, and the rail beside it. Public for the same reason
/// [kPaneGap] is: the rail is a card now, and two places typing 10 is how they drift apart.
const double kPaneRadius = kTerminalCornerRadius;

/// How round a pane's corners are — the shared card radius, so a terminal does not read as a different
/// KIND of surface from the rail beside it.
const double _paneRadius = kPaneRadius;

class _PaneCell extends StatelessWidget {
  const _PaneCell({
    super.key,
    required this.notifier,
    required this.pane,
    required this.dragging,
    this.visible = true,
    this.swarmMode = false,
  });

  final AppNotifier notifier;
  final TerminalPane pane;
  final AgentDragRef? dragging;
  final bool visible;
  final bool swarmMode;

  bool get _single => notifier.panes.length == 1;

  @override
  Widget build(BuildContext context) {
    TerminalFontScope.watch(context);
    return PaneMinimizeSurface(
      paneId: pane.id,
      child: LayoutBuilder(
        builder: (context, constraints) {
          if (visible) pane.lastViewSize = constraints.biggest;
          return _build(context);
        },
      ),
    );
  }

  Widget _build(BuildContext context) {
    grid.AppTheme.watch(context);
    final focused = visible && notifier.isPaneFocused(pane.id);
    final agentId = pane.agentId;
    final blocked =
        agentId != null &&
        notifier.questionFor(pane.machineId, agentId) != null;
    return Listener(
      // Translucent so the press still reaches the renderer underneath: on
      // macOS the terminal is a WebView and AppKit gives it first responder on
      // its own, so this only has to keep the app's idea of the current tile in
      // step with the one the keyboard already went to.
      behavior: HitTestBehavior.translucent,
      onPointerDown: (_) => notifier.focusPane(pane.id),
      child: Container(
        decoration: BoxDecoration(
          // UNCHANGED, and deliberately: the terminal renders its own background
          // inside this box, so a tile that stops matching the window colour
          // shows a seam between the header strip and the terminal under it.
          // What changes to make the gaps visible is the field BEHIND the grid
          // (see _GridField), which is the part the gaps actually show.
          color: grid.AppPalette.windowBg,
          borderRadius: BorderRadius.circular(_paneRadius),
          // The rim is always drawn — it is what gives an unfocused card its
          // edge, now that no shared line does. It only CHANGES COLOUR on
          // focus, so nothing resizes as focus moves.
          border: Border.fromBorderSide(
            // A lone pane needs no focus distinction. Dialogs use this same
            // rim in its focused state while they own the keyboard.
            terminalPaneBorder(focused: !_single && focused),
          ),
        ),
        // Attention, drawn OVER the terminal and inside the border above, so a
        // pane can carry both at once — this one is blocked AND focused is a
        // normal state, not a conflict to resolve. It is amber and 2px against
        // the border's 1px accent precisely so the two never read as each
        // other. Unlike focus, it shows on a single pane too: with one tile
        // there is nowhere else focus could be, but there is very much a
        // question waiting.
        foregroundDecoration: blocked
            ? BoxDecoration(
                border: Border.all(color: grid.AppPalette.warn, width: 2),
                borderRadius: BorderRadius.circular(_paneRadius),
              )
            : null,
        // Keeps a terminal's constant repainting inside its own layer instead
        // of dirtying the whole grid. No key: nothing reads this boundary, it
        // only has to exist.
        child: ClipRRect(
          // Clipped HERE rather than through Container's own clipBehavior.
          //
          // Both clip, but they clip to different shapes: Container's is the
          // decoration's OUTER edge, so the child fills the full radius and
          // paints under the rim, leaving a square-shouldered corner peeking
          // through the 1px the rim occupies. This one takes the rim's pixel
          // off the radius, so the fill stops exactly where the rim starts.
          //
          // TerminalPanel opens with a ColoredBox across its whole box, and
          // that is what was reaching the corners.
          borderRadius: BorderRadius.circular(_paneRadius - 1),
          child: RepaintBoundary(
            child: _FileDropZone(
              notifier: notifier,
              pane: pane,
              child: _SwapZone(
                notifier: notifier,
                paneId: pane.id,
                child: _DropZone(
                  notifier: notifier,
                  paneId: pane.id,
                  dragging: dragging,
                  child: ValueListenableBuilder<PaneDragRef?>(
                    valueListenable: paneDragging,
                    // The tile being carried fades where it sits, so the grid shows
                    // where it came FROM while the ghost shows where it is going.
                    builder: (context, inFlight, child) => Opacity(
                      opacity: inFlight?.paneId == pane.id ? 0.35 : 1,
                      child: child,
                    ),
                    child: _PaneContent(
                      notifier: notifier,
                      pane: pane,
                      single: _single,
                      visible: visible,
                      swarmMode: swarmMode,
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _PaneContent extends StatelessWidget {
  const _PaneContent({
    required this.notifier,
    required this.pane,
    required this.single,
    required this.visible,
    required this.swarmMode,
  });

  final AppNotifier notifier;
  final TerminalPane pane;
  final bool single;
  final bool visible;
  final bool swarmMode;

  @override
  Widget build(BuildContext context) {
    TerminalFontScope.watch(context);
    final machine = notifier.stateOf(pane.machineId);
    void close() {
      final minimize = PaneMinimizeScope.maybeOf(context);
      if (minimize != null) {
        minimize.close(pane);
      } else {
        notifier.closePane(pane.id);
      }
    }

    if (pane.sharedHarness case final grant?) {
      return SharedHarnessPanel(
        key: ValueKey('shared-pane-${pane.id}'),
        notifier: notifier,
        pane: pane,
        grant: grant,
        visible: visible,
        onClose: close,
        hasAccess:
            machine?.machine.sharedHarnesses.any((s) => s.id == grant.id) ==
            true,
      );
    }

    // A harness's viewer: the one tile that is not a terminal and not about a
    // machine. Decided first, before anything below reads `agentId` — which a
    // viewer keeps null on purpose (see TerminalPane.ownerAgentId).
    if (pane.isWeb) {
      final owner = machine?.agents
          .where((agent) => agent.id == pane.ownerAgentId)
          .firstOrNull;
      return WebPanePanel(
        key: ValueKey('web-pane-${pane.id}'),
        notifier: notifier,
        pane: pane,
        title: viewerPaneName(owner, machine?.dsh.entries ?? const []),
        ownerName: owner?.name ?? pane.ownerAgentId ?? 'Viewer',
        ownerEngine: owner?.identityEngine,
        ownerDisplayName: owner?.identityDisplayName,
        verdict: owner?.verdict,
        working:
            owner != null &&
            notifier.agentIsProcessing(pane.machineId, owner.id),
        onClose: close,
        compactHeader: swarmMode,
        zoomed: notifier.zoomedPaneId == pane.id,
        onToggleZoom: swarmMode && (!single || notifier.zoomedPaneId == pane.id)
            ? () {
                notifier.focusPane(pane.id);
                notifier.toggleZoomPane();
              }
            : null,
      );
    }
    final session = pane.session;
    final wantedAgentId = pane.agentId;
    final agent = machine?.agents
        .where((agent) => agent.id == wantedAgentId)
        .firstOrNull;
    final agentName = agent?.displayName;
    final needsLink =
        machine != null &&
        machine.isRemote &&
        !machine.isLocalMachine &&
        machine.needsLink;
    final offline =
        machine != null &&
        (machine.nodeOnline == false ||
            (machine.isLocalMachine && !machine.usesLocalTransport));

    // Availability changes the header and input permission, never the renderer's
    // ancestry. Retained output, selection, scroll and Find stay in this view.
    if (session != null) {
      // A software renderer (notably WSLg's llvmpipe) cannot keep up when
      // every visible terminal schedules a full text layout for every output
      // chunk. Keep the active tile realtime and coalesce background output
      // only once the grid has three terminal panes. The buffer remains live,
      // so the next paint contains every intervening chunk.
      final terminalPaneCount = notifier.panes
          .where((candidate) => candidate.session != null)
          .length;
      final throttleBackgroundOutput =
          swarmMode &&
          visible &&
          !notifier.isPaneFocused(pane.id) &&
          notifier.zoomedPaneId == null &&
          terminalPaneCount >= 3;
      final TerminalNotice? notice;
      if (machine == null) {
        notice = terminalNotice(
          label: 'Unavailable',
          icon: Icons.cloud_off,
          detail: notifier.machineInventoryLoaded
              ? 'This machine isn’t available. Retained output is read only.'
              : 'Waiting for this machine. Retained output is read only.',
        );
      } else if (needsLink) {
        notice = terminalNotice(
          label: 'Link required',
          icon: Icons.link_off,
          detail:
              '${machine.machine.displayName} needs linking. Retained output is read only.',
          // A tile still showing its last screen gets the same way out as an
          // empty one — the band's button asks for the remote password.
          actionLabel: 'Link…',
          onAction: () => showLinkMachineScreenDialog(
            context,
            notifier,
            pane.machineId,
          ).ignore(),
        );
      } else if (offline) {
        notice = terminalNotice(
          label: 'Offline',
          icon: Icons.cloud_off,
          detail:
              '${machine.machine.displayName} is offline. Retained output is read only.',
        );
      } else if (agent == null || !agent.terminalAvailable) {
        notice = terminalNotice(
          label: 'Unavailable',
          icon: Icons.terminal,
          detail:
              agent?.terminalUnavailableReason ??
              'This agent is unavailable on ${machine.machine.displayName}. Retained output is read only.',
        );
      } else if (agent.launchState == 'failed') {
        // A resume the daemon could not CONFIRM is not a start that failed: the
        // engine is usually still running in this pane, which is why output
        // keeps arriving while the keyboard is locked. Asking again is cheap —
        // the daemon re-checks a resume it never confirmed rather than
        // relaunching (`resumeStoppedAgent.ts`) — so that is the button, and
        // Restart is kept for the failures where something really must be
        // started again.
        final unconfirmed = agent.launchError == 'RESUME_UNCONFIRMED';
        notice = terminalNotice(
          label: unconfirmed ? 'Not confirmed' : 'Start failed',
          icon: unconfirmed ? Icons.help_outline : Icons.error_outline,
          detail: unconfirmed
              ? 'The engine is still running here; the daemon has not confirmed '
                    'which conversation it reopened.'
              : agent.launchDetail ??
                    'The engine failed to start. Terminal output is preserved.',
          // The one notice that needs saying out loud rather than hovering:
          // the pane keeps printing while its keyboard is locked, and nothing
          // about a chip explains that.
          banner: true,
          actionLabel: unconfirmed ? 'Check again' : 'Restart',
          onAction: unconfirmed
              ? () => unawaited(notifier.selectAgent(pane.machineId, agent.id))
              : () =>
                    restartHarness(context, notifier, pane.machineId, agent.id),
        );
      } else {
        notice = null;
      }
      return LayoutBuilder(
        builder: (context, constraints) => TerminalPanel(
          notifier: notifier,
          session: session,
          viewportSize: constraints.biggest,
          paneLocation: (notifier.activeSwarmId, notifier.panes.indexOf(pane)),
          layoutRequest: (
            notifier.paneLayoutRequest,
            notifier.panes.length,
            notifier.zoomedPaneId,
          ),
          focused: visible && notifier.isPaneFocused(pane.id),
          outputRepaintInterval: throttleBackgroundOutput
              ? const Duration(milliseconds: 80)
              : null,
          focusRequest: notifier.isPaneFocused(pane.id)
              ? notifier.paneFocusRequest
              : 0,
          focusByUser: notifier.paneFocusByUser,
          visible: visible,
          compactHeader: swarmMode,
          composerVisible: pane.composerVisible,
          readOnly: notice != null,
          notice: notice,
          onToggleComposer: () => notifier.toggleComposer(pane.id),
          onClose: single && !swarmMode ? null : close,
          // The same confirmation the rail's row menu opens. Only for an
          // agent the machine still lists — a pane whose agent is already
          // gone has nothing to end.
          onDelete: agent == null
              ? null
              : () => confirmDeleteAgent(
                  context,
                  notifier,
                  pane.machineId,
                  agent.id,
                  agent.displayName,
                  engine: agent.engine,
                ),
          zoomed: notifier.zoomedPaneId == pane.id,
          onToggleZoom:
              swarmMode && (!single || notifier.zoomedPaneId == pane.id)
              ? () {
                  notifier.focusPane(pane.id);
                  notifier.toggleZoomPane();
                }
              : null,
          onRendererFocus: () => notifier.focusPaneFromRenderer(pane.id),
          paneDrag: single
              ? null
              : PaneDragHandle(
                  ref: PaneDragRef(paneId: pane.id),
                  size: constraints.biggest,
                ),
        ),
      );
    }

    // A never-attached view has no output to preserve: keep its setup guidance.
    if (machine == null) {
      // Waiting ends once the inventory has answered, even when it has no row
      // for this saved pane. Keep Retry mounted during refresh so keyboard focus
      // survives. Repeated activation joins the same retry in AppNotifier.
      final listFailed = notifier.machineListError != null;
      final retrying = notifier.machinesRefreshing;
      final waiting = !listFailed && !notifier.machineInventoryLoaded;
      final stale = notifier.machinesAreStale;
      return _PaneStatus(
        title: wantedAgentId == null ? 'Machine' : kUntitledPane,
        icon: listFailed || stale ? Icons.cloud_off : Icons.link_off,
        message: listFailed
            ? 'Could not load machines. Retry to reconnect.'
            : waiting
            ? 'Waiting for this machine to answer…'
            : stale
            ? 'Could not confirm this machine’s status. Retry to reconnect.'
            : 'This machine isn’t available. Check that it’s still linked to your account.',
        onClose: single && !swarmMode ? null : close,
        busy: waiting || retrying,
        actionLabel: waiting ? null : 'Retry',
        onAction: waiting ? null : notifier.retryMachines,
      );
    }
    if (needsLink) {
      return _PaneStatus(
        title: agentName ?? machine.machine.displayName,
        icon: Icons.link_off,
        message:
            '${machine.machine.displayName} is not linked to this computer yet. '
            'Link it with the remote password set on that machine.',
        onClose: single && !swarmMode ? null : close,
        // The way out, where the dead end was: the same card the Machines
        // panel's Connect row opens, asking for that machine's remote
        // password. It closes itself the moment the link lands, and this tile
        // goes back to attaching.
        actionLabel: 'Link…',
        onAction: () => showLinkMachineScreenDialog(
          context,
          notifier,
          pane.machineId,
        ).ignore(),
      );
    }
    if (offline) {
      return _Guide(
        single: single && !swarmMode,
        onClose: close,
        title: agentName ?? machine.machine.displayName,
        compactMessage: machine.isLocalMachine
            ? 'Harness is not running on this computer.'
            : 'Harness is not running on ${machine.machine.displayName}.',
        compactIcon: Icons.cloud_off,
        full: HarnessJoinGuideScreen(
          notifier: notifier,
          machineState: machine,
          agentName: agentName ?? 'selected agent',
        ),
      );
    }
    if (wantedAgentId == null) {
      return _PaneStatus(
        title: machine.machine.displayName,
        icon: Icons.check_circle_outline,
        message: 'This machine is ready. Drag an agent here to open it.',
        onClose: close,
      );
    }
    if (agentName == null) {
      return _PaneStatus(
        title: wantedAgentId,
        icon: Icons.help_outline,
        message: 'This agent is no longer on ${machine.machine.displayName}.',
        onClose: close,
      );
    }
    if (agent != null && !agent.terminalAvailable) {
      return _PaneStatus(
        title: agentName,
        icon: Icons.terminal,
        message:
            agent.terminalUnavailableReason ??
            'This agent has no available terminal.',
        onClose: close,
      );
    }
    // Nothing is attaching, and nothing will: this machine's CLI cannot open a
    // terminal without taking it from whoever has it, so an open here waits for
    // a person rather than happening behind one (`AttachIntent`). A spinner
    // would promise something that is never coming.
    if (!machine.terminalNoTakeoverAvailable) {
      return _PaneStatus(
        title: agentName,
        icon: Icons.terminal,
        message:
            'Open this harness here. Another screen may be using its terminal; '
            'opening takes it, because ${machine.machine.displayName} runs an '
            'older Harness CLI.',
        onClose: single && !swarmMode ? null : close,
        actionLabel: 'Open here',
        onAction: () {
          notifier.selectAgent(pane.machineId, wantedAgentId).ignore();
        },
      );
    }
    return _PaneStatus(
      title: agentName,
      icon: Icons.hourglass_empty,
      message: 'Attaching…',
      onClose: single && !swarmMode ? null : close,
      busy: true,
    );
  }
}

/// Where an OS file (from Finder/Nautilus, not an in-app drag) may be dropped onto this pane.
///
/// Outermost of the three drop layers on a tile ([_SwapZone]/[_DropZone] handle in-app Flutter
/// drags; this one is a native OS drag session, a different event channel entirely — `desktop_drop`
/// does not consume ordinary pointer/click/scroll events, so nesting order among the three doesn't
/// matter functionally). Unlike the other two, there is no app-wide "what's being dragged" notifier
/// to key hover state off — `desktop_drop` only tells THIS widget about drags over it — so this one
/// is a StatefulWidget with its own local hover flag instead of a shared `ValueListenableBuilder`.
///
/// An image is sent through the exact same pipeline as a clipboard image paste
/// ([TerminalSession.pasteImage]); a non-image file's path is pasted as text — directly, with no
/// network round-trip, when this pane's machine is local, or via [TerminalSession.pasteFile] (which
/// writes it to disk on that machine first) when the pane's machine is remote. See the plan this
/// shipped from for why that asymmetry is intentional.
class _FileDropZone extends StatefulWidget {
  const _FileDropZone({
    required this.notifier,
    required this.pane,
    required this.child,
  });

  final AppNotifier notifier;
  final TerminalPane pane;
  final Widget child;

  @override
  State<_FileDropZone> createState() => _FileDropZoneState();
}

class _FileDropZoneState extends State<_FileDropZone> {
  bool _hovering = false;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return DropTarget(
      onDragEntered: (_) => setState(() => _hovering = true),
      onDragExited: (_) => setState(() => _hovering = false),
      onDragDone: (details) async {
        setState(() => _hovering = false);
        await _handleDrop(details.files);
      },
      child: Stack(
        fit: StackFit.expand,
        children: [
          widget.child,
          if (_hovering)
            Positioned.fill(
              child: IgnorePointer(
                child: Container(
                  color: AppColors.accent.withValues(alpha: 0.16),
                  child: Center(
                    child: Container(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 12,
                        vertical: 8,
                      ),
                      decoration: BoxDecoration(
                        color: grid.AppPalette.panelBg,
                        border: Border.all(color: AppColors.accent),
                        borderRadius: BorderRadius.circular(6),
                      ),
                      child: Text(
                        'Drop to attach',
                        style: grid.AppType.label(color: AppColors.text),
                      ),
                    ),
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }

  void _toast(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
        .showSnackBar(SnackBar(content: Text(message)));
  }

  static String _mb(int bytes) =>
      '${(bytes / (1024 * 1024)).toStringAsFixed(0)} MB';

  /// Reads just enough of the file to sniff its format (see [looksLikeImage]) without loading a
  /// large drop fully into memory before deciding which ceiling even applies to it.
  Future<Uint8List> _peekHead(DropItem item, int maxBytes) async {
    final chunks = <int>[];
    await for (final chunk in item.openRead(0, maxBytes)) {
      chunks.addAll(chunk);
      if (chunks.length >= maxBytes) break;
    }
    return Uint8List.fromList(chunks);
  }

  Future<void> _handleDrop(List<DropItem> files) async {
    if (files.isEmpty) return;
    widget.notifier.focusPane(widget.pane.id);
    final session = widget.pane.session;
    if (session == null) return; // pane not attached to a live session yet
    final machine = widget.notifier.stateOf(widget.pane.machineId);

    final images = <DropItem>[];
    final others = <DropItem>[];
    for (final item in files) {
      if (item is DropItemDirectory) {
        others.add(item);
        continue;
      }
      Uint8List head;
      try {
        head = await _peekHead(item, 16);
      } catch (_) {
        continue;
      }
      if (looksLikeImage(head)) {
        images.add(item);
      } else {
        others.add(item);
      }
    }

    // Only the first image: several back-to-back would race the same OS clipboard + single Ctrl+V
    // nudge on the daemon side — see pasteImage's own doc.
    if (images.isNotEmpty) {
      await _dropImage(images.first, machine, session);
      if (images.length > 1) {
        final ignored = images.length - 1;
        _toast(
          '$ignored more image${ignored > 1 ? 's' : ''} ignored — drop one image at a time',
        );
      }
    }

    // Every non-image file, independently — no shared resource to race over.
    for (final item in others) {
      await _dropFile(item, machine, session);
    }
  }

  Future<void> _dropImage(
    DropItem item,
    MachineState? machine,
    TerminalSession session,
  ) async {
    // Not "cannot receive a native image paste" — that's a real capability gap, this is just a
    // race between the drop landing and machine state loading. Conflating the two would send the
    // user to fix a machine that is perfectly fine.
    if (machine == null) {
      _toast('Machine info not ready yet — try again in a moment');
      return;
    }
    Uint8List raw;
    try {
      raw = await item.readAsBytes();
    } catch (_) {
      _toast('Could not read ${item.name}');
      return;
    }
    final png = await ensurePngBytes(raw);
    if (png == null) {
      _toast('${item.name} is not a readable image');
      return;
    }

    // Local pane: the app itself IS the target OS, so it writes ITS OWN clipboard directly
    // instead of sending the bytes over the wire, then nudges the engine exactly like an
    // ordinary local clipboard paste already does (see terminal_panel.dart's `_paste()`) — never
    // the chunked-upload path, which is for a genuinely remote machine's DIFFERENT clipboard.
    if (machine.isLocalMachine) {
      final wrote = await NativeClipboard.writeImagePng(png);
      if (!wrote) {
        _toast('Could not set the clipboard on this machine');
        return;
      }
      session.terminal.keyInput(TerminalKey.keyV, ctrl: true);
      return;
    }

    if (!machine.terminalImagePasteAvailable) {
      _toast('This machine cannot receive a native image paste yet');
      return;
    }
    if (png.length > terminalLocalImagePasteMaxPayloadBytes) {
      _toast(
        '${item.name} is larger than ${_mb(terminalLocalImagePasteMaxPayloadBytes)}',
      );
      return;
    }
    await session.pasteImage(png);
  }

  Future<void> _dropFile(
    DropItem item,
    MachineState? machine,
    TerminalSession session,
  ) async {
    // Same reasoning as _dropImage: null here is a transient race, not "this machine can't do
    // this" — say so distinctly rather than falling through to the remote/upload branch below,
    // which would silently take the wire for what might actually be a local pane.
    if (machine == null) {
      _toast('Machine info not ready yet — try again in a moment');
      return;
    }
    // Local pane: the file already has a valid path on this same machine — nothing to transfer.
    if (machine.isLocalMachine) {
      await session.pasteText(item.path);
      return;
    }
    // A folder has no single-file byte content to transfer to a remote machine — out of scope.
    if (item is DropItemDirectory) {
      _toast("Folders can't be sent to a remote machine yet");
      return;
    }
    if (!machine.terminalPasteFileAvailable) {
      _toast('This machine cannot receive a dropped file yet');
      return;
    }
    Uint8List bytes;
    try {
      bytes = await item.readAsBytes();
    } catch (_) {
      _toast('Could not read ${item.name}');
      return;
    }
    if (bytes.length > terminalLocalPasteFileMaxPayloadBytes) {
      _toast(
        '${item.name} is larger than ${_mb(terminalLocalPasteFileMaxPayloadBytes)}',
      );
      return;
    }
    await session.pasteFile(item.name, bytes);
  }
}

/// Where a dragged pane may be dropped to trade places with this one.
///
/// A sibling of [_DropZone] rather than a branch inside it: they are live at
/// different times and mean different things at the same pixel — a rail row
/// landing here REPLACES what this tile shows, a pane landing here SWAPS the
/// two. `DragTarget<T>` keeps them apart by generic, so neither has to ask what
/// kind of drag is in flight.
class _SwapZone extends StatelessWidget {
  const _SwapZone({
    required this.notifier,
    required this.paneId,
    required this.child,
  });

  final AppNotifier notifier;
  final int paneId;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return ValueListenableBuilder<PaneDragRef?>(
      valueListenable: paneDragging,
      builder: (context, dragging, _) {
        return Stack(
          fit: StackFit.expand,
          children: [
            child,
            Positioned.fill(
              child: IgnorePointer(
                // Off entirely unless a pane is in flight, so the terminal
                // underneath keeps every click the rest of the time.
                ignoring: dragging == null || dragging.paneId == paneId,
                child: DragTarget<PaneDragRef>(
                  onAcceptWithDetails: (details) =>
                      notifier.reorderPane(details.data.paneId, paneId),
                  builder: (context, candidate, _) => candidate.isEmpty
                      ? const SizedBox.expand()
                      : Container(
                          color: AppColors.accent.withValues(alpha: 0.16),
                          child: Center(
                            child: Container(
                              padding: const EdgeInsets.symmetric(
                                horizontal: 12,
                                vertical: 8,
                              ),
                              decoration: BoxDecoration(
                                color: grid.AppPalette.panelBg,
                                border: Border.all(color: AppColors.accent),
                                borderRadius: BorderRadius.circular(6),
                              ),
                              child: Text(
                                'Swap with this pane',
                                style: grid.AppType.label(
                                  color: AppColors.text,
                                ),
                              ),
                            ),
                          ),
                        ),
                ),
              ),
            ),
          ],
        );
      },
    );
  }
}

/// A full-screen guide, but only where one fits.

///
/// The link and join screens are fixed-width cards written for the whole
/// window. In a quarter tile they would overflow rather than shrink, so a tile
/// too small to hold one says the same thing in a sentence. Measured, not
/// counted: a small window has the same problem with a single tile.
class _Guide extends StatelessWidget {
  const _Guide({
    required this.single,
    required this.onClose,
    required this.title,
    required this.compactMessage,
    required this.compactIcon,
    required this.full,
  });

  final bool single;
  final VoidCallback onClose;
  final String title;
  final String compactMessage;
  final IconData compactIcon;
  final Widget full;

  @override
  Widget build(BuildContext context) {
    TerminalFontScope.watch(context);
    return LayoutBuilder(
      builder: (context, constraints) {
        final roomForCard =
            constraints.maxWidth >= 520 &&
            constraints.maxHeight >= (single ? 500 : 546);
        if (roomForCard) {
          if (single) return full;
          return Column(
            children: [
              _PaneHeader(title: title, onClose: onClose),
              Expanded(child: full),
            ],
          );
        }
        return _PaneStatus(
          title: title,
          icon: compactIcon,
          message: compactMessage,
          onClose: single ? null : onClose,
        );
      },
    );
  }
}

/// The same 46pt strip TerminalPanel draws, for the tiles that have no terminal
/// to draw one — so the close button never moves between states.
class _PaneHeader extends StatelessWidget {
  const _PaneHeader({required this.title, this.onClose});

  final String title;
  final VoidCallback? onClose;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    // The pane's head is a drag handle too: with the title bar hidden it is
    // the top edge of the window.
    return WindowDragArea(
      child: SizedBox(
        height: 46,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 14),
          child: Row(
            children: [
              Expanded(
                child: Text(
                  title,
                  overflow: TextOverflow.ellipsis,
                  style: grid.AppType.monoLabel(
                    color: AppColors.text,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
              if (onClose != null) PaneCloseButton(onPressed: onClose!),
            ],
          ),
        ),
      ),
    );
  }
}

class _PaneStatus extends StatelessWidget {
  const _PaneStatus({
    required this.title,
    required this.icon,
    required this.message,
    this.onClose,
    this.busy = false,
    this.actionLabel,
    this.onAction,
  });

  final String title;
  final IconData icon;
  final String message;
  final VoidCallback? onClose;
  final bool busy;

  /// An optional way out of the state being described. A pane that is merely waiting has none; one
  /// reporting a failure the user can retry does, and it reads the same as the error strip's RETRY.
  final String? actionLabel;
  final VoidCallback? onAction;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return Column(
      children: [
        _PaneHeader(title: title, onClose: onClose),
        Divider(height: 1, color: AppColors.border),
        Expanded(
          child: Center(
            child: Padding(
              padding: const EdgeInsets.all(20),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  SizedBox(
                    width: 26,
                    height: 26,
                    child: busy
                        ? const Center(
                            child: SizedBox(
                              width: 18,
                              height: 18,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            ),
                          )
                        : Icon(icon, size: 26, color: AppColors.mutedStrong),
                  ),
                  const SizedBox(height: 10),
                  Flexible(
                    child: SingleChildScrollView(
                      child: Text(
                        message,
                        textAlign: TextAlign.center,
                        style: grid.AppType.body(color: AppColors.mutedStrong),
                      ),
                    ),
                  ),
                  if (actionLabel != null && onAction != null) ...[
                    const SizedBox(height: 4),
                    TextButton(onPressed: onAction, child: Text(actionLabel!)),
                  ],
                ],
              ),
            ),
          ),
        ),
      ],
    );
  }
}

/// Where a dragged rail row can land.
///
/// [paneId] null means "make a new tile"; otherwise the drop replaces what that
/// tile is showing. Hit-testable only while a drag is actually in flight, so an
/// ordinary click still reaches the terminal underneath.
class _DropZone extends StatelessWidget {
  const _DropZone({
    required this.notifier,
    required this.paneId,
    required this.dragging,
    required this.child,
  });

  final AppNotifier notifier;
  final int? paneId;
  final AgentDragRef? dragging;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return Stack(
      fit: StackFit.expand,
      children: [
        child,
        Positioned.fill(
          child: IgnorePointer(
            ignoring: dragging == null,
            child: DragTarget<AgentDragRef>(
              onAcceptWithDetails: (details) => notifier.assignAgentToPane(
                paneId,
                details.data.machineId,
                details.data.agentId,
              ),
              builder: (context, candidate, _) => candidate.isEmpty
                  ? const SizedBox.expand()
                  : Container(
                      color: AppColors.accent.withValues(alpha: 0.16),
                      child: Center(
                        child: Container(
                          padding: const EdgeInsets.symmetric(
                            horizontal: 12,
                            vertical: 8,
                          ),
                          decoration: BoxDecoration(
                            color: grid.AppPalette.panelBg,
                            border: Border.all(color: AppColors.accent),
                            borderRadius: BorderRadius.circular(6),
                          ),
                          child: Text(
                            paneId == null
                                ? 'Open ${candidate.first?.name ?? 'agent'} here'
                                : 'Show ${candidate.first?.name ?? 'agent'} in this pane',
                            style: grid.AppType.label(color: AppColors.text),
                          ),
                        ),
                      ),
                    ),
            ),
          ),
        ),
      ],
    );
  }
}

class _AddSlot extends StatelessWidget {
  const _AddSlot();

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return DecoratedBox(
      decoration: BoxDecoration(
        color: grid.AppPalette.windowBg,
        border: Border.all(color: AppColors.border),
      ),
      child: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.add, size: 24, color: AppColors.mutedStrong),
            const SizedBox(height: 8),
            Text(
              'Drop here for a new pane',
              style: grid.AppType.body(color: AppColors.mutedStrong),
            ),
          ],
        ),
      ),
    );
  }
}

class _EmptyGrid extends StatelessWidget {
  const _EmptyGrid({required this.notifier});

  final AppNotifier notifier;

  /// Which machine a new agent would be started on.
  ///
  /// [AppNotifier.activeMachineState] answers for every case that has one —
  /// an open terminal, a selected machine, the first expanded one. It reads
  /// null only before any machine has been touched, which on a single-machine
  /// install (this Mac, and nothing linked yet) is exactly the first launch
  /// this button exists for; hence the fallback. With several machines and none
  /// picked there is no honest answer, so the button is not drawn and the rail's
  /// per-machine `+` stays the way in — a create that guessed the wrong machine
  /// is worse than one more click.
  String? get _machineId {
    final active = notifier.activeMachineState;
    if (active != null) return active.machine.machineId;
    final states = notifier.machineStates.values;
    return states.length == 1 ? states.first.machine.machineId : null;
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final machineId = _machineId;
    // Holds the keyboard while there is no terminal to hold it.
    //
    // App shortcuts are bound above this screen (swarm_screen.dart) and, like
    // every Flutter shortcut, they are delivered along the focus chain — from
    // whatever has focus up through its ancestors. With no pane open nothing
    // inside the screen has any, so the chain starts at the route's own scope,
    // which sits ABOVE the bindings: ⌘\, ⌘N, ⌘R and ⌘/ all did nothing until
    // the first terminal took focus. This is the state that tells the user to
    // press ⌘/ two lines below, so it had better answer.
    //
    // Safe here in a way it is not on the screen's own scope: this widget
    // exists only while there is no terminal, so it can never be the node that
    // keeps a focused pane from opening its TextInput connection.
    return Focus(
      autofocus: true,
      skipTraversal: true,
      child: ColoredBox(
        color: grid.AppPalette.windowBg,
        child: Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                'Select an agent, or drag one in from the left.',
                style: grid.AppType.body(color: AppColors.mutedStrong),
              ),
              // Selecting and dragging both need an agent to already exist. On a
              // first launch none does, so the two sentences around this button
              // are a dead end without it.
              if (machineId != null) ...[
                const SizedBox(height: 16),
                FilledButton.icon(
                  key: const ValueKey('empty-grid-new-agent'),
                  icon: const Icon(Icons.add, size: 16),
                  label: const Text('New Harness'),
                  onPressed: () => showNewAgentDialog(
                    context,
                    notifier,
                    machineId,
                    source: 'pane_empty',
                  ),
                ),
              ],
              const SizedBox(height: 8),
              // The empty pane is the one screen a new user is guaranteed to
              // look at, and it is doing nothing else. A sheet behind a key
              // nobody has been told about is a sheet nobody opens.
              Text(
                'Press ${shortcutHintFor(ShortcutAction.showShortcuts)} for '
                'keyboard shortcuts',
                style: grid.AppType.body(color: grid.AppPalette.textFaint),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// What a harness's viewer pane is called, so the harness's name is not printed twice beside its
/// terminal. The daemon's answer first; from a daemon that predates it, the shared viewer's name
/// from this machine's catalog ("3D Viewer"); else the harness's name and "Viewer"; else "Viewer".
String viewerPaneName(Agent? owner, Iterable<DshEntry> catalog) {
  if (owner == null) return 'Viewer';
  if (owner.viewerName case final name?) return name;
  final entry = catalog.where((e) => e.id == owner.dsh).firstOrNull;
  final used = entry?.viewerUse;
  if (used != null) {
    final viewer = catalog.where((e) => e.id == used).firstOrNull;
    if (viewer != null && viewer.name.trim().isNotEmpty) {
      return viewer.name.trim();
    }
  }
  final harness = owner.dshName ?? entry?.name;
  return harness == null || harness.trim().isEmpty
      ? 'Viewer'
      : '${harness.trim()} Viewer';
}
