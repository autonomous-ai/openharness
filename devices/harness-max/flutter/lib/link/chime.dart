// The bar's chime: the sound of an alert (a question, a failure, a loud finished turn), as the C build's audio_beep.

abstract interface class Chime {
  /// Plays the chime once; a chime asked for while one plays is dropped.
  Future<void> play();
}

/// No speaker (a still fixture, a machine without one): nothing sounds.
class NoChime implements Chime {
  const NoChime();

  @override
  Future<void> play() async {}
}
