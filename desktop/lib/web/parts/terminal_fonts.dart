import 'dart:async';

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

/// Symbols Nerd Font Mono, the private-use icons. Started with the text face.
/// The workspace does not wait for it: the file is large, and a terminal
/// redraws when the face lands.
const terminalIconFontAsset =
    'assets/fonts/symbols-nerd-font-mono/SymbolsNerdFontMono-Regular.ttf';

/// Registers the terminal's text face and starts its icon face. Completes
/// when the text face is ready. The icon file keeps loading; a screen already
/// drawn re-lays out when a face lands (xterm re-measures its cells too).
Future<void> loadTerminalFonts() {
  final text = FontLoader(webTerminalFontFamily);
  for (final asset in terminalFontAssets) {
    text.addFont(rootBundle.load(asset));
  }
  final icons = FontLoader(terminalIconFontFamily)
    ..addFont(rootBundle.load(terminalIconFontAsset));
  return loadTextFaceFirst(text: text.load(), icons: icons.load());
}

/// Completes with [text]. [icons] is started and does not hold the result, so
/// the workspace grace waits on Roboto Mono and not the icon file. An icon
/// download that fails leaves the text face in place.
Future<void> loadTextFaceFirst({
  required Future<void> text,
  required Future<void> icons,
}) {
  unawaited(icons.then((_) {}, onError: (Object _, StackTrace _) {}));
  return text;
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
