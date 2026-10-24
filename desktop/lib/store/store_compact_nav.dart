import 'dart:async';

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';

import '../shared/theme/app_theme.dart' as grid;

/// The smallest box a finger can reliably hit on a phone (audit finding S1).
const double kStoreMinHit = 44;

/// How far each end of the chip row fades over the chips behind it.
const double _fadeWidth = 32;

/// A [kStoreMinHit] box around a smaller control, for phones: the ring
/// outside the control does what the control does, and a screen reader finds
/// one button the size of the box. The control keeps its own look.
class StoreHitArea extends StatelessWidget {
  const StoreHitArea({
    super.key,
    required this.onTap,
    required this.child,
    this.selected,
    this.onHover,
  });

  final VoidCallback? onTap;
  final Widget child;
  final bool? selected;
  final ValueChanged<bool>? onHover;

  @override
  Widget build(BuildContext context) {
    return MergeSemantics(
      child: Semantics(
        button: true,
        selected: selected,
        child: MouseRegion(
          cursor: onTap == null
              ? SystemMouseCursors.basic
              : SystemMouseCursors.click,
          onEnter: onHover == null ? null : (_) => onHover!(true),
          onExit: onHover == null ? null : (_) => onHover!(false),
          child: GestureDetector(
            behavior: HitTestBehavior.opaque,
            onTap: onTap,
            child: ConstrainedBox(
              constraints: const BoxConstraints(
                minWidth: kStoreMinHit,
                minHeight: kStoreMinHit,
              ),
              child: Center(widthFactor: 1, heightFactor: 1, child: child),
            ),
          ),
        ),
      ),
    );
  }
}

/// One shelf in the phone Store's chip row.
class StoreChip {
  const StoreChip({
    required this.id,
    required this.label,
    required this.icon,
    required this.selected,
    required this.onTap,
    this.count,
  });

  /// Keys the chip as `store-chip:<id>`.
  final String id;
  final String label;
  final IconData icon;
  final bool selected;
  final VoidCallback onTap;
  final int? count;
}

/// The Store's rail as a phone has room for it (audit finding B1): one row of
/// chips above the content. A mouse wheel rolls it sideways, each end fades
/// while chips are hidden past it, and the selected chip is scrolled into
/// view when the row opens and whenever the selection moves.
class StoreChipRow extends StatefulWidget {
  const StoreChipRow({super.key, required this.chips});

  final List<StoreChip> chips;

  @override
  State<StoreChipRow> createState() => _StoreChipRowState();
}

class _StoreChipRowState extends State<StoreChipRow> {
  final _scroll = ScrollController();
  final _chipKeys = <String, GlobalKey>{};

