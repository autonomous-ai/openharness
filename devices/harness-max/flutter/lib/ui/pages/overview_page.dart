// App Detail (the owner's call, 18 Nov): the app column, every agent of the ring in a row that scrolls sideways three
// cells to the glass, those who need the person first (BarModel.row), and the bell. A tap opens an agent across the row
// and the others shrink to dimmed slivers beside it; opening and closing are this page's own motion (the mockup's
// Bar.openAt and close), not a change of page.
import 'dart:math' as math;
import 'dart:ui' show lerpDouble;

import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';

import '../../model/bar_model.dart';
import '../../model/types.dart';
import '../app_icon.dart';
import '../lists/snap_physics.dart';
import '../overview/bits.dart';
import '../overview/cell.dart';
import '../overview/chip.dart';
import '../overview/motion.dart';
import '../overview/open_agent.dart';
import '../overview/rail.dart';
import '../overview/touch.dart';
import '../tokens.dart';

class OverviewPage extends StatefulWidget {
  const OverviewPage({super.key, required this.model});
  final BarModel model;

  @override
  State<OverviewPage> createState() => _OverviewPageState();
}

class _OverviewPageState extends State<OverviewPage> with SingleTickerProviderStateMixin {
  /// The cells' widths, from where they stood to where they go, by agent id.
  late final AnimationController _move = AnimationController(vsync: this, duration: kRowMove)
    ..value = 1
    ..addListener(_follow)
    ..addStatusListener(_settled);
  Map<String, double> _from = const {}, _to = const {};

  /// The open agent as the row lays it out, null while none is.
  String? _open;
  late final ScrollController _scroll;

  /// Opening: the row's scroll, carried along with the widths so it never runs past the narrowing row's end.
  ({double from, double to})? _carry;

  /// Closing: where the row scrolls once its cells have their widths again (before, the row is too short to reach).
  double? _back;

  /// The row's agents (ids) as last laid out, to see one move up past the cells before the glass.
  List<String> _order = const [];

  BarModel get model => widget.model;

  @override
  void initState() {
    super.initState();
    _open = _openOf();
    _from = _to = _targets(_open);
    _order = [for (final a in model.row) a.id];
    // Built open (from Attention, Inbox, the done note): the row is there at once, one sliver before the open agent.
    _scroll = ScrollController(initialScrollOffset: _open == null ? 0 : _openScroll(_open!));
    model.addListener(_changed);
  }

  @override
  void didUpdateWidget(OverviewPage old) {
    super.didUpdateWidget(old);
    if (old.model != model) {
      old.model.removeListener(_changed);
      model.addListener(_changed);
      _changed();
    }
  }

  @override
  void dispose() {
    model.removeListener(_changed);
    _move.dispose();
    _scroll.dispose();
    super.dispose();
  }

  String? _openOf() => model.page == BarPage.agent ? model.selected?.id : null;

  Map<String, double> _targets(String? open) => {
        for (final a in model.row) a.id: open == null ? kCellW : (a.id == open ? kOpenW : kSliverW),
      };

  double _width(String id) {
    final to = _to[id] ?? kCellW;
    return lerpDouble(_from[id] ?? to, to, kRowEase.transform(_move.value))!;
  }

  double get _pixels => _scroll.hasClients ? _scroll.offset : _scroll.initialScrollOffset;

  /// Where the row rests with [id] open: one sliver before it where there is one.
  double _openScroll(String id) {
    final row = model.row, n = row.length, i = row.indexWhere((a) => a.id == id);
    final end = math.max(0.0, kOpenW + (n - 1) * kSliverW - kRowW);
    return ((i - 1) * kSliverW).clamp(0.0, end);
  }

  void _changed() {
    // Fading out under another page, the row stays as it stood.
    if (model.page != BarPage.overview && model.page != BarPage.agent) return;
    final open = _openOf(), to = _targets(open);
    if (!mapEquals(to, _to)) {
      // From where each cell stands now, as a CSS transition restarts from its current value.
      _from = {for (final id in to.keys) id: _to.containsKey(id) ? _width(id) : to[id]!};
      _to = to;
      _move.forward(from: 0);
      if (open != null) {
        _carry = (from: _pixels, to: _openScroll(open));
        _back = null;
      }
    }
    if (open == null && _open != null) {
      final row = model.row, n = row.length, i = row.indexWhere((a) => a.id == _open);
      _carry = null;
      _back = i < 0 ? null : ((i - 1) * kCellW).clamp(0.0, math.max(0.0, (n - 3) * kCellW));
    } else if (open == null) {
      _frontIfPassed();
    }
    _order = [for (final a in model.row) a.id];
    setState(() => _open = open);
  }

