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
      final day = _dayAtTop();
      if (day != _day) setState(() => _day = day);
    });
  }

  /// The local day of the row at the top edge: the one the edge cuts
  /// through, else the highest one below it; null when nothing is hidden
  /// above the list's top.
  DateTime? _dayAtTop() {
    final list = context.findRenderObject();
    if (list is! RenderBox || !list.hasSize) return null;
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
    if (at == null || position == null || !position.hasPixels) return null;
    if (position.extentBefore <= 0) return null;
    final local = at.time.toLocal();
    return DateTime(local.year, local.month, local.day);
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
              top: grid.AppDesktop.controlGap,
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

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return DecoratedBox(
      decoration: ShapeDecoration(
        color: DesktopChrome.surface,
        shape: StadiumBorder(side: BorderSide(color: DesktopChrome.rim)),
      ),
      child: Padding(
        padding: const EdgeInsets.symmetric(
          horizontal: grid.AppDesktop.controlGap + grid.AppDesktop.menuInset,
          vertical: grid.AppDesktop.listRowGap,
        ),
        child: Text(
          MaterialLocalizations.of(context).formatMediumDate(day),
          maxLines: 1,
          style: DesktopChrome.metadata(),
        ),
      ),
    );
  }
}
