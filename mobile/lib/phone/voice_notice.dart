/// The one line voice input shows when it cannot do what was asked.
///
/// ⚠️ **One line on the narrowest phone: 40 characters at most.** Each is said
/// on the status line above the mic at `TtySize.meta` — about 42 cells across a
/// 360pt screen — and a full sentence there was cut mid-word ("tap the mic to
/// try agai…"). What went wrong, then ` · ` and what to do, as
/// `not sent · tap the mic again` says it.
abstract final class VoiceNotice {
  static const unavailable = 'No mic access · allow it in Settings';

  static const couldNotStart = "Mic couldn't start · tap to try again";

  static const nothingHeard = "Didn't catch that · tap the mic again";

  /// The microphone opened but delivered silence — a muted input, or a
  /// simulator the Mac has not given its microphone to. Speaking again will not
  /// help, so the notice does not suggest it.
  static const noSound = 'No sound from the mic · check its input';

  static const notTranscribed = "Couldn't transcribe · tap the mic again";

  static const notSent = "Not sent · terminal isn't taking input";
}
