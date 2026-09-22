/// The model sheet's parts: a captioned heading, a choosable row, and a
/// sentence where a section has nothing to offer.
///
/// Kept beside the sheet rather than folded into [PhoneSheetAction], because
/// these rows carry what that one cannot: a tick for the one in force, a second
/// line under the name, and a leading engine mark instead of an icon. A row
/// there is an action; a row here is a destination, and the tick is how it says
/// which one you are already at.
library;

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/widgets/touch_target.dart';
import 'package:harness_mobile/widgets/engine_identity.dart';

/// The side inset every row and heading in the sheet shares — the same 20 the
/// rows of [showPhoneSheet] are laid out on, so the two read as one surface
/// when the model sheet opens over it.
const double kModelRowInset = 20;

/// A section's heading, with the grid's own name under it when the section is
/// somebody else's fleet.
class ModelSectionHeading extends StatelessWidget {
  const ModelSectionHeading({
    super.key,
    required this.caption,
    this.detail,
    this.first = false,
  });

  final String caption;

  /// The quieter line under [caption] — a shared grid's name. Null leaves it
  /// out.
  final String? detail;

  /// The first heading in the sheet sits tighter to the title above it; every
  /// later one opens a gap, which is what parts one section from the last.
  final bool first;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return Padding(
      padding: EdgeInsets.fromLTRB(
        kModelRowInset,
        first ? 6 : 18,
        kModelRowInset,
        6,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            caption.toUpperCase(),
            style: TextStyle(
              color: AppPalette.textFaint,
              fontSize: 11.5,
              fontWeight: FontWeight.w600,
              letterSpacing: 0.6,
            ),
          ),
          if (detail != null)
            Padding(
              padding: const EdgeInsets.only(top: 2),
              child: Text(
                detail!,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  color: AppPalette.textSecondary,
                  fontSize: 12.5,
                ),
              ),
            ),
        ],
      ),
    );
  }
}

/// One place the agent can run: a model on a grid, or the engine's own login.
///
/// ⚠️ **The tick takes the leading slot, and the row wears the accent wash.**
/// Both, because that is this app's own way of saying "this is the one" — see
/// [AppMenuItem], where the tick replaces the row's glyph rather than sitting
/// beside it so the column keeps one left edge. A fourth column for the tick
/// would leave every unselected row with a gap the eye must cross to reach the
/// name; the wash alone would be easy to miss at arm's length.
class ModelRow extends StatelessWidget {
  const ModelRow({
    super.key,
    required this.title,
    required this.selected,
    required this.onTap,
    this.engine,
    this.status,
    this.detail,
    this.warning,
  });

  final String title;

  /// The one the agent is on right now.
  final bool selected;

  final VoidCallback onTap;

  /// Drawn as an engine mark where there is no tick — the Subscription row's
  /// own vendor. Null leaves that space empty, which is what a grid model gets.
  final String? engine;

  /// A quiet word at the end of the row: the machine serving the model, or what
  /// is left of a subscription.
  final String? status;

  /// A quiet second line under [title] — which account the subscription row is
  /// reading.
  final String? detail;

  /// A second line that is a WARNING rather than a detail: the web-search
  /// sentence on the model the agent is actually running.
  ///
  /// Its own field rather than a colour passed in beside [detail], because the
  /// two are different kinds of line and only one of them should ever be able
  /// to wear the warning colour.
  final String? warning;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final status = this.status;
    return InkWell(
      onTap: onTap,
      // `Ink` rather than a coloured `Container`: a fill painted inside the
      // InkWell would cover the ink the tap splashes onto the Material.
      child: Ink(
        color: selected ? AppSurface.accentWash : null,
        child: Container(
          // A row is read as a line of type, but it is pressed with a thumb —
          // so the type sets the padding and [minTouchTarget] sets the floor
          // under it, rather than a padding chosen to reach 44 that would leave
          // the one-line rows looser than every other list on the phone.
          constraints: const BoxConstraints(minHeight: minTouchTarget),
          alignment: Alignment.centerLeft,
          padding: const EdgeInsets.symmetric(
            horizontal: kModelRowInset,
            vertical: 10,
          ),
          child: Row(
            children: [
              SizedBox.square(dimension: 22, child: Center(child: _leading())),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        color: AppPalette.textPrimary,
                        fontSize: 15.5,
                        fontWeight: selected
                            ? FontWeight.w600
                            : FontWeight.w500,
                      ),
                    ),
                    if (detail != null) _second(detail!, AppPalette.textFaint),
                    if (warning != null) _second(warning!, AppPalette.warn),
                  ],
                ),
              ),
              if (status != null && status.isNotEmpty) ...[
                const SizedBox(width: 12),
                ConstrainedBox(
                  // A long node name gives way to the model's own name, which
                  // is what the row is for.
                  constraints: const BoxConstraints(maxWidth: 132),
                  child: Text(
                    status,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    textAlign: TextAlign.end,
                    style: TextStyle(color: AppPalette.textFaint, fontSize: 13),
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }

  /// One of the lines under [title]: a detail, or a warning.
  Widget _second(String text, Color color) => Padding(
    padding: const EdgeInsets.only(top: 2),
    child: Text(
      text,
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
      style: TextStyle(color: color, fontSize: 12.5),
    ),
  );

  Widget _leading() {
    if (selected) {
      return Icon(
        LucideIcons.check300,
        size: 18,
        color: AppPalette.accentOnSurface,
      );
    }
    final engine = this.engine;
    if (engine == null) return const SizedBox.shrink();
    return EngineMark(engine: engine, size: 18);
  }
}

/// What a section says instead of rows: it could not be asked, the machine has
/// no `grid`, or the account is serving nothing yet.
class ModelSectionNote extends StatelessWidget {
  const ModelSectionNote(this.sentence, {super.key});

  final String sentence;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(kModelRowInset, 2, kModelRowInset, 10),
      child: Text(
        sentence,
        style: TextStyle(color: AppPalette.textSecondary, fontSize: 13.5),
      ),
    );
  }
}

/// The sheet's own title: what is being chosen, and for whom.
class ModelSheetTitle extends StatelessWidget {
  const ModelSheetTitle({super.key, required this.agentName});

  /// Null while the agent is still loading, or once it is gone.
  final String? agentName;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(kModelRowInset, 0, kModelRowInset, 4),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'Model',
            style: TextStyle(
              color: AppPalette.textPrimary,
              fontSize: 15,
              fontWeight: FontWeight.w600,
            ),
          ),
          Text(
            agentName == null
                ? 'Where this agent runs'
                : 'Where $agentName runs',
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(color: AppPalette.textSecondary, fontSize: 13),
          ),
        ],
      ),
    );
  }
}

/// What stands where the grids will be while the machine is being asked.
///
/// A heading over the wait rather than a bare spinner: the heading is where the
/// rows are about to appear, so nothing moves when they do.
class ModelSheetWaiting extends StatelessWidget {
  const ModelSheetWaiting({super.key});

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const ModelSectionHeading(caption: 'Local models on your machines'),
        Padding(
          padding: const EdgeInsets.fromLTRB(kModelRowInset, 4, 0, 12),
          child: Row(
            children: [
              const SizedBox.square(
                dimension: 14,
                child: CircularProgressIndicator(strokeWidth: 1.6),
              ),
              const SizedBox(width: 12),
              Text(
                'Asking this machine…',
                style: TextStyle(
                  color: AppPalette.textSecondary,
                  fontSize: 13.5,
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}
