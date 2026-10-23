import 'package:flutter/painting.dart';
import 'package:flutter/services.dart' show Brightness;
import 'package:re_editor/re_editor.dart';
import 'package:re_highlight/languages/all.dart';
import 'package:re_highlight/re_highlight.dart';
import 'package:re_highlight/styles/github-dark.dart';
import 'package:re_highlight/styles/github.dart';

/// The token colours a Finder tab paints code in: GitHub's, light or dark,
/// with the page's own ground — the pane already has one.
Map<String, TextStyle> finderCodeColors(Brightness brightness) {
  final theme = brightness == Brightness.dark ? githubDarkTheme : githubTheme;
  return {...theme, 'root': TextStyle(color: theme['root']?.color)};
}

/// The editor's highlighting for [language] (a [finderLanguageOf] id), or
/// null for plain text. One instance per language and brightness: the
/// editor re-highlights the whole file whenever it is handed a new one.
CodeHighlightTheme? finderEditorHighlight(
  String? language,
  Brightness brightness,
) {
  final mode = language == null ? null : builtinAllLanguages[language];
  if (mode == null) return null;
  return _editorThemes.putIfAbsent(
    (language!, brightness),
    () => CodeHighlightTheme(
      languages: {language: CodeHighlightThemeMode(mode: mode)},
      theme: finderCodeColors(brightness),
    ),
  );
}

final _editorThemes = <(String, Brightness), CodeHighlightTheme>{};

final _highlighter = Highlight()..registerLanguages(builtinAllLanguages);

/// One line of code coloured on its own — a diff's line, which has no file
/// around it to carry a comment or a string across lines. Plain when
/// [language] is null or unknown.
TextSpan highlightLine(
  String line,
  String? language,
  TextStyle base,
  Brightness brightness,
) {
  if (language == null || builtinAllLanguages[language] == null) {
    return TextSpan(text: line, style: base);
  }
  final renderer = TextSpanRenderer(base, finderCodeColors(brightness));
  _highlighter.highlight(code: line, language: language).render(renderer);
  return renderer.span ?? TextSpan(text: line, style: base);
}
