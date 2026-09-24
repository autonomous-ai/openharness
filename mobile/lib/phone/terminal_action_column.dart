import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart' show OverflowBoxFit;
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/notify/agent_unread.dart';
import 'package:harness_mobile/notify/unread_marks.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/terminal/terminal_session.dart';

import 'floating_glass.dart';
import 'terminal_header.dart';
import 'voice_input_controller.dart';
import 'voice_mic_button.dart';
import 'voice_mic_face.dart';
import 'voice_mic_fab.dart';
import 'voice_status_pill.dart';

/// The terminal's floating controls, stacked in its bottom-right corner:
/// the mic, then Search.
///
/// ```
///   ( ×  ●  ▂▃▅▇▅▃▂  0:07  (↑) )
///                           (🔍)
/// ```
///
/// ⚠️ **The mic is on top, and that is what "moved up" means.** It used to sit
/// alone in the corner, over the agent's own status line; Search now takes the
/// corner under it, and the mic rides above. The two share one column so they
/// read as one set of controls rather than two strays.
///
/// ⚠️ **The mic and what it is doing are one capsule.** The status body is
/// stacked UNDER the mic and reaches out to its left, with the mic's circle
/// closing its right end — see `voice_status_pill.dart`. The mic never moves:
/// the body grows away from it, and the row keeps the mic's height however
/// many lines a notice wraps to.
///
/// ⚠️ **The gaps are set by the mic's hit area, not by the look.** The mic's
/// target spills [VoiceMicButton.touchOverhang] past its slot on every side and
/// is generous on purpose — a button under it that sat any closer would lose
/// the top of its own target to the mic, and a tap aimed at Search would start
/// a recording.
class TerminalActionColumn extends StatefulWidget {
  const TerminalActionColumn({
    super.key,
    required this.voice,
    required this.session,
    required this.onSearch,
    this.unread,
    this.searchOnly = false,
  });

  final VoiceInputController voice;

  /// Agents that finished while you were on this one. Search is where they are
  /// reached from, so it wears their count — the dial's bell pill. Null draws
  /// the plain button.
  final AgentUnread? unread;

  /// Null while the terminal is still attaching: the mic is drawn dimmed and
  /// dead, since there is nothing to talk to yet.
  final TerminalSession? session;

  final VoidCallback onSearch;

  /// Search alone, with no mic over it — what is left while the keyboard is up.
  ///
  /// ⚠️ **The mic does not merely hide here, it has nothing to do.** Typing is
  /// the other way of saying what the mic says, so with a keyboard on screen
  /// the two are the same errand and one of them is already under the thumb.
  /// Search is not: what it reaches — another harness, another machine — has no
  /// equivalent on the key bar, and being unable to reach it without first
  /// putting the keyboard away was the whole of the complaint.
  final bool searchOnly;

  /// The column's width: the mic's slot, which the smaller buttons centre under.
  static const double width = VoiceMicButton.extent;

  /// How far the column sits from the terminal's right and bottom edges.
  static const double inset = VoiceMicFab.inset;

  /// How far the column sits above the terminal's bottom edge — higher than
  /// [inset], so Search clears the agent's own status line under it.
  static const double bottomInset = 172;

  /// How far Search sits from the terminal's TOP edge while the keyboard is up
  /// — see [searchOnly].
  ///
  /// ⚠️ **Below the header's own height, not at the top of the box.** The
  /// header floats over these same rows and slides away on a scroll; measured
  /// from the box, Search sat under it whenever it was shown. Below it, the two
  /// never meet — and the rows Search now covers are the OLDEST on screen,
  /// which is the opposite end of the pane from the prompt being typed into.
  /// That is the whole reason it moves rather than staying where it was.
  static const double topInset = TerminalHeader.height + 8;

  /// The DRAWN gap between one circle and the next, the same all the way down.
  ///
  /// ⚠️ No smaller than the mic's overhang plus a button's, less the slack
  /// between the mic's slot and its drawn face — any closer and the mic's
  /// target would swallow the top of Search's.
  static const double _gap = 22;

  /// The mic's slot is larger than its drawn circle, so the gap under the slot
  /// is [_gap] less that slack.
  static const double _underMic =
      _gap - (VoiceMicButton.extent - VoiceMicCore.diameter) / 2;

  /// How far the capsule's right end sits in from the mic's slot: the slack
  /// between the slot and the circle, so the circle closes the capsule exactly.
  static const double _capsuleInset =
      (VoiceMicButton.extent - VoiceMicCore.diameter) / 2;

  /// The capsule's widest, however wide the phone: a notice is easier to read
  /// in two lines of a sensible length than in one line across a tablet.
  static const double _capsuleMaxWidth = 360;

  /// What the capsule leaves clear at the terminal's left edge.
  static const double _capsuleLeftMargin = 16;

  @override
  State<TerminalActionColumn> createState() => _TerminalActionColumnState();
}

class _TerminalActionColumnState extends State<TerminalActionColumn> {
  /// Whether a hold has been dragged off the mic — [VoiceMicMode.holdToTalk]
  /// only. The mic reports it; the capsule body is what says so, where the
  /// thumb is not covering it.
  final ValueNotifier<bool> _slipped = ValueNotifier(false);

