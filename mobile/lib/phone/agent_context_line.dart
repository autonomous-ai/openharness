import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';

/// Where an agent IS: the folder it was started in, the branch that folder is on, and the machine
/// running it — `autonomous-harness · ⑂ main · MacBookPro2021.local`.
///
/// The same three facts, in the same order, as the desktop's pane header
/// (`widgets/terminal_pane_header.dart`), so an agent recognised on one screen is recognised on the
/// other. A name alone stops identifying anything the moment somebody has two `main` agents, which
/// on a phone — where the Agents tab mixes every machine into one list — happens immediately.
///
/// ⚠️ **Two flexible halves, not one line of text.** A phone row leaves this about 240pt, and the
/// three together want more than that: `autonomous-harness · ⑂ feat/mobile-ios-android` alone fills
/// it. Written as a single ellipsised line, the machine — the last of the three, and the reason the
/// line exists on a list that mixes machines — is the part that disappears entirely. Split in two,
/// each half truncates within its own share instead, so the machine is always at least begun.
///
/// Which leaves the branch as the one that gives way, and deliberately: it shares the left half
/// with the folder and is cut first when that half runs out. It is the least use in *finding* an
/// agent, and the terminal page names it in full once one is open.
class AgentContextLine extends StatelessWidget {
  const AgentContextLine({
    super.key,
    required this.project,
    required this.machineName,
  });

  /// Null on a daemon too old to report it, and until the first agent snapshot binds one. The line
  /// then names the machine alone rather than holding a gap open where the folder would be.
  final AgentProject? project;

  final String machineName;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final branch = project?.shownBranch;
    final place = <InlineSpan>[
      if (project != null) TextSpan(text: project!.label),
      if (project != null && branch != null) _separator,
      if (branch != null) ...[_branchMark, TextSpan(text: branch)],
    ];
    return Row(
      children: [
        if (place.isNotEmpty) Flexible(child: _line(place)),
        Flexible(
          child: _line([
            if (place.isNotEmpty) _separator,
            TextSpan(text: machineName),
          ]),
        ),
      ],
    );
  }

  Widget _line(List<InlineSpan> spans) => Text.rich(
    TextSpan(children: spans),
    maxLines: 1,
    overflow: TextOverflow.ellipsis,
    style: TextStyle(
      color: AppPalette.textSecondary,
      fontSize: 12.5,
      fontWeight: FontWeight.w500,
    ),
  );

  static TextSpan get _separator => TextSpan(
    text: '  ·  ',
    style: TextStyle(color: AppPalette.textFaint),
  );

  /// Drawn rather than written, because `main` alone reads as a folder — the same glyph the
  /// desktop's header puts in front of a branch.
  static WidgetSpan get _branchMark => WidgetSpan(
    alignment: PlaceholderAlignment.middle,
    child: Padding(
      padding: const EdgeInsets.only(right: 3.5),
      child: Icon(
        LucideIcons.gitBranch300,
        size: 12,
        color: AppPalette.textFaint,
      ),
    ),
  );
}
