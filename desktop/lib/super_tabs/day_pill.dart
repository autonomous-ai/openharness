import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../widgets/desktop_chrome.dart';

/// The day of the message at the top of a list, in a small pill over the
/// list's top while the reader is scrolled into it, as Slack's (Huy 11-03).
/// It replaces itself as the reader passes into another day.
///
/// The pill floats over [child] and takes no room in it, so no row moves when
/// it shows, changes or goes. Each message row in [child] is wrapped in a
/// [SuperTabDayMark] with its time; rows without one are not counted. With
/// nothing hidden above the list's top (the start of what is read) it shows
/// nothing, and the inline day line says the day.
///
/// A day line's label in [child] is a [SuperTabDayLabel]. Once a label
/// reaches the pill, the pill takes its place, as Slack's: the pill says the
/// label's day and the label is not painted, so one label shows (Huy 11-04).
class SuperTabStickyDay extends StatefulWidget {
  const SuperTabStickyDay({
    super.key,
    required this.child,
    this.pillKey,
    this.hidden = false,
  });

  final Widget child;

  /// The pill's key, so a chat and its thread can be told apart.
  final Key? pillKey;

  /// Another note holds the list's top (finding a quoted message).
  final bool hidden;

  @override
  State<SuperTabStickyDay> createState() => _SuperTabStickyDayState();
}

class _SuperTabStickyDayState extends State<SuperTabStickyDay> {
  final _marks = <_SuperTabDayMarkState>{};
  final _labels = <_SuperTabDayLabelState>{};
  DateTime? _day;
  bool _measuring = false;

  @override
  void initState() {
    super.initState();
    _measureAfterFrame();
  }

  @override
  void didUpdateWidget(SuperTabStickyDay oldWidget) {
    super.didUpdateWidget(oldWidget);
    // Rows came or went with the list's rebuild.
    _measureAfterFrame();
  }

