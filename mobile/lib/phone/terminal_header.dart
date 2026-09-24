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
/// a screen reader and as the long-press tooltip — see [StatusDot]. While the
/// terminal is on its way back, the rule under the row sweeps as well — see
/// [TerminalHeaderRule].
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
            Expanded(child: _Identity(agent: agent)),
            ...trailing,
          ],
        ),
      ),
    );
  }
}

/// The engine mark with the session's state notched into its corner.
///
/// The header draws it beside the agent's name.
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
            child: StatusDot(
              summary: status,
              ring: ring,
              // ⚠️ **The accent as a mark, not as a fill.** `accent` is the
              // fill under white text, and as a 1.6pt ring on the dark ground
              // it all but vanished — the one sign on the row that the
              // terminal was on its way back went unseen. `accentOnSurface`
              // is the palette's accent for a mark on a surface.
              spinnerColor: AppPalette.accentOnSurface,
            ),
          ),
        ],
      ),
    );
  }
}

/// The hairline under the header, which carries a sweep while the terminal is
/// on its way back — attaching, resyncing, reconnecting.
///
/// ```
/// [mark◌]  agent-3                                       ⋯
///          autonomous-harness  ⑂ main
/// ──────────────━━━━━━━━────────────────────────────────  → left to right
/// ```
///
/// ⚠️ **The spinner on the mark cannot carry a wait on its own.** It is 10pt in
/// the corner of a 28pt mark, and a reconnect after the phone comes back from
/// the background runs for seconds: at that size it read as a status rather
/// than as progress, and the page looked stuck. The sweep crosses the whole
/// width, so the wait is seen wherever the eye is.
///
/// ⚠️ **Painted, not laid out.** The rule takes one pixel of layout whatever it
/// draws — [TerminalHeader.height] counts it as one — and the two-pixel glint
/// hangs half a pixel over each side of it. A taller rule would move everything
/// under the header each time a reconnect began and ended.
///
/// Still, not blank, when it cannot animate: with animations turned off the
/// whole rule is drawn in the glint's colour, so the state still shows. A page
/// parked beside the one on screen needs nothing — its ticker is muted, and the
/// glint picks up where it stopped when the page comes back.
class TerminalHeaderRule extends StatefulWidget {
  const TerminalHeaderRule({super.key, required this.busy});

  /// The terminal is on its way back: attaching, resyncing or reconnecting.
  final bool busy;

  @override
  State<TerminalHeaderRule> createState() => _TerminalHeaderRuleState();
}

class _TerminalHeaderRuleState extends State<TerminalHeaderRule>
    with SingleTickerProviderStateMixin {
  /// One pass, left edge to right edge: quick enough to read as work going on,
  /// slow enough not to flicker at the edge of the eye.
  static const _period = Duration(milliseconds: 1150);

  late final AnimationController _sweep = AnimationController(
    vsync: this,
    duration: _period,
  );

  /// Eased in and out on every pass, so the glint gathers at the left, crosses,
  /// and trails off at the right rather than scrolling past at one speed.
  late final Animation<double> _travel = CurvedAnimation(
    parent: _sweep,
    curve: Curves.fastOutSlowIn,
  );

  /// False when the person has turned animations off.
  bool _canAnimate = true;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _canAnimate = !MediaQuery.disableAnimationsOf(context);
    _sync();
  }

  @override
  void didUpdateWidget(TerminalHeaderRule oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.busy != widget.busy) _sync();
  }

  /// Runs the sweep exactly while there is a wait to show and it may move.
  void _sync() {
    final run = widget.busy && _canAnimate;
    if (run == _sweep.isAnimating) return;
    if (run) {
      _sweep.repeat();
    } else {
      _sweep.stop();
    }
  }

  @override
  void dispose() {
    _sweep.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return Stack(
      clipBehavior: Clip.none,
      children: [
        Divider(height: 1, color: AppGlass.hair),
        if (widget.busy)
          Positioned(
            left: 0,
            right: 0,
            top: -0.5,
            height: 2,
            // ⚠️ A boundary of its own: the glint repaints every frame, and
            // without one each frame would repaint the header with it — the
            // row, the names, the mark — for a two-pixel line.
            child: RepaintBoundary(
              child: CustomPaint(
                painter: _GlintPainter(
                  travel: _travel,
                  color: AppPalette.accentOnSurface,
                  still: !_canAnimate,
                ),
              ),
            ),
          ),
      ],
    );
  }
}