  /// The row is by need (BarModel.row): an agent that moves up past the cells before the glass (the one just talked to
  /// starting work, one coming to wait on the person) would go out of sight, so the row goes to its front. A row that
  /// is closing goes there once its widths settle; a finger on the row keeps it.
  void _frontIfPassed() {
    final before = ((_back ?? _pixels) / kCellW).round();
    if (before <= 0) return;
    final now = [for (final a in model.row) a.id];
    if (setEquals(_order.take(before).toSet(), now.take(before).toSet())) return;
    if (_back != null) {
      _back = 0;
    } else if (_scroll.hasClients && !_scroll.position.isScrollingNotifier.value) {
      _scroll.animateTo(0, duration: kRowMove, curve: kRowEase);
    }
  }

  void _follow() {
    final c = _carry;
    if (c != null && _scroll.hasClients) _scroll.jumpTo(lerpDouble(c.from, c.to, kRowEase.transform(_move.value))!);
  }

  void _settled(AnimationStatus s) {
    if (s != AnimationStatus.completed) return;
    _carry = null;
    final back = _back;
    if (back == null) return;
    // Scrolling first, so the snapping row the rebuild brings takes over this scroll rather than snapping on its own.
    if (_scroll.hasClients) _scroll.animateTo(back, duration: kRowMove, curve: kRowEase);
    setState(() => _back = null);
  }

  /// A finger takes the row: the page stops moving it.
  bool _dragged(ScrollStartNotification n) {
    if (n.dragDetails == null) return false;
    _carry = null;
    if (_back != null) setState(() => _back = null);
    return false;
  }

  /// Each agent's cell is at least half on the glass.
  List<bool> _seen() {
    var left = -_pixels;
    final seen = <bool>[];
    for (final a in model.row) {
      final w = _width(a.id);
      seen.add(math.min(left + w, kRowW) - math.max(left, 0) >= w / 2);
      left += w;
    }
    return seen;
  }

  @override
  Widget build(BuildContext context) {
    final agents = model.row;
    final talk = model.talk;
    return DefaultTextHeightBehavior(
      textHeightBehavior: kEvenLeading,
      child: Motion(
        // the working rails sweep, the waiting ones and their glow pulse, the open agent's band moves while it records
        on: talk == TalkPhase.listening ||
            talk == TalkPhase.sending ||
            agents.any((a) => a.state == AgentState.working || a.state == AgentState.asking),
        // The open agent's X and body are Taps, which this area hears; a swipe here means nothing, the row scrolls.
        child: SwipeArea(
          onSwipe: (_) {},
          child: Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            SizedBox(width: 196, child: _AppColumn(model: model, dots: _dots())),
            Expanded(child: agents.isEmpty ? _none() : _row()),
            SizedBox(width: 112, child: _BellColumn(model: model)),
          ]),
        ),
      ),
    );
  }

  Widget _none() => Center(
        child: Text(model.connected ? 'No agents yet' : 'Not connected', style: Face.s(28, color: Ink.rest)),
      );

  /// One dot per agent in its state's colour, lit while its cell is on the glass; only when the row scrolls.
  Widget? _dots() {
    final agents = model.row;
    if (agents.length <= 3) return null;
    return ListenableBuilder(
      listenable: Listenable.merge([_scroll, _move]),
      builder: (context, _) {
        final seen = _seen();
        return SizedBox(
          height: 10,
          child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            for (var i = 0; i < agents.length; i++) ...[
              if (i > 0) const SizedBox(width: 7),
              AnimatedOpacity(
                key: ValueKey('dot$i'),
                opacity: seen[i] ? 1 : .28,
                duration: const Duration(milliseconds: 250),
                curve: Curves.ease,
                child: Container(
                  width: 9,
                  height: 9,
                  decoration: BoxDecoration(color: chipInk(agents[i].state), shape: BoxShape.circle),
                ),
              ),
            ],
          ]),
        );
      },
    );
  }

  Widget _row() {
    final open = _open;
    final row = SingleChildScrollView(
      controller: _scroll,
      scrollDirection: Axis.horizontal,
      // Closed, the row comes to rest on a cell's edge; open, and while it scrolls back, it rests where it is let go.
      physics: open == null && _back == null
          ? const SnapPhysics(origin: 0, extent: kCellW, parent: ClampingScrollPhysics())
          : const ClampingScrollPhysics(),
      child: Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        for (final a in model.row)
          ListenableBuilder(
            key: ValueKey(a.id),
            listenable: _move,
            builder: (context, cell) => SizedBox(width: _width(a.id), child: cell),
            child: _cell(a, open),
          ),
      ]),
    );
    return NotificationListener<ScrollStartNotification>(
      onNotification: _dragged,
      child: Stack(fit: StackFit.expand, children: [
        row,
        ListenableBuilder(
          listenable: Listenable.merge([_scroll, _move]),
          builder: (context, _) {
            final x = _pixels, end = model.row.fold(0.0, (w, a) => w + _width(a.id)) - kRowW;
            return Stack(fit: StackFit.expand, children: [
              _Fade(left: true, on: x > 4),
              _Fade(left: false, on: x < end - 4),
            ]);
          },
        ),
      ]),
    );
  }

  Widget _cell(Agent a, String? open) {
    final word = model.statusWord(a);
    if (open == null) {
      return AgentCell(agent: a, word: word, onTap: () {
        model.touched();
        model.tapCell(a.id);
      });
    }
    if (a.id == open) {
      return AgentCell(agent: a, word: word, look: CellLook.open, open: OpenAgent(model: model, agent: a));
    }
    return AgentCell(agent: a, word: word, look: CellLook.sliver, onTap: () {
      model.touched();
      model.tapSliver(a.id);
    });
  }
}

