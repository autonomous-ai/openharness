// Overview: the app column, up to five agent cells, the bell; dots page the cells. As the mockup's renderOverview.
import 'package:flutter/widgets.dart';

import '../../model/bar_model.dart';
import '../../model/types.dart';
import '../app_icon.dart';
import '../overview/cell.dart';
import '../overview/bits.dart';
import '../overview/motion.dart';
import '../overview/rail.dart';
import '../overview/touch.dart';
import '../tokens.dart';

class OverviewPage extends StatelessWidget {
  const OverviewPage({super.key, required this.model});
  final BarModel model;

  @override
  Widget build(BuildContext context) {
    final cells = model.cells;
    return DefaultTextHeightBehavior(
      textHeightBehavior: kEvenLeading,
      child: Motion(
        // the working rails sweep, the waiting ones and their glow pulse; nothing else on the page needs frames
        on: cells.any((a) => a.state == AgentState.working || a.state == AgentState.asking),
        child: SwipeArea(
          onSwipe: (dir) {
            model.touched();
            model.swipeCells(dir);
          },
          child: Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            SizedBox(width: 196, child: _AppColumn(model: model)),
            Expanded(child: _Cells(model: model, cells: cells)),
            SizedBox(width: 112, child: _BellColumn(model: model)),
          ]),
        ),
      ),
    );
  }
}

/// The shown app's icon and name, and the grid glyph when another app can be picked (a tap opens Apps).
class _AppColumn extends StatelessWidget {
  const _AppColumn({required this.model});
  final BarModel model;

  @override
  Widget build(BuildContext context) {
    final app = model.shown?.id ?? '';
    final apps = model.hasOtherApps;
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
              ],
            ),
          ),
        ]),
      ),
    );
  }
}

/// The page's cells, the page dots under them, or why there are none.
class _Cells extends StatelessWidget {
  const _Cells({required this.model, required this.cells});
  final BarModel model;
  final List<Agent> cells;

  @override
  Widget build(BuildContext context) {
    if (cells.isEmpty) {
      return Center(
        child: Text(model.connected ? 'No agents yet' : 'Not connected', style: Face.s(28, color: Ink.rest)),
      );
    }
    final pages = model.cellPages;
    // Across pages every cell keeps a full page's width: a cell does not change size as the page turns.
    final slots = pages > 1 ? kCells : cells.length;
    return Stack(fit: StackFit.expand, children: [
      Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        for (final a in cells)
          Expanded(
            child: AgentCell(
              key: ValueKey(a.id),
              agent: a,
              word: model.statusWord(a),
              onTap: () {
                model.touched();
                model.tapCell(a.id);
              },
            ),
          ),
        if (slots > cells.length) Spacer(flex: slots - cells.length),
      ]),
      if (pages > 1) Positioned(left: 0, right: 0, bottom: 14, height: 8, child: _Dots(model: model, pages: pages)),
    ]);
  }
}

/// One dot per page of cells: the page shown long and bright, a page where an agent waits in yellow.
class _Dots extends StatelessWidget {
  const _Dots({required this.model, required this.pages});
  final BarModel model;
  final int pages;

  @override
  Widget build(BuildContext context) => Row(mainAxisAlignment: MainAxisAlignment.center, children: [
        for (var p = 0; p < pages; p++) ...[
          if (p > 0) const SizedBox(width: 10),
          Container(
            key: ValueKey('dot$p'),
            width: p == model.cellPage ? 16 : 8,
            decoration: BoxDecoration(
              color: model.pageWaits(p) ? Ink.ask : (p == model.cellPage ? Ink.fg : Ink.faint),
              borderRadius: BorderRadius.circular(4),
            ),
          ),
        ],
      ]);
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