  void _measureAfterFrame() {
    if (_measuring) return;
    _measuring = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _measuring = false;
      if (!mounted) return;
      final (:day, :under) = _measure();
      // The pill and the labels it covers change in the same frame.
      if (day != _day) setState(() => _day = day);
      for (final label in _labels.toList()) {
        label._cover(under.contains(label));
      }
    });
  }

  /// The pill's day and the day line labels it covers, null and none when
  /// nothing is hidden above the list's top.
  ///
  /// The day is that of the lowest label whose top has reached the pill's
  /// bottom edge, which the pill covers with every label above it; with none,
  /// the day of the row at the top edge: the one the edge cuts through, else
  /// the highest one below it.
  ({DateTime? day, Set<_SuperTabDayLabelState> under}) _measure() {
    const none = (day: null, under: <_SuperTabDayLabelState>{});
    final list = context.findRenderObject();
    if (list is! RenderBox || !list.hasSize) return none;
    ({double top, DateTime time})? at;
    ScrollPosition? position;
    for (final mark in _marks) {
      final time = mark.widget.time;
      final box = mark.context.findRenderObject();
      if (time == null || box is! RenderBox || !box.attached || !box.hasSize) {
        continue;
      }
      final top = box.localToGlobal(Offset.zero, ancestor: list).dy;
      final bottom = top + box.size.height;
      if (bottom <= 0 || top >= list.size.height) continue;
      position ??= Scrollable.maybeOf(mark.context)?.position;
      final better =
          at == null ||
          (top <= 0 ? at.top > 0 || top > at.top : at.top > 0 && top < at.top);
      if (better) at = (top: top, time: time);
    }
    if (at == null || position == null || !position.hasPixels) return none;
    if (position.extentBefore <= 0) return none;
    final under = <_SuperTabDayLabelState>{};
    ({double top, DateTime day})? passed;
    for (final label in _labels) {
      final box = label.context.findRenderObject();
      if (box is! RenderBox || !box.attached || !box.hasSize) continue;
      final top = box.localToGlobal(Offset.zero, ancestor: list).dy;
      // The pill's text is set as the label's, inside the pill's padding.
      if (top >= SuperTabDayPill.top + SuperTabDayPill.heightFor(box.size)) {
        continue;
      }
      under.add(label);
      if (passed == null || top > passed.top) {
        passed = (top: top, day: label.widget.day);
      }
    }
    final local = (passed?.day ?? at.time).toLocal();
    return (
      day: DateTime(local.year, local.month, local.day),
      under: widget.hidden ? const {} : under,
    );
  }

  bool _onScroll(Notification event) {
    final depth = switch (event) {
      ScrollNotification(:final depth, :final metrics) ||
      ScrollMetricsNotification(
        :final depth,
        :final metrics,
      ) when metrics.axis == Axis.vertical => depth,
      _ => null,
    };
    if (depth == 0) _measureAfterFrame();
    return false;
  }

  @override
  Widget build(BuildContext context) {
    final day = _day;
    return _SuperTabDayScope(
      state: this,
      child: Stack(
        children: [
          Positioned.fill(
            child: NotificationListener<Notification>(
              onNotification: _onScroll,
              child: widget.child,
            ),
          ),
          if (day != null && !widget.hidden)
            Positioned(
              top: SuperTabDayPill.top,
              left: 0,
              right: 0,
              child: IgnorePointer(
                // The day lines in the list say it to a screen reader.
                child: ExcludeSemantics(
                  child: Center(
                    child: SuperTabDayPill(key: widget.pillKey, day: day),
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

/// A day line's label, which the [SuperTabStickyDay] above it covers once
/// the pill reaches it. A covered label keeps its place, so no row moves, and
/// a screen reader still reads it.
class SuperTabDayLabel extends StatefulWidget {
  const SuperTabDayLabel({super.key, required this.day, required this.child});

  /// The day the label says.
  final DateTime day;
  final Widget child;

  @override
  State<SuperTabDayLabel> createState() => _SuperTabDayLabelState();
}

class _SuperTabDayLabelState extends State<SuperTabDayLabel> {
  _SuperTabStickyDayState? _list;
  bool _covered = false;

  void _cover(bool covered) {
    if (covered != _covered && mounted) setState(() => _covered = covered);
  }

  void _join() {
    final list = context
        .getInheritedWidgetOfExactType<_SuperTabDayScope>()
        ?.state;
    if (list == _list) return;
    _list?._labels.remove(this);
    _list = list?.._labels.add(this);
  }

  void _leave() {
    _list?._labels.remove(this);
    _list = null;
    _covered = false;
  }

  @override
  void activate() {
    super.activate();
    _join();
  }

  @override
  void deactivate() {
    _leave();
    super.deactivate();
  }

  @override
  void dispose() {
    _leave();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    _join();
    return Visibility(
      visible: !_covered,
      maintainSize: true,
      maintainAnimation: true,
      maintainState: true,
      maintainSemantics: true,
      child: widget.child,
    );
  }
}

class _SuperTabDayScope extends InheritedWidget {
  const _SuperTabDayScope({required this.state, required super.child});

  final _SuperTabStickyDayState state;

  @override
  bool updateShouldNotify(_SuperTabDayScope oldWidget) =>
      state != oldWidget.state;
}

/// A message row's time, for the [SuperTabStickyDay] above it.
class SuperTabDayMark extends StatefulWidget {
  const SuperTabDayMark({super.key, required this.time, required this.child});

  final DateTime? time;
  final Widget child;

  @override
  State<SuperTabDayMark> createState() => _SuperTabDayMarkState();
}

class _SuperTabDayMarkState extends State<SuperTabDayMark> {
  _SuperTabStickyDayState? _list;

  void _join() {
    final list = context
        .getInheritedWidgetOfExactType<_SuperTabDayScope>()
        ?.state;
    if (list == _list) return;
    _list?._marks.remove(this);
    _list = list?.._marks.add(this);
  }

  void _leave() {
    _list?._marks.remove(this);
    _list = null;
  }

  @override
  void activate() {
    super.activate();
    _join();
  }

  // A row taken out of the tree is not measured, even before it is disposed.
  @override
  void deactivate() {
    _leave();
    super.deactivate();
  }

  @override
  void dispose() {
    _leave();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    _join();
    return widget.child;
  }
}

/// The pill: the day as the chat's day lines say it.
class SuperTabDayPill extends StatelessWidget {
  const SuperTabDayPill({super.key, required this.day});

  final DateTime day;

  /// The pill's distance from the list's top.
  static const top = grid.AppDesktop.controlGap;

  static const _padding = EdgeInsets.symmetric(
    horizontal: grid.AppDesktop.controlGap + grid.AppDesktop.menuInset,
    vertical: grid.AppDesktop.listRowGap,
  );
  static const _rim = 1.0;

  /// The pill's height around a label of [label]'s size, set in the same
  /// style as the pill's text.
  static double heightFor(Size label) =>
      label.height + _padding.vertical + 2 * _rim;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return DecoratedBox(
      decoration: ShapeDecoration(
        // Opaque, so the rows it floats over never read through it.
        color: DesktopChrome.surface.withValues(alpha: 1),
        shape: StadiumBorder(
          side: BorderSide(color: DesktopChrome.rim, width: _rim),
        ),
        // Lifted off the rows it floats over, as Slack's.
        shadows: grid.AppGlass.cardShadow,
      ),
      child: Padding(
        padding: _padding,
        child: Text(
          MaterialLocalizations.of(context).formatMediumDate(day),
          maxLines: 1,
          style: DesktopChrome.metadata(),
        ),
      ),
    );
  }
}