/// The row's faded edge (.cellwrap::before / ::after): 64 px from black .9 to clear, while more of the row lies that
/// way; under the rails.
class _Fade extends StatelessWidget {
  const _Fade({required this.left, required this.on});
  final bool left, on;

  @override
  Widget build(BuildContext context) => Positioned(
        left: left ? 0 : null,
        right: left ? null : 0,
        top: 5,
        bottom: 0,
        width: 64,
        child: IgnorePointer(
          child: AnimatedOpacity(
            key: ValueKey(left ? 'fade-left' : 'fade-right'),
            opacity: on ? 1 : 0,
            duration: const Duration(milliseconds: 250),
            curve: Curves.ease,
            child: DecoratedBox(
              decoration: BoxDecoration(
                gradient: LinearGradient(
                  begin: left ? Alignment.centerLeft : Alignment.centerRight,
                  end: left ? Alignment.centerRight : Alignment.centerLeft,
                  colors: const [Color.fromRGBO(0, 0, 0, .9), Color(0x00000000)],
                ),
              ),
            ),
          ),
        ),
      );
}

/// The shown app's icon and name, the grid glyph when another app can be picked (a tap opens Apps), how many agents
/// it has, and the row's dots.
class _AppColumn extends StatelessWidget {
  const _AppColumn({required this.model, required this.dots});
  final BarModel model;
  final Widget? dots;

  @override
  Widget build(BuildContext context) {
    final app = model.shown?.id ?? '';
    final apps = model.hasOtherApps;
    final n = model.agents.length;
    return Tap(
      onTap: apps
          ? () {
              model.touched();
              model.openApps();
            }
          : null,
      child: DecoratedBox(
        decoration: const BoxDecoration(border: Border(right: BorderSide(color: Ink.line))),
        child: Stack(fit: StackFit.expand, children: [
          const Positioned(left: 0, right: 1, top: 0, height: 5, child: Rail(color: kSideRail)),
          Padding(
            padding: const EdgeInsets.fromLTRB(26, 0, 27, 0),
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                if (app.isNotEmpty && hasAppIcon(app)) ...[AppIcon(app, size: 60), const SizedBox(height: 14)],
                Row(children: [
                  Flexible(
                    child: Text(model.appLabel,
                        maxLines: 1,
                        softWrap: false,
                        overflow: TextOverflow.ellipsis,
                        style: Face.s(24, weight: FontWeight.w600)),
                  ),
                  if (apps) ...[const SizedBox(width: 8), const GlyphIcon(Glyph.grid, size: 20, color: Ink.dim)],
                ]),
                // The row says when there are none.
                if (n > 0) ...[
                  const SizedBox(height: 6),
                  Text(n == 1 ? '1 agent' : '$n agents', style: Face.s(16, color: Ink.rest)),
                ],
                if (dots != null) ...[const SizedBox(height: 12), dots!],
              ],
            ),
          ),
        ]),
      ),
    );
  }
}

/// The bell in its round button, and the unread count on a yellow badge. The whole column is the tap.
class _BellColumn extends StatelessWidget {
  const _BellColumn({required this.model});
  final BarModel model;

  @override
  Widget build(BuildContext context) {
    final unread = model.unread;
    return Tap(
      onTap: () {
        model.touched();
        model.openInbox();
      },
      child: Stack(fit: StackFit.expand, children: [
        const Positioned(left: 0, right: 0, top: 0, height: 5, child: Rail(color: kSideRail)),
        Center(
          child: SizedBox.square(
            dimension: 64,
            child: Stack(clipBehavior: Clip.none, children: [
              const RoundButton(size: 64, child: GlyphIcon(Glyph.bell, size: 28, color: Ink.fg)),
              if (unread > 0)
                Positioned(
                  top: -3,
                  right: -3,
                  child: Container(
                    key: const ValueKey('badge'),
                    height: 24,
                    constraints: const BoxConstraints(minWidth: 24),
                    padding: const EdgeInsets.symmetric(horizontal: 6),
                    alignment: Alignment.center,
                    decoration: BoxDecoration(color: Ink.ask, borderRadius: BorderRadius.circular(12)),
                    child: Text(unread > 99 ? '99' : '$unread',
                        style: Face.s(14, weight: FontWeight.w700, color: const Color(0xFF000000), height: 24 / 14)),
                  ),
                ),
            ]),
          ),
        ),
      ]),
    );
  }
}
