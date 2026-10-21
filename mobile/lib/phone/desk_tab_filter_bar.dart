import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/widgets/touch_target.dart';

import 'tty.dart';
import 'tty_controls.dart';

/// One chip on [DeskTabFilterBar]: a desk tab, or — with a null [id] — every
/// harness, whatever tab it is on or none.
class DeskTabFilterChoice {
  const DeskTabFilterChoice({
    required this.id,
    required this.name,
    required this.count,
  });

  final String? id;
  final String name;

  /// How many harnesses picking it would list for the query as it stands.
  final int count;
}

/// The chips under Find's field: All, then the desk's tabs in the desk's order.
///
/// Chips and not a tab strip. What they change is which rows of ONE list are
/// drawn — the field above narrows the same list — and a strip of underlined
/// tabs reads as pages to move between. Each chip counts what it would list for
/// the query as typed, so a tab with nothing for that query says so before it
/// is tapped.
///
/// ⚠️ **A chip with nothing behind it is dimmed, never hidden.** A tab whose
/// machine is asleep holds nothing this phone can open, and a chip that vanished
/// with it would read as a tab that was closed.
///
/// A `+` after the last tab ([onNewTab]) is the desktop's `+` after its tabs:
/// a New Tab, which becomes a tab on every computer once its first harness is
/// in it.
///
/// Holding a tab's chip ([onLongPress]) is the desktop's right-click on a tab:
/// Rename Tab and Close Tab. All is no tab, and holding it does nothing.
class DeskTabFilterBar extends StatefulWidget {
  const DeskTabFilterBar({
    super.key,
    required this.choices,
    required this.selected,
    required this.onSelected,
    this.onNewTab,
    this.onLongPress,
  });

  final List<DeskTabFilterChoice> choices;

  /// The [DeskTabFilterChoice.id] picked; null is All.
  final String? selected;

  final ValueChanged<String?> onSelected;

  /// The `+` after the last chip. Null leaves it out.
  final VoidCallback? onNewTab;

  /// A tab's chip held, with its [DeskTabFilterChoice.id]. Never for All. Null
  /// leaves a held chip a slow tap.
  final ValueChanged<String>? onLongPress;

  /// Drawn height: a chip, with a gap over it that parts it from the field
  /// and one under it that parts it from the first row.
  static const double height = _gapAbove + _chipHeight + _gapBelow;
  static const double _gapAbove = 8;
  static const double _chipHeight = 30;
  static const double _gapBelow = 8;

  @override
  State<DeskTabFilterBar> createState() => _DeskTabFilterBarState();
}

class _DeskTabFilterBarState extends State<DeskTabFilterBar> {
  final _scroll = ScrollController();

  /// One per chip, so the picked one can be scrolled into view — which a pick
  /// made from outside the bar needs: "Show all tabs" under an empty tab puts
  /// All back while the rail may still be scrolled far past it.
  final _chipKeys = <String?, GlobalKey>{};