/// Paints [TerminalHeaderRule]'s glint: a short band of [color] that fades out
/// at both ends, carried across the rule by [travel].
class _GlintPainter extends CustomPainter {
  _GlintPainter({
    required this.travel,
    required this.color,
    required this.still,
  }) : super(repaint: travel);

  /// 0 with the glint wholly off the left edge, 1 with it wholly off the right.
  final Animation<double> travel;

  final Color color;

  /// Animations are off: the whole rule in [color], not a glint frozen
  /// somewhere along it.
  final bool still;

  /// The glint's length, as a fraction of the rule.
  static const _length = 0.34;

  @override
  void paint(Canvas canvas, Size size) {
    final full = Offset.zero & size;
    if (still) {
      canvas.drawRect(full, Paint()..color = color.withValues(alpha: 0.5));
      return;
    }
    final length = size.width * _length;
    // Enters from past the left edge and leaves past the right, so each pass
    // arrives and goes rather than appearing at one edge and vanishing at the
    // other.
    final left = -length + (size.width + length) * travel.value;
    final glint = Rect.fromLTWH(left, 0, length, size.height);
    canvas.save();
    canvas.clipRect(full);
    canvas.drawRect(
      glint,
      Paint()
        ..shader = LinearGradient(
          colors: [
            color.withValues(alpha: 0),
            color,
            color.withValues(alpha: 0),
          ],
        ).createShader(glint),
    );
    canvas.restore();
  }

  @override
  bool shouldRepaint(_GlintPainter old) =>
      old.color != color ||
      old.still != still ||
      !identical(old.travel, travel);
}

/// The two lines: *agent*, then *folder ⑂ branch*.
///
/// On the second line each name takes only the width it needs, and only the
/// overflow is shared out — see [_PlaceLine]. The folder is the one kept whole
/// where the two cannot both fit.
///
/// ⚠️ **The desktop's pane header, word for word.** The name is
/// [Agent.displayName], the folder [AgentProject.label] — the repository, not a
/// worktree's made-up folder — and the branch [AgentProject.shownBranch], so a
/// harness reads the same in both.
class _Identity extends StatelessWidget {
  const _Identity({required this.agent});

  final Agent? agent;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final agent = this.agent;
    final project = agent?.project;
    final branch = project?.shownBranch;
    final hasPlace = project != null || branch != null;
    return Column(
      mainAxisAlignment: MainAxisAlignment.center,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          agent?.displayName ?? 'Harness',
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
            folder: project?.label,
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

/// Where an agent runs, as the `⋯` sheet shows it under the agent's name, each
/// part behind its icon: the machine on a line of its own, then the folder with
/// its parent — `~/…/autonomous-harness/mobile` — and the branch side by side,
/// the pair the header draws together too.
///
/// The header has room for the folder's own name alone; the sheet is where the
/// rest of the path is read. The pair wraps rather than cutting either short: a
/// path or branch too long to share the line moves the branch to one of its own.
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
          _line(_part(LucideIcons.laptopMinimal300, machineName)),
        if (project != null)
          _line(
            Wrap(
              spacing: 14,
              runSpacing: 2,
              children: [
                _part(LucideIcons.folder300, projectPathTrail(project.cwd)),
                if (branch != null) _part(LucideIcons.gitBranch300, branch),
              ],
            ),
          ),
      ],
    );
  }

  Widget _line(Widget child) =>
      Padding(padding: const EdgeInsets.only(top: 2), child: child);

  /// One part behind its icon, only as wide as its text — so the branch can sit
  /// beside the folder — and wrapping to a second line, then cut with `…`, only
  /// when it is longer than the line itself.
  Widget _part(IconData icon, String text) => Row(
    mainAxisSize: MainAxisSize.min,
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      // Nudged down to sit on the text's first line rather than its top.
      Padding(
        padding: const EdgeInsets.only(top: 2),
        child: Icon(icon, size: 13, color: AppPalette.textFaint),
      ),
      const SizedBox(width: 6),
      Flexible(
        child: Text(
          text,
          maxLines: 2,
          overflow: TextOverflow.ellipsis,
          style: TextStyle(color: AppPalette.textSecondary, fontSize: 13),
        ),
      ),
    ],
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
