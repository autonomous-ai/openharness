/// What a pane says about the model its agent is on, when that model is resting or not answering
/// (grid-reads-without-waking, issue 03): the header chip between a message and its first answer,
/// and the note under the header while the daemon notes the agent's model will not answer.
///
/// Presentation only. When the chip shows is [ModelStartWatch]'s to say; what the note says is the
/// daemon's (`grid.note`), in the words of `resting_model_words.dart`.
library;

import 'package:flutter/material.dart';

import '../core/models.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../state/model_start_watch.dart';
import '../theme/app_theme.dart';
import 'resting_model_words.dart';

/// The chip's mark, the gap after it, and its padding — one set of numbers for the chip and for
/// the room [paneStartingChipWidth] asks the header to leave it.
const double _kChipMark = 14;
const double _kChipGap = 6;
const EdgeInsets _kChipPadding = EdgeInsets.symmetric(horizontal: 6, vertical: 4);

/// The note strip's one line: tall enough for its "Pick another" button, and the same height with
/// or without one, so a note that loses its action does not resize the terminal again.
const double _kNoteHeight = 30;


/// The chip's words for [phase].
String startingChipLabel(ModelStartPhase phase) => switch (phase) {
  ModelStartPhase.starting => kStartingUp,
  ModelStartPhase.stillStarting => kStillStarting,
};

TextStyle _chipStyle() => grid.AppType.monoLabel(
  fontWeight: FontWeight.w400,
  color: AppColors.textSoft,
);

/// The pane header's "Starting up…" chip. Not a button: there is nothing to do but wait, and the
/// tooltip says why the wait happens at all. [narrow] draws only the mark, the way a narrow header
/// draws its status chip, with the words on hover.
class PaneStartingChip extends StatelessWidget {
  const PaneStartingChip({super.key, required this.phase, this.narrow = false});

  final ModelStartPhase phase;
  final bool narrow;

  @override
  Widget build(BuildContext context) {
    final label = startingChipLabel(phase);
    final mark = Icon(
      Icons.hourglass_top,
      size: _kChipMark,
      color: AppColors.textSoft,
    );
    return Semantics(
      liveRegion: true,
      label: label,
      child: Tooltip(
        message: narrow ? '$label\n$kRestingTooltip' : kRestingTooltip,
        child: Padding(
          padding: _kChipPadding,
          child: narrow
              ? mark
              : Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    mark,
                    const SizedBox(width: _kChipGap),
                    Flexible(
                      child: Text(
                        label,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: _chipStyle(),
                      ),
                    ),
                  ],
                ),
        ),
      ),
    );
  }
}

/// The room [PaneStartingChip] asks for in a header, so the header can leave it that much beside
/// the agent's name.
double paneStartingChipWidth(ModelStartPhase phase, TextScaler scaler) {
  final painter = TextPainter(
    text: TextSpan(text: startingChipLabel(phase), style: _chipStyle()),
    textDirection: TextDirection.ltr,
    textScaler: scaler,
    maxLines: 1,
  )..layout();
  final width = painter.width;
  painter.dispose();
  return _kChipMark + _kChipGap + width + _kChipPadding.horizontal;
}

/// The strip under a pane's header while its agent's model will not answer — one line, in flow, so
/// it covers none of the terminal. [onPickAnother] opens the pane's model picker; it is offered
/// only for a model that is not being served (an offline computer comes back by itself) and only
/// where the pane has a picker to open.
class PaneModelNote extends StatelessWidget {
  const PaneModelNote({super.key, required this.note, this.onPickAnother});

  final GridNote note;
  final VoidCallback? onPickAnother;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final pick = switch (note) {
      GridNoteNotServed() => onPickAnother,
      GridNoteOffline() => null,
    };
    final sentence = noteSentence(note);
    return Semantics(
      container: true,
      liveRegion: true,
      child: Container(
        height: _kNoteHeight,
        padding: const EdgeInsets.only(left: 14, right: 8),
        decoration: BoxDecoration(
          color: Color.alphaBlend(
            AppColors.warning.withValues(alpha: 0.10),
            grid.AppPalette.panelBg,
          ),
          border: Border(bottom: BorderSide(color: AppColors.border)),
        ),
        child: Row(
          children: [
            Icon(
              switch (note) {
                GridNoteOffline() => Icons.cloud_off,
                GridNoteNotServed() => Icons.info_outline,
              },
              size: _kChipMark,
              color: AppColors.warning,
            ),
            const SizedBox(width: 8),
            Flexible(
              child: Tooltip(
                message: pick == null ? sentence : '$sentence — $kPickAnother',
                child: Text(
                  pick == null ? sentence : '$sentence —',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: grid.AppType.body(color: AppColors.textSoft),
                ),
              ),
            ),
            if (pick != null)
              TextButton(
                onPressed: pick,
                style: TextButton.styleFrom(
                  minimumSize: Size.zero,
                  tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                  padding: _kChipPadding,
                  foregroundColor: AppColors.accent,
                  textStyle: grid.AppType.monoLabel(),
                ),
                child: const Text(kPickAnother),
              ),
          ],
        ),
      ),
    );
  }
}
