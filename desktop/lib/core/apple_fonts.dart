import 'dart:io' show Platform;

/// Whether this OS ships Apple's system fonts — SF Pro, SF Mono (CoreText's
/// `.AppleSystemUIFont*` aliases) and Menlo.
///
/// The font chains used to ask `Platform.isMacOS`, which sent iOS down the
/// Linux chain: every family there (DejaVu, Ubuntu, Noto) is missing on an
/// iPhone, so the terminal fell through to a proportional face and its grid
/// came apart. iOS resolves the same CoreText faces as a Mac, so it takes the
/// same chain.
bool get hasAppleFonts => Platform.isMacOS || Platform.isIOS;
