import 'package:flutter/services.dart';

import '../../terminal/terminal_typography.dart';

/// Roboto Mono's files, as pubspec.yaml lists them under [webTerminalFontFamily].
///
/// A release leaves the family out of the fonts every page waits for
/// (scripts/build-web-release.sh): the sign-in page draws no terminal, and the
/// two files are 0.23 MB a first visit waited for before its first frame.
/// The workspace part loads them ([downloadWorkspace]).
const terminalFontAssets = [
  'assets/fonts/roboto-mono/RobotoMono.ttf',
  'assets/fonts/roboto-mono/RobotoMono-Italic.ttf',
];

/// Registers [terminalFontAssets] as [webTerminalFontFamily]. A screen already
/// drawn re-lays out its text when they land (xterm re-measures its cells too).
Future<void> loadTerminalFonts() {
  final loader = FontLoader(webTerminalFontFamily);
  for (final asset in terminalFontAssets) {
    loader.addFont(rootBundle.load(asset));
  }
  return loader.load();
}

/// How long the workspace waits for [terminalFontAssets] once its library is in.
const terminalFontsGrace = Duration(seconds: 3);

/// The workspace's [library] and the terminal's [fonts], side by side. The
/// workspace waits for the fonts so no terminal is first drawn in a fallback
/// face, but fonts that fail, or are still on their way [fontsGrace] after the
/// library, do not keep it away: the fallback draws, and xterm re-measures its
/// cells when the fonts land.
Future<void> downloadWorkspace({
  required Future<void> Function() library,
  required Future<void> Function() fonts,
  Duration fontsGrace = terminalFontsGrace,
}) async {
  final fontsIn = fonts().then((_) {}, onError: (Object _) {});
  await library();
  await fontsIn.timeout(fontsGrace, onTimeout: () {});
}
