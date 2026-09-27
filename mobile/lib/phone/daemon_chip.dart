import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'package:harness_mobile/shared/widgets/touch_target.dart';

import 'daemon_scope.dart';
import 'daemon_sheet.dart';
import 'daemon_style.dart';

/// The paired daemon at the right end of the terminal's title (and of the
/// empty home's top line): its eight-cell sprite in its colour, on a sliver of
/// night (see [DaemonInk]), the way it sits in tmux's status line on a
/// computer. Before any daemon it is the nest at its stage, or the egg ready
/// to hatch.
///
/// A shiny daemon wears its shiny colour and a `*` before its slot (outside
/// the ten cells, so the mark never reads as part of the art: a 2.0 sprite
/// fills the slot to its gutter). A tap boops it and opens its sheet. A dot
/// on its corner says eggs are waiting. Nothing at all is drawn outside the
/// signed-in shell or before the zoo has answered — a boot never flashes an
/// empty nest at somebody who owns six daemons.
///
/// ⚠️ **Art is not scaled with the text.** The sprite is ten cells of ASCII in
/// a 26pt slot; larger text would push the names beside it off the row. A
/// screen reader hears [DaemonFace.semantics] instead, and the sheet this
/// opens scales everything.
class DaemonChip extends StatelessWidget {
  const DaemonChip({super.key, this.margin = EdgeInsets.zero});

  static const height = 26.0;

  /// Space kept around the chip, only while it draws: with daemons off, or
  /// before the zoo answers, whatever it sits beside keeps the room it had.
  final EdgeInsetsGeometry margin;

  @override
  Widget build(BuildContext context) {
    final host = DaemonScope.maybeOf(context);
    if (host == null) return const SizedBox.shrink();
    return ListenableBuilder(
      listenable: Listenable.merge([host.face, host.zoo]),
      builder: (context, _) {
        final face = host.face;
        if (!face.visible) return const SizedBox.shrink();
        final def = face.def;
        final colour =
            def?.colorFor(shiny: face.shiny) ??
            (face.eggReady ? DaemonInk.yellow : DaemonInk.dim);
        final eggs = host.zoo.zoo.eggs.length;
        final chip = Semantics(
          key: const ValueKey('daemon-chip'),
          button: true,
          label: face.semantics,
          hint: 'Opens your daemon',
          excludeSemantics: true,
          child: TouchTarget(
            child: GestureDetector(
              behavior: HitTestBehavior.opaque,
              onTap: () {
                HapticFeedback.selectionClick();
                face.boop();
                showDaemonSheet(context, host);
              },
              child: Stack(
                clipBehavior: Clip.none,
                children: [
                  Container(
                    height: height,
                    padding: const EdgeInsets.symmetric(horizontal: 3),
                    decoration: BoxDecoration(
                      color: DaemonInk.ground,
                      borderRadius: BorderRadius.circular(6),
                      border: Border.all(color: DaemonInk.line),
                    ),
                    // As wide as its ten cells (and a shiny one's mark),
                    // wherever it is put.
                    child: Align(
                      widthFactor: 1,
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          if (def != null && face.shiny)
                            Text(
                              '*',
                              key: const ValueKey('daemon-chip-shiny'),
                              maxLines: 1,
                              textScaler: TextScaler.noScaling,
                              style: DaemonInk.mono(
                                size: 12.5,
                                color: colour,
                                weight: FontWeight.w600,
                                height: 1,
                              ),
                            ),
                          Text(
                            face.cell,
                            maxLines: 1,
                            softWrap: false,
                            textScaler: TextScaler.noScaling,
                            style: DaemonInk.mono(
                              size: 12.5,
                              color: colour,
                              weight: FontWeight.w600,
                              height: 1,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                  if (def != null && eggs > 0)
                    Positioned(
                      right: -3,
                      top: -3,
                      child: Container(
                        key: const ValueKey('daemon-chip-eggs'),
                        width: 9,
                        height: 9,
                        decoration: BoxDecoration(
                          color: DaemonInk.yellow,
                          shape: BoxShape.circle,
                          border: Border.all(
                            color: DaemonInk.ground,
                            width: 1.5,
                          ),
                        ),
                      ),
                    ),
                ],
              ),
            ),
          ),
        );
        return margin == EdgeInsets.zero
            ? chip
            : Padding(padding: margin, child: chip);
      },
    );
  }
}
