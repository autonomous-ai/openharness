// The bar's chime: the sound of an alert, as the C build's audio_beep, with a sound of its own for each kind of alert
// (the owner's call, 19 Nov).

enum ChimeSound {
  /// An agent asks: an approval or a question. Two short tones.
  ask,

  /// A turn failed: the C build's beep, three short tones.
  failed,

  /// A turn finished: soft, two notes that fade.
  done,
}

abstract interface class Chime {
  /// Plays [sound] once; a chime asked for while one plays is dropped.
  Future<void> play(ChimeSound sound);
}

/// No speaker (a still fixture, a machine without one): nothing sounds.
class NoChime implements Chime {
  const NoChime();

  @override
  Future<void> play(ChimeSound sound) async {}
}
