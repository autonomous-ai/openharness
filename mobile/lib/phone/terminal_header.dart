import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/widgets/engine_identity.dart';

import 'phone_status.dart';
import 'status_pill.dart';

/// The terminal page's own header: whose terminal this is, in two lines, with
/// the page's controls at the right end.
///
/// ```
/// [mark●]  agent-3                                       ⋯
///          autonomous-harness  ⑂ main
/// ```
///
/// ⚠️ **The connection state is the dot on the engine mark, not a word.** It
/// rides the mark's bottom-right corner the way presence sits on an avatar in a
/// messenger: green while live, a spinner while attaching, the warning or error
/// colour when the stream is taken over or drops. The label is still there for
/// a screen reader and as the long-press tooltip — see [StatusDot].
///
/// ⚠️ **Search and New agent are not here.** They float over the terminal's
/// bottom-right corner with the mic — see `terminal_action_column.dart` — so
/// this row is identity plus `⋯`, and nothing competes with the names for width.
///
/// ⚠️ **It leaves on a scroll, and `⋯` leaves with it.** The page slides this
/// row away as the terminal is scrolled forward; nothing floats in its place.
/// Nothing here knows about that; the row is either laid out or it is not.
class TerminalHeader extends StatelessWidget {
  const TerminalHeader({
    super.key,
    required this.agent,
    required this.status,
    this.trailing = const [],
  });

  /// The agent this terminal belongs to. Null while it is still loading.
  final Agent? agent;

  /// The session's state, drawn as the dot on the engine mark.
  final PhoneSummary status;

  /// The page's controls, right of the names: `⋯`, and the reclaim button when
  /// the stream is read-only.
  final List<Widget> trailing;

  /// The row's height, not counting its insets.
  ///
  /// Two lines of type: 15pt name over 12.5pt folder, with the engine mark
  /// centred against the pair.
  static const double rowHeight = 40;

  static const double sideInset = 14;
  static const double topInset = 6;
  static const double bottomInset = 8;

  /// The whole header, insets and divider included — what floats over the
  /// terminal's top rows while it is shown.
  static const double height = topInset + rowHeight + bottomInset + 1;

  /// The engine mark's size. Big enough to carry the status dot on its corner
  /// without the dot hiding it.
  static const double markSize = 28;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final agent = this.agent;
    return Padding(
      padding: const EdgeInsets.fromLTRB(
        sideInset,
        topInset,
        sideInset,
        bottomInset,
      ),
      child: SizedBox(
        height: rowHeight,
        child: Row(
          children: [
            BadgedEngineMark(
              agent: agent,
              status: status,
              ring: AppPalette.windowBg,
            ),
            const SizedBox(width: 11),
            Expanded(
              child: _Identity(agent: agent),
            ),
            ...trailing,
          ],
        ),
      ),
    );
  }
}

/// The engine mark with the session's state notched into its corner.
///
/// The header draws it beside the agent's name, and the tabs popup on each of
/// its cards — an agent reads the same wherever it is offered.
class BadgedEngineMark extends StatelessWidget {
  const BadgedEngineMark({
    super.key,
    required this.agent,
    required this.status,
    required this.ring,
    this.size = TerminalHeader.markSize,
  });

  final Agent? agent;
  final PhoneSummary status;

  /// The colour BEHIND the mark, cut out around the dot so it reads as notched
  /// into the mark rather than stuck on it — see [StatusDot.ring].
  final Color ring;

  final double size;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return SizedBox.square(
      dimension: size,
      child: Stack(
        clipBehavior: Clip.none,
        children: [
          EngineMark(
            engine: agent?.engine,
            displayName: agent?.engineDisplayName,
            size: size,
          ),
          // Bottom-right, hanging a little past the mark — the corner a
          // messenger puts presence on an avatar.
          Positioned(
            right: -4,
            bottom: -4,
            child: StatusDot(summary: status, ring: ring),
          ),
        ],
      ),
    );
  }
}

/// The two lines: *agent*, then *folder ⑂ branch*.
///
/// On the second line each name takes only the width it needs, and only the
/// overflow is shared out — see [_PlaceLine]. The folder is the one kept whole
/// where the two cannot both fit — see [projectPathLabel].
class _Identity extends StatelessWidget {
  const _Identity({required this.agent});