  @override
  void dispose() {
    _slipped.dispose();
    super.dispose();
  }

  /// ⚠️ Guarded by [mounted]: the mic reports its last slip from a microtask
  /// scheduled in its own `dispose`, which can land after this column is gone
  /// as well.
  void _onSlipChanged(bool value) {
    if (mounted) _slipped.value = value;
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    // One backdrop read for the buttons' blurs — see [FloatingGlass].
    return BackdropGroup(child: _column(context, widget.session));
  }

  Widget _column(BuildContext context, TerminalSession? session) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.end,
      children: [
        if (widget.searchOnly)
          const SizedBox.shrink()
        else if (session != null)
          _capsule(context, session)
        else
          // Still attaching: the mic in its place, dimmed and dead.
          const VoiceMicButton(face: VoiceMicFace.talk, onPressed: null),
        if (!widget.searchOnly)
          const SizedBox(height: TerminalActionColumn._underMic),
        _centred(
          _withUnread(
            TerminalRoundAction(
              key: const ValueKey('terminal-search'),
              icon: LucideIcons.search300,
              label: 'Search harnesses and machines',
              onTap: widget.onSearch,
            ),
          ),
        ),
      ],
    );
  }

  /// The mic, with the capsule body under it reaching out to the left.
  ///
  /// ⚠️ **Held at the mic's height.** A notice that wraps makes the body
  /// taller than the mic's slot, and a row that grew with it would lift the mic
  /// — the one control the thumb is on — every time a sentence ran long. The
  /// body overflows the row evenly above and below instead.
  Widget _capsule(BuildContext context, TerminalSession session) {
    final maxWidth =
        (MediaQuery.sizeOf(context).width -
                TerminalActionColumn.inset -
                TerminalActionColumn._capsuleInset -
                TerminalActionColumn._capsuleLeftMargin)
            .clamp(
              VoiceMicCore.diameter,
              TerminalActionColumn._capsuleMaxWidth,
            );
    return SizedBox(
      height: VoiceMicButton.extent,
      child: Stack(
        alignment: Alignment.centerRight,
        clipBehavior: Clip.none,
        children: [
          Padding(
            padding: const EdgeInsets.only(
              right: TerminalActionColumn._capsuleInset,
            ),
            child: OverflowBox(
              fit: OverflowBoxFit.deferToChild,
              maxHeight: double.infinity,
              alignment: Alignment.centerRight,
              child: ConstrainedBox(
                constraints: BoxConstraints(maxWidth: maxWidth),
                child: VoiceStatusPill(
                  voice: widget.voice,
                  slipped: _slipped,
                  micClearance: VoiceMicCore.diameter,
                ),
              ),
            ),
          ),
          // Last, so it paints over the body's end and takes the taps there.
          VoiceMicFab(
            voice: widget.voice,
            session: session,
            onSlipChanged: _onSlipChanged,
          ),
        ],
      ),
    );
  }

  Widget _withUnread(Widget button) {
    final unread = widget.unread;
    if (unread == null) return button;
    return UnreadCountBadge(unread: unread, child: button);
  }

  Widget _centred(Widget child) => SizedBox(
    width: TerminalActionColumn.width,
    child: Center(child: child),
  );
}

/// A round floating button in the mic's style, one size down.
///
/// ⚠️ Smaller than the mic, and that is the right way round: the mic is the
/// page's one action, and these are tapped once and rarely.
class TerminalRoundAction extends StatelessWidget {
  const TerminalRoundAction({
    super.key,
    required this.icon,
    required this.label,
    required this.onTap,
  });

  final IconData icon;

  /// For screen readers and the long-press tooltip.
  final String label;

  /// Null draws the button dimmed and dead, the way the mic is.
  final VoidCallback? onTap;

  /// The drawn circle.
  static const double diameter = 42;

  /// What the finger may land on, spilling past the circle on every side.
  static const double touchExtent = 50;

  static const double touchOverhang = (touchExtent - diameter) / 2;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final live = onTap != null;
    return Semantics(
      button: true,
      enabled: live,
      label: label,
      child: Tooltip(
        message: label,
        child: SizedBox.square(
          dimension: diameter,
          child: OverflowBox(
            maxWidth: touchExtent,
            maxHeight: touchExtent,
            child: GestureDetector(
              // Opaque even when dead: a tap on a dimmed button must not fall
              // through to the terminal and raise the keyboard.
              behavior: HitTestBehavior.opaque,
              onTap: onTap,
              child: SizedBox.square(
                dimension: touchExtent,
                child: AnimatedOpacity(
                  // The mic's dimmed opacity, so they read alike.
                  duration: const Duration(milliseconds: 160),
                  opacity: live ? 1 : 0.4,
                  child: Center(
                    // The mic's resting look — see [FloatingGlass].
                    child: FloatingGlass(
                      child: Container(
                        width: diameter,
                        height: diameter,
                        decoration: BoxDecoration(
                          shape: BoxShape.circle,
                          color: floatingButtonFill,
                          border: Border.all(color: floatingButtonRim),
                          boxShadow: floatingButtonShadow,
                        ),
                        child: Icon(
                          icon,
                          size: 20,
                          color: AppPalette.textPrimary,
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