  @override
  void initState() {
    super.initState();
    _scroll.addListener(_changed);
    // The row has no extent until it has laid out once.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _changed();
      _revealSelected(animate: false);
    });
  }

  @override
  void didUpdateWidget(StoreChipRow oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (_selectedOf(oldWidget.chips) == _selectedOf(widget.chips)) return;
    WidgetsBinding.instance.addPostFrameCallback(
      (_) => _revealSelected(animate: true),
    );
  }

  static String? _selectedOf(List<StoreChip> chips) =>
      chips.where((chip) => chip.selected).firstOrNull?.id;

  /// Scrolls the least distance that shows the selected chip whole and clear
  /// of the fades; a chip already in view does not move the row.
  void _revealSelected({required bool animate}) {
    final id = _selectedOf(widget.chips);
    final chip = id == null ? null : _chipKeys[id]?.currentContext;
    if (!mounted || chip == null || !_scroll.hasClients) return;
    final box = chip.findRenderObject()!;
    final viewport = RenderAbstractViewport.of(box);
    final position = _scroll.position;
    final atStart = viewport.getOffsetToReveal(box, 0).offset - _fadeWidth;
    final atEnd = viewport.getOffsetToReveal(box, 1).offset + _fadeWidth;
    final target = position.pixels > atStart
        ? atStart
        : position.pixels < atEnd
        ? atEnd
        : null;
    if (target == null) return;
    final clamped = target.clamp(
      position.minScrollExtent,
      position.maxScrollExtent,
    );
    if (!animate || MediaQuery.disableAnimationsOf(context)) {
      position.jumpTo(clamped);
      return;
    }
    unawaited(
      position.animateTo(
        clamped,
        // As the tab row pages its tabs.
        duration: const Duration(milliseconds: 220),
        curve: Curves.easeOutCubic,
      ),
    );
  }

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  void _changed() {
    if (mounted) setState(() {});
  }

  /// A wheel sends vertical deltas, which a horizontal list ignores; the
  /// larger of the two axes rolls the row.
  void _wheel(PointerSignalEvent event) {
    if (event is! PointerScrollEvent || !_scroll.hasClients) return;
    final position = _scroll.position;
    final delta = event.scrollDelta.dx.abs() > event.scrollDelta.dy.abs()
        ? event.scrollDelta.dx
        : event.scrollDelta.dy;
    if (delta == 0) return;
    GestureBinding.instance.pointerSignalResolver.register(event, (_) {
      position.jumpTo(
        (position.pixels + delta).clamp(
          position.minScrollExtent,
          position.maxScrollExtent,
        ),
      );
    });
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final position = _scroll.hasClients ? _scroll.position : null;
    final hasExtent = position?.hasContentDimensions ?? false;
    final atStart = !hasExtent || position!.pixels <= position.minScrollExtent;
    final atEnd = !hasExtent || position!.pixels >= position.maxScrollExtent;
    return NotificationListener<ScrollMetricsNotification>(
      onNotification: (_) {
        _changed();
        return false;
      },
      child: Listener(
        onPointerSignal: _wheel,
        child: SizedBox(
          key: const ValueKey('store-chips'),
          height: kStoreMinHit,
          child: Stack(
            children: [
              // Every chip is built, not only the visible ones, so a screen
              // reader can reach the ones past the edge.
              SingleChildScrollView(
                controller: _scroll,
                scrollDirection: Axis.horizontal,
                // The content's own gutter on a phone, so the first chip
                // lines up with the page under it.
                padding: const EdgeInsets.symmetric(horizontal: 20),
                child: Row(
                  children: [
                    for (final (i, chip) in widget.chips.indexed) ...[
                      if (i > 0) const SizedBox(width: 6),
                      KeyedSubtree(
                        key: _chipKeys.putIfAbsent(chip.id, GlobalKey.new),
                        child: _ChipButton(chip: chip),
                      ),
                    ],
                  ],
                ),
              ),
              if (!atStart)
                const _EdgeFade(
                  key: ValueKey('store-chips-fade-start'),
                  start: true,
                ),
              if (!atEnd)
                const _EdgeFade(
                  key: ValueKey('store-chips-fade-end'),
                  start: false,
                ),
            ],
          ),
        ),
      ),
    );
  }
}

/// The page's own colour washing over the chips at one end of the row.
class _EdgeFade extends StatelessWidget {
  const _EdgeFade({super.key, required this.start});

  final bool start;

  @override
  Widget build(BuildContext context) {
    final page = grid.AppPalette.windowBg;
    return Positioned(
      top: 0,
      bottom: 0,
      left: start ? 0 : null,
      right: start ? null : 0,
      width: _fadeWidth,
      child: IgnorePointer(
        child: DecoratedBox(
          decoration: BoxDecoration(
            gradient: LinearGradient(
              begin: start ? Alignment.centerLeft : Alignment.centerRight,
              end: start ? Alignment.centerRight : Alignment.centerLeft,
              colors: [page, page.withValues(alpha: 0)],
            ),
          ),
        ),
      ),
    );
  }
}

class _ChipButton extends StatefulWidget {
  const _ChipButton({required this.chip});

  final StoreChip chip;

  @override
  State<_ChipButton> createState() => _ChipButtonState();
}

class _ChipButtonState extends State<_ChipButton> {
  bool _hovered = false;

  @override
  Widget build(BuildContext context) {
    final chip = widget.chip;
    final ink = chip.selected
        ? grid.AppPalette.textPrimary
        : grid.AppPalette.textSecondary;
    return StoreHitArea(
      key: ValueKey('store-chip:${chip.id}'),
      onTap: chip.onTap,
      selected: chip.selected,
      onHover: (hovered) => setState(() => _hovered = hovered),
      child: AnimatedContainer(
        duration: MediaQuery.disableAnimationsOf(context)
            ? Duration.zero
            : grid.AppMotion.hover,
        curve: grid.AppMotion.curve,
        height: 32,
        padding: const EdgeInsets.symmetric(horizontal: 12),
        decoration: BoxDecoration(
          color: chip.selected
              ? grid.AppSurface.selectedFill
              : _hovered
              ? grid.AppSurface.hoverFill
              : Colors.transparent,
          border: Border.all(
            color: chip.selected ? Colors.transparent : grid.AppPalette.divider,
          ),
          borderRadius: BorderRadius.circular(16),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(chip.icon, size: 15, color: ink),
            const SizedBox(width: 6),
            Text(
              chip.label,
              maxLines: 1,
              softWrap: false,
              style: grid.AppType.label(color: ink),
            ),
            if (chip.count != null) ...[
              const SizedBox(width: 6),
              Text(
                '${chip.count}',
                style: grid.AppType.caption(color: grid.AppPalette.textFaint),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
