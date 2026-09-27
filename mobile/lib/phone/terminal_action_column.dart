import 'package:flutter/material.dart';
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
    this.working = false,
  });

  final VoiceInputController voice;

  /// The agent is working: the mic wears a ring — see `VoiceMicCore.working`.
  final bool working;

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

  /// How far the orb's slot sits above the foot of the page. Low and centred, where Siri's orb
  /// stands over the dock — below the agent's prompt rather than on it — and the terminal runs full
  /// screen under it.
  ///
  /// Measured off Siri: its orb's centre stands about 76pt above the foot of an iPhone 14, so
  /// this slot's foot sits half the slot below that.
  static const double orbBottom = 76 - VoiceMicButton.extent / 2;

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
    return _column(context, widget.session);
  }

  Widget _column(BuildContext context, TerminalSession? session) {
    // ⚠️ **Search floats here only while the keyboard is up.** With it down, Find is a swipe right
    // or a tap on the agent's name; with the keyboard up, Find rides up here, top right.
    if (widget.searchOnly) {
      return _centred(
        _withUnread(
          TerminalRoundAction(
            key: const ValueKey('terminal-search'),
            icon: LucideIcons.search300,
            label: 'Find an agent',
            onTap: widget.onSearch,
          ),
        ),
      );
    }
    // Still attaching: the mic in its place, dimmed and dead.
    if (session == null) {
      return const VoiceMicButton(face: VoiceMicFace.talk, onPressed: null);
    }
    // The mic alone: what it is doing is said beside it — see `voice_bar_line.dart`.
    return VoiceMicFab(
      voice: widget.voice,
      session: session,
      onSlipChanged: _onSlipChanged,
      working: widget.working,
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