  final Agent? agent;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final agent = this.agent;
    final project = agent?.project;
    final branch = project?.branchLabel;
    final hasPlace = project != null || branch != null;
    return Column(
      mainAxisAlignment: MainAxisAlignment.center,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          agent?.name ?? 'Harness',
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: TextStyle(
            color: AppPalette.textPrimary,
            fontSize: 15,
            fontWeight: FontWeight.w600,
            height: 1.2,
          ),
        ),
        if (hasPlace) ...[
          const SizedBox(height: 2),
          _PlaceLine(
            folder: project == null ? null : projectPathLabel(project.cwd),
            branch: branch,
            style: _placeStyle,
          ),
        ],
      ],
    );
  }

  TextStyle get _placeStyle => TextStyle(
    color: AppPalette.textSecondary,
    fontSize: 12.5,
    fontWeight: FontWeight.w500,
    height: 1.2,
  );
}

/// The second line: *folder ⑂ branch*, each name given the width it asks for.
///
/// ⚠️ **A `flex` here would ellipsis a name with the room to spare beside it.**
/// Two `Flexible`s split the line in their own fixed ratio whatever they hold,
/// so a short folder hands its slack back to the empty end of the row rather
/// than to the branch, and `worktree-command-box` is cut next to a gap. This
/// lays both out at their natural width and shortens them only when the two
/// together overrun the line.
///
/// ⚠️ **The folder is the one kept whole.** It is what tells two of an owner's
/// agents apart; a branch is read to its end far less often, so the overflow
/// comes off the branch first and the folder only gives way once the branch is
/// down to its own floor.
class _PlaceLine extends StatelessWidget {
  const _PlaceLine({
    required this.folder,
    required this.branch,
    required this.style,
  });

  /// Null leaves the folder out, and the branch then has the whole line.
  final String? folder;

  /// Null leaves the branch and its mark out.
  final String? branch;

  final TextStyle style;

  /// What a shortened branch is never cut below, so it keeps enough characters
  /// to be told from its neighbours rather than becoming a bare `…`.
  static const double _branchFloor = 54;

  /// The gap left of the branch mark, and the one between mark and name.
  static const double _gapBeforeMark = 8;
  static const double _gapAfterMark = 3;
  static const double _markSize = 12;

  @override
  Widget build(BuildContext context) {
    final folder = this.folder;
    final branch = this.branch;
    if (branch == null) {
      if (folder == null) return const SizedBox.shrink();
      return Text(
        folder,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: style,
      );
    }

    final mark = Icon(
      LucideIcons.gitBranch300,
      size: _markSize,
      color: AppPalette.textFaint,
    );
    final branchText = Text(
      branch,
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
      style: style,
    );

    if (folder == null) {
      return Row(
        children: [
          mark,
          const SizedBox(width: _gapAfterMark),
          Flexible(child: branchText),
        ],
      );
    }

    return LayoutBuilder(
      builder: (context, constraints) {
        final line = constraints.maxWidth;
        // The mark and its two gaps are spent before either name gets a say.
        final free = math.max(
          0.0,
          line - _markSize - _gapBeforeMark - _gapAfterMark,
        );
        final folderWanted = _measure(context, folder, line);
        final branchWanted = _measure(context, branch, line);

        final double folderWidth;
        if (folderWanted + branchWanted <= free) {
          // Both fit whole. The folder is laid out at its own width so the
          // slack falls at the end of the line, not between the two names.
          folderWidth = folderWanted;
        } else {
          // The branch gives way first: it is left whatever the folder does
          // not want, but never less than its floor — and never more than it
          // wants, so a short branch beside a long folder still hands its
          // slack back to the folder.
          final forBranch = math.min(
            branchWanted,
            math.max(_branchFloor, free - folderWanted),
          );
          folderWidth = math.max(0.0, free - forBranch);
        }

        return Row(
          children: [
            SizedBox(
              width: math.min(folderWidth, free),
              child: Text(
                folder,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: style,
              ),
            ),
            const SizedBox(width: _gapBeforeMark),
            mark,
            const SizedBox(width: _gapAfterMark),
            Flexible(child: branchText),
          ],
        );
      },
    );
  }

