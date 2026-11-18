// The bar's microphone: PCM for the computer, and its level for the waveform and for hearing speech.
import 'dart:typed_data';

abstract interface class Mic {
  /// PCM s16le mono at this rate.
  int get sampleRate;

  /// Opens the mic; false when there is none (the link then reports nothing heard).
  Future<bool> open();

  /// The recording, in chunks, while open.
  Stream<Uint8List> get pcm;

  /// Its level, 0..1, about 20 times a second while open.
  Stream<double> get levels;

  Future<void> close();
}
