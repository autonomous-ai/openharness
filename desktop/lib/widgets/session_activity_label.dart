import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shared/theme/appearance_prefs_store.dart';
import '../state/harness_activity.dart';
import '../state/session_activity.dart';
import '../terminal/terminal_theme.dart';
import '../terminal/terminal_theme_store.dart';
import 'harness_activity_mark.dart';

/// The same activity mark as tabs and panes, alongside conversation recency.
class SessionActivityLabel extends StatelessWidget {
  const SessionActivityLabel({
    super.key,
    required this.activity,
    required this.age,
    required this.style,
    this.markColor,
    this.reason,
  });

  final SessionActivity activity;
  final String? age;
  final TextStyle style;
  final Color? markColor;
  final String? reason;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final status = activity.status;
    final showMark =
        status != null &&
        status != HarnessActivity.idle &&
        status != HarnessActivity.unknown;
    final textScaler = MediaQuery.textScalerOf(context);
    if (age == null && !showMark) return const SizedBox.shrink();
    final description = [
      if (reason != null && reason != status?.label) reason!,
      sessionActivityTooltip(activity),
    ].where((part) => part.isNotEmpty).join(' · ');
    return Tooltip(
      message: description,
      excludeFromSemantics: true,
      child: Semantics(
        label: description,
        excludeSemantics: true,
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            // Keep both columns fixed as ages change (now, 1m, 12m), including
            // rows without a confirmed status. Only the timestamp is shown
            // when the status is unknown; its tooltip retains that detail.
            SizedBox(
              width: textScaler.scale(16),
              child: showMark
                  ? Center(
                      heightFactor: 1,
                      child: ListenableBuilder(
                        listenable: Listenable.merge([
                          terminalThemeStore,
                          appearancePrefsStore,
                        ]),
                        builder: (context, _) => ActivityMark(
                          activity: status,
                          color:
                              markColor ??
                              activityColor(
                                status,
                                terminalThemeFor(
                                  grid.AppTheme.palette.value,
                                  terminalThemeStore.value,
                                ),
                                color: appearancePrefsStore.value.prompt.color,
                              ),
                          tooltip: false,
                        ),
                      ),
                    )
                  : null,
            ),
            const SizedBox(width: 6),
            SizedBox(
              width: textScaler.scale(40),
              child: age == null
                  ? null
                  : Text(
                      age!,
                      maxLines: 1,
                      textAlign: TextAlign.right,
                      style: style,
                    ),
            ),
          ],
        ),
      ),
    );
  }
}
