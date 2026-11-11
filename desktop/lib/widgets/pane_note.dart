/// The strip under a pane's header while something stops its agent: the model not answering
/// ([PaneModelNote]) or a named state the daemon says only the person can fix (`Agent.namedState`).
library;

import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../theme/app_theme.dart';

/// One line: tall enough for an action button, and the same height with or without one, so a note
/// that loses its action does not resize the terminal again.
const double kPaneNoteHeight = 30;

/// One line under the header, in flow rather than over the output, like the composer: a note can
/// stand for hours, and a band that long over the top rows would hide what the agent last said.
class PaneNote extends StatelessWidget {
  const PaneNote({
    super.key,
    required this.icon,
    required this.text,
    String? tooltip,
    this.action,
  }) : tooltip = tooltip ?? text;

  final IconData icon;
  final String text, tooltip;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return Semantics(
      container: true,
      liveRegion: true,
      child: Container(
        height: kPaneNoteHeight,
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
            Icon(icon, size: 14, color: AppColors.warning),
            const SizedBox(width: 8),
            Flexible(
              child: Tooltip(
                message: tooltip,
                child: Text(
                  text,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: grid.AppType.body(color: AppColors.textSoft),
                ),
              ),
            ),
            ?action,
          ],
        ),
      ),
    );
  }
}
