import 'dart:async';

import 'package:flutter/animation.dart';
import 'package:flutter/services.dart';

import 'package:harness_mobile/core/chime.dart';

import 'onboarding_picture.dart';

/// A computer joining: about two seconds from the laptop's first stroke to its session growing into
/// the screen (`docs/research/2026-10-11-phone-onboarding`, "The Mac joins, frame by frame") — the
/// clock, and what is felt and heard on it. The picture is drawn from [picture]
/// ([OnboardingPicture.join]); the screen goes on when [done].
///
/// ```
///    0 ms  three quickening taps while the laptop's outline draws itself
///  600 ms  the screen lights: the success buzz, and the only sound in setup — two soft glass notes
/// 2200 ms  done: the session takes the screen
/// ```
///
/// ⚠️ **Driven by frames, and that is what replays it.** A computer that joins while the app is in
/// the background gets its moment when the app is next in front: no frame, no tick, until then.
///
/// Muted, the notes are silent ([Chime]) and the haptics stay. Reduce Motion changes how the picture
/// draws it, not its clock.
class JoinMoment {
  JoinMoment({required TickerProvider vsync, required VoidCallback onDone})
    : _controller = AnimationController(vsync: vsync, duration: length) {
    _controller
      ..addListener(_beat)
      ..addStatusListener((status) {
        if (status == AnimationStatus.completed && !_done) {
          _done = true;
          onDone();
        }
      });
  }

  final AnimationController _controller;

  /// From the first stroke to the session.
  static const length = Duration(milliseconds: 2200);

  /// The picture's part of it: 0 → 1 over [OnboardingPicture.joinLength], then held.
  late final Animation<double> picture = CurvedAnimation(
    parent: _controller,
    curve: Interval(
      0,
      OnboardingPicture.joinLength.inMilliseconds / length.inMilliseconds,
    ),
  );

  bool _done = false;

  /// It has run its course — or a tap cut it short.
  bool get done => _done;

  /// How many beats have been played ([_beat]).
  int _beats = 0;

  static const _taps = [0, 160, 270];
  static const _lights = 600;

  /// From the start. Call it after the frame that first draws the joined picture.
  void start() {
    if (_done) return;
    _beats = 0;
    unawaited(_controller.forward(from: 0));
  }

  /// A tap: straight on to [done], with nothing left of the moment to play.
  void skip() {
    if (_done) return;
    _beats = _taps.length + 1;
    _controller.value = 1;
  }

  void dispose() => _controller.dispose();

  /// The beats, played as the clock reaches them — each once, so a frame that jumps several does
  /// not play them over each other out of order.
  void _beat() {
    final ms = _controller.value * length.inMilliseconds;
    while (_beats < _taps.length && ms >= _taps[_beats]) {
      _beats++;
      HapticFeedback.lightImpact();
    }
    if (_beats == _taps.length && ms >= _lights) {
      _beats++;
      HapticFeedback.mediumImpact();
      unawaited(Chime.play(Chime.joined));
    }
  }
}