  /// Which ends of the rail have chips past them, and so fade out.
  bool _moreBefore = false, _moreAfter = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _readEdges());
  }

  @override
  void didUpdateWidget(DeskTabFilterBar old) {
    super.didUpdateWidget(old);
    final ids = {for (final choice in widget.choices) choice.id};
    _chipKeys.removeWhere((id, _) => !ids.contains(id));
    if (old.selected != widget.selected) {
      final picked = widget.selected;
      WidgetsBinding.instance.addPostFrameCallback((_) => _reveal(picked));
    }
  }

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  /// Scrolls the chip for [id] into view, and only if it is not in view already.
  ///
  /// Both policies are asked for, and at most one of them moves anything: a chip
  /// narrower than the rail can hang off one end, never both.
  void _reveal(String? id) {
    if (!mounted) return;
    final chip = _chipKeys[id]?.currentContext;
    if (chip == null) return;
    final duration = MediaQuery.disableAnimationsOf(context)
        ? Duration.zero
        : AppMotion.swap;
    for (final policy in const [
      ScrollPositionAlignmentPolicy.keepVisibleAtEnd,
      ScrollPositionAlignmentPolicy.keepVisibleAtStart,
    ]) {
      Scrollable.ensureVisible(
        chip,
        duration: duration,
        curve: AppMotion.curve,
        alignmentPolicy: policy,
      );
    }
  }

  /// What holding the chip for [id] does: nothing for All, nor without a
  /// [DeskTabFilterBar.onLongPress].
  VoidCallback? _held(String? id) {
    final held = widget.onLongPress;
    if (id == null || held == null) return null;
    return () => held(id);
  }

  void _readEdges([ScrollMetrics? metrics]) {
    if (!mounted) return;
    final read = metrics ?? (_scroll.hasClients ? _scroll.position : null);
    if (read == null || !read.hasContentDimensions) return;
    final before = read.extentBefore > 0.5;
    final after = read.extentAfter > 0.5;
    if (before == _moreBefore && after == _moreAfter) return;
    setState(() {
      _moreBefore = before;
      _moreAfter = after;
    });
  }

  @override
  Widget build(BuildContext context) {
    final choices = widget.choices;
    // Always masked, even with nothing to fade: taking the mask away would
    // re-parent the scroll view and throw away where it was scrolled to.
    return SizedBox(
      height: DeskTabFilterBar.height,
      child: ShaderMask(
        blendMode: BlendMode.dstIn,
        shaderCallback: (bounds) {
          // 24pt of fade at each end; none on a rail too narrow to spare it.
          final edge = bounds.width <= 48 ? 0.0 : 24 / bounds.width;
          const shown = Color(0xFF000000);
          const gone = Color(0x00000000);
          return LinearGradient(
            colors: [
              _moreBefore ? gone : shown,
              shown,
              shown,
              _moreAfter ? gone : shown,
            ],
            stops: [0, edge, 1 - edge, 1],
          ).createShader(bounds);
        },
        child: NotificationListener<ScrollMetricsNotification>(
          onNotification: (notification) {
            _readEdges(notification.metrics);
            return false;
          },
          child: NotificationListener<ScrollNotification>(
            onNotification: (notification) {
              _readEdges(notification.metrics);
              return false;
            },
            // A plain Row in a scroll view, not a lazy list: a desk has a
            // handful of tabs, and every chip has to be built for [_reveal] to
            // find it.
            child: SingleChildScrollView(
              controller: _scroll,
              scrollDirection: Axis.horizontal,
              // The rows' own gutter, so the first chip starts where their
              // names do.
              padding: const EdgeInsets.fromLTRB(
                Tty.origin,
                DeskTabFilterBar._gapAbove,
                Tty.origin,
                DeskTabFilterBar._gapBelow,
              ),
              child: Row(
                children: [
                  for (var i = 0; i < choices.length; i++) ...[
                    if (i > 0) const SizedBox(width: 6),
                    _FilterChip(
                      key: _chipKeys.putIfAbsent(choices[i].id, GlobalKey.new),
                      choice: choices[i],
                      selected: choices[i].id == widget.selected,
                      onTap: () => widget.onSelected(choices[i].id),
                      onLongPress: _held(choices[i].id),
                    ),
                  ],
                  if (widget.onNewTab case final onNewTab?) ...[
                    const SizedBox(width: 6),
                    _NewTabChip(onTap: onNewTab),
                  ],
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _FilterChip extends StatefulWidget {
  const _FilterChip({
    super.key,
    required this.choice,
    required this.selected,
    required this.onTap,
    this.onLongPress,
  });

  final DeskTabFilterChoice choice;
  final bool selected;
  final VoidCallback onTap;
  final VoidCallback? onLongPress;

  @override
  State<_FilterChip> createState() => _FilterChipState();
}

class _FilterChipState extends State<_FilterChip> {
  bool _pressed = false;

  void _press(bool pressed) {
    if (_pressed == pressed) return;
    setState(() => _pressed = pressed);
  }

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    final choice = widget.choice;
    final selected = widget.selected;
    final empty = choice.count == 0;
    // The picked chip is the one solid thing on the rail — the terminal's ink
    // turned into ground — so which tab the list is showing is read without
    // reading.
    final ink = selected
        ? tty.ground
        : empty
        ? tty.dim
        : tty.text;
    final countInk = selected
        ? tty.ground.withValues(alpha: 0.62)
        : empty
        ? tty.dim
        : tty.faint;
    final held = widget.onLongPress;
    return Semantics(
      button: true,
      selected: selected,
      label: '${choice.name}, ${choice.count}',
      // The chip's own semantics are excluded below, its gesture's with them: a screen reader's
      // hold reaches the menu through this.
      onLongPress: held,
      onLongPressHint: held == null ? null : 'Rename or close',
      excludeSemantics: true,
      child: TouchTarget(
        child: GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTapDown: (_) => _press(true),
          onTapUp: (_) => _press(false),
          onTapCancel: () => _press(false),
          onTap: () {
            HapticFeedback.selectionClick();
            widget.onTap();
          },
          // Released here as well as in `onTapCancel`: the chip must not stay sunk under the sheet
          // this opens, which outlives the gesture that opened it.
          onLongPress: held == null
              ? null
              : () {
                  _press(false);
                  HapticFeedback.mediumImpact();
                  held();
                },
          child: AnimatedContainer(
            duration: AppMotion.press,
            curve: AppMotion.curve,
            height: DeskTabFilterBar._chipHeight,
            constraints: const BoxConstraints(maxWidth: 200),
            padding: const EdgeInsets.symmetric(horizontal: 10),
            decoration: BoxDecoration(
              color: selected
                  ? tty.text
                  : _pressed
                  ? ttyRaised(tty)
                  : Colors.transparent,
              borderRadius: BorderRadius.circular(6),
              border: Border.all(
                color: selected
                    ? Colors.transparent
                    : tty.text.withValues(alpha: 0.16),
              ),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                // A long tab name gives way; the count after it never does.
                Flexible(
                  child: Text(
                    choice.name,
                    maxLines: 1,
                    softWrap: false,
                    overflow: TextOverflow.ellipsis,
                    style: tty.style(color: ink, size: TtySize.meta),
                  ),
                ),
                const SizedBox(width: 7),
                Text(
                  '${choice.count}',
                  style: tty.style(color: countInk, size: TtySize.meta),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// The `+` after the last tab: a chip's own outline around a plus, as wide as
/// it is tall, so it reads as one more place on the rail rather than a tab.
class _NewTabChip extends StatefulWidget {
  const _NewTabChip({required this.onTap});

  final VoidCallback onTap;

  @override
  State<_NewTabChip> createState() => _NewTabChipState();
}

class _NewTabChipState extends State<_NewTabChip> {
  bool _pressed = false;

  void _press(bool pressed) {
    if (_pressed == pressed) return;
    setState(() => _pressed = pressed);
  }

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    return Semantics(
      button: true,
      label: 'New Tab',
      excludeSemantics: true,
      child: TouchTarget(
        child: GestureDetector(
          key: const ValueKey('find-new-tab'),
          behavior: HitTestBehavior.opaque,
          onTapDown: (_) => _press(true),
          onTapUp: (_) => _press(false),
          onTapCancel: () => _press(false),
          onTap: () {
            HapticFeedback.selectionClick();
            widget.onTap();
          },
          child: AnimatedContainer(
            duration: AppMotion.press,
            curve: AppMotion.curve,
            width: DeskTabFilterBar._chipHeight,
            height: DeskTabFilterBar._chipHeight,
            decoration: BoxDecoration(
              color: _pressed ? ttyRaised(tty) : Colors.transparent,
              borderRadius: BorderRadius.circular(6),
              border: Border.all(color: tty.text.withValues(alpha: 0.16)),
            ),
            child: Icon(LucideIcons.plus300, size: 16, color: tty.faint),
          ),
        ),
      ),
    );
  }
}
