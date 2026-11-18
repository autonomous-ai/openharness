// The board's microphone through ALSA's arecord (no plugins on flutter-pi).
import 'mic.dart';

/// The bar's mic: arecord on Linux, none elsewhere (null).
Mic? createMic() => null;