  /// How wide [text] wants to be on one line, capped at [limit] so a very long
  /// name does not measure out to something the arithmetic cannot use.
  double _measure(BuildContext context, String text, double limit) {
    final painter = TextPainter(
      text: TextSpan(text: text, style: style),
      maxLines: 1,
      textDirection: Directionality.of(context),
      textScaler: MediaQuery.textScalerOf(context),
    )..layout();
    final width = painter.width;
    painter.dispose();
    return math.min(width, limit);
  }
}

/// Where an agent runs, as the `⋯` sheet shows it under the agent's name, one
/// line each behind its icon: the machine, the folder with its parent —
/// `~/…/autonomous-harness/mobile` — and the branch.
///
/// The header has room for the folder's own name alone; the sheet is where the
/// rest of the path is read.
class AgentPlaceLines extends StatelessWidget {
  const AgentPlaceLines({
    super.key,
    required this.machineName,
    required this.project,
  });

  /// Empty leaves the line out.
  final String machineName;

  final AgentProject? project;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final project = this.project;
    final branch = project?.branchLabel;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (machineName.isNotEmpty)
          _line(LucideIcons.laptopMinimal300, machineName),
        if (project != null)
          _line(LucideIcons.folder300, projectPathTrail(project.cwd)),
        if (branch != null) _line(LucideIcons.gitBranch300, branch),
      ],
    );
  }

  Widget _line(IconData icon, String text) => Padding(
    padding: const EdgeInsets.only(top: 2),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        // Nudged down to sit on the text's first line rather than its top.
        Padding(
          padding: const EdgeInsets.only(top: 2),
          child: Icon(icon, size: 13, color: AppPalette.textFaint),
        ),
        const SizedBox(width: 6),
        Expanded(
          child: Text(
            text,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(color: AppPalette.textSecondary, fontSize: 13),
          ),
        ),
      ],
    ),
  );
}

/// A folder with its parent, everything above them folded into `…` —
/// `~/…/autonomous-harness/mobile`.
///
/// Home is written `~` the way a shell prompt writes it; a path short enough to
/// need no fold is kept whole (`~/notes`, `/srv/app`).
String projectPathTrail(String cwd) {
  const kept = 2;
  final path = cwd.replaceAll('\\', '/');
  final parts = path.split('/').where((part) => part.isNotEmpty).toList();
  if (parts.isEmpty) return path.isEmpty ? '~' : '/';

  // `/Users/<name>/…` on a Mac, `/home/<name>/…` on Linux, `/root` for root.
  var homeDepth = 0;
  if (path.startsWith('/') && parts.length >= 2) {
    if (parts[0] == 'Users' || parts[0] == 'home') homeDepth = 2;
  }
  if (path.startsWith('/') && parts[0] == 'root') homeDepth = 1;
  if (path.startsWith('~')) homeDepth = 1;

  final String lead;
  final List<String> below;
  if (homeDepth > 0) {
    lead = '~';
    below = parts.sublist(math.min(homeDepth, parts.length));
  } else {
    // A Windows drive keeps its letter, anything else its root.
    final drive = RegExp(r'^[A-Za-z]:$').hasMatch(parts.first);
    lead = drive ? parts.first : '';
    below = drive ? parts.sublist(1) : parts;
  }
  if (below.isEmpty) return lead.isEmpty ? '/' : lead;
  final tail = below.length <= kept
      ? below
      : ['…', ...below.sublist(below.length - kept)];
  return '$lead/${tail.join('/')}';
}

/// A folder as the header names it: its own name and nothing above it —
/// `autonomous-harness`.
///
/// Home itself is written `~` the way a shell prompt writes it, and the root
/// `/`: those have no name of their own to show.
///
/// ⚠️ The parents are the part every agent somebody owns has in common — the
/// folder's own name is what tells two of them apart, so it is all that is kept.
String projectPathLabel(String cwd) {
  final path = cwd.replaceAll('\\', '/');
  final parts = path.split('/').where((part) => part.isNotEmpty).toList();
  if (parts.isEmpty) return path.isEmpty ? '~' : '/';

  // Home: `/Users/<name>` on a Mac, `/home/<name>` on Linux, `/root`, `~`.
  final isHome =
      (path.startsWith('/') &&
          parts.length == 2 &&
          (parts[0] == 'Users' || parts[0] == 'home')) ||
      (path.startsWith('/') && parts.length == 1 && parts[0] == 'root') ||
      (path.startsWith('~') && parts.length == 1);
  if (isHome) return '~';
  return parts.last;
}
