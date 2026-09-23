import 'dart:async';

import 'package:flutter/material.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/terminal/terminal_session.dart';

import 'voice_language_store.dart';
import 'voice_input_controller.dart';
import 'voice_mic_action.dart';
import 'voice_mic_button.dart';
import 'voice_mic_face.dart';
import 'voice_mic_mode.dart';

/// The mic, floating over the terminal's bottom right corner at the top of
/// [TerminalActionColumn].
///
/// ⚠️ **Floating rather than in a row.** A row under the terminal would take
/// its height off the remote shell; floating, the button costs the terminal
/// nothing but the corner it covers.
///
/// ⚠️ **The corner, deliberately — not centred, and not over the middle.** A
/// terminal's newest output is the line being read, and it runs left to right:
/// the right end of the last few lines is the least of it.
///
/// ⚠️ **The `×` is NOT here.** It is in the capsule body behind the mic, at the
/// far end from it — see `voice_status_pill.dart`.
class VoiceMicFab extends StatefulWidget {
  const VoiceMicFab({
    super.key,
    required this.voice,
    required this.session,
    this.onSlipChanged,
  });

  final VoiceInputController voice;
  final TerminalSession session;

  /// The thumb crossed in or out of the button mid-hold, in
  /// [VoiceMicMode.holdToTalk]. Unused in the tap mode, which has no hold.
  final ValueChanged<bool>? onSlipChanged;

  /// What the whole floating cluster asks of the corner it sits in.
  ///
  /// Bigger than [VoiceMicButton.extent] because the mic's hit area spills past
  /// its slot: this is what the page keeps clear of anything else tappable.
  static const double extent = VoiceMicButton.touchExtent;

  /// How far the cluster sits from the terminal's right and bottom edges.
  static const double inset = 8;

  /// How long a landed send wears its tick before the mic is back at rest.
  static const Duration sentHold = Duration(milliseconds: 900);

  @override
  State<VoiceMicFab> createState() => _VoiceMicFabState();
}

class _VoiceMicFabState extends State<VoiceMicFab>
    with SingleTickerProviderStateMixin {
  VoiceInputController get voice => widget.voice;

  /// Runs for [VoiceMicFab.sentHold] after a send lands; the tick shows while
  /// it does. A controller rather than a timer so the page settles when it ends
  /// and nothing is left pending if the page goes away first.
  late final AnimationController _sent = AnimationController(
    vsync: this,
    duration: VoiceMicFab.sentHold,
  )..addStatusListener(_onSentStatus);

  Listenable? _watched;

  /// The face at the last change — what tells a send that landed from any
  /// other way back to rest.
  VoiceMicFace? _lastFace;

  @override
  void initState() {
    super.initState();
    _watch();
  }

  @override
  void didUpdateWidget(VoiceMicFab old) {
    super.didUpdateWidget(old);
    if (old.voice != widget.voice || old.session != widget.session) {
      _unwatch();
      _watch();
    }
  }

  @override
  void dispose() {
    _unwatch();
    _sent.dispose();
    super.dispose();
  }

  void _watch() {
    final watched = Listenable.merge([widget.voice, widget.session]);
    watched.addListener(_onChange);
    _watched = watched;
    _lastFace = voiceMicAction(widget.voice, widget.session).face;
  }

  void _unwatch() {
    _watched?.removeListener(_onChange);
    _watched = null;
  }

  /// ⚠️ **The one place a landed send is seen.** The controller goes from
  /// sending straight back to rest, and rest is also where a cleared or an
  /// abandoned take ends up. Sending → rest with no notice is the only path
  /// that means the words arrived: a send that failed always leaves
  /// `VoiceNotice.notSent` behind, and keeps its words for the retry face.
  void _onChange() {
    final face = voiceMicAction(voice, widget.session).face;
    if (_lastFace == VoiceMicFace.sending &&
        face == VoiceMicFace.talk &&
        voice.notice == null) {
      _sent.forward(from: 0);
    }
    _lastFace = face;
    if (mounted) setState(() {});
  }

  void _onSentStatus(AnimationStatus status) {
    if (status == AnimationStatus.completed && mounted) setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final action = voiceMicAction(voice, widget.session);
    // Over [VoiceMicFace.talk] only: a take started during the tick is the
    // take to show, and nothing else may be hidden behind it.
    final face = action.face == VoiceMicFace.talk && _sent.isAnimating
        ? VoiceMicFace.sent
        : action.face;
    return VoiceMicButton(
      face: face,
      onPressed: action.onPressed,
      // ⚠️ No language shortcut in hold-to-talk: press-and-hold is what records
      // there, and a picker opening out of a held mic would fire in the middle
      // of every sentence. Settings ▸ Voice language is the way to it.
      onLongPress: micHoldsToTalk
          ? null
          : () => unawaited(showVoiceLanguagePicker(context)),
      onHoldStart: action.onHoldStart,
      onHoldFinish: action.onHoldFinish,
      onSlipChanged: widget.onSlipChanged,
    );
  }
}
