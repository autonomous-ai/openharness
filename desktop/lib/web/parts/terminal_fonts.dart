import 'package:flutter/services.dart';

import '../../terminal/terminal_typography.dart';

/// Roboto Mono's files, as pubspec.yaml lists them under [webTerminalFontFamily].
///
/// A release leaves this family, and [terminalIconFontAsset], out of the fonts
/// every page waits for (scripts/build-web-release.sh): the sign-in page draws
/// no terminal. The workspace part loads them ([downloadWorkspace]).
const terminalFontAssets = [
  'assets/fonts/roboto-mono/RobotoMono.ttf',
  'assets/fonts/roboto-mono/RobotoMono-Italic.ttf',
];

/// Symbols Nerd Font Mono, the private-use icons. One file, loaded with the
/// text face so a terminal is not first drawn without them.
const terminalIconFontAsset =
    'assets/fonts/symbols-nerd-font-mono/SymbolsNerdFontMono-Regular.ttf';

/// Registers the terminal's text face and its icon face. A screen already
/// drawn re-lays out its text when they land (xterm re-measures its cells too).
Future<void> loadTerminalFonts() async {
  final text = FontLoader(webTerminalFontFamily);
  for (final asset in terminalFontAssets) {
    text.addFont(rootBundle.load(asset));
  }
  final icons = FontLoader(terminalIconFontFamily)
    ..addFont(rootBundle.load(terminalIconFontAsset));
  await Future.wait([text.load(), icons.load()]);
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
