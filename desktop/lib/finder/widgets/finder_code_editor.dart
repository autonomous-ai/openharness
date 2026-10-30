import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:re_editor/re_editor.dart';

import '../../shared/theme/app_theme.dart' as grid;
import '../../shortcuts/app_keymap.dart' show KeymapRegion;
import '../../shortcuts/keymap.dart';
import '../../theme/app_theme.dart';
import 'finder_code_theme.dart';
import 'finder_find_panel.dart';

/// The strokes an editor takes ahead of the workspace's bindings while it
/// has focus — ⌘S is Harness Store and ⌘F the terminal's find elsewhere,
/// but in a file they save and search it, as in Orca. Built on ⌘ for every
/// platform: the keymap moves the workspace to Alt where ⌘ is missing.
final kFinderEditorKeys = {
  for (final keys in [
    'cmd+s', 'cmd+f', 'cmd+alt+f', 'cmd+z', 'cmd+shift+z', 'cmd+a', //
    'cmd+c', 'cmd+x', 'cmd+v', 'cmd+slash', 'alt+up', 'alt+down',
  ])
    KeyStroke.parse(keys),
};

/// ⌘S on a Mac, Ctrl+S elsewhere — the editor's save, as in Orca.
SingleActivator get finderSaveKey => SingleActivator(
  LogicalKeyboardKey.keyS,
  meta: defaultTargetPlatform == TargetPlatform.macOS,
  control: defaultTargetPlatform != TargetPlatform.macOS,
);

/// A file's text in an editor: highlighted for its language, numbered,
/// foldable, searchable (⌘F) and saved with ⌘S — the Monaco tab of Orca,
/// drawn by re_editor.
class FinderCodeEditor extends StatefulWidget {
  const FinderCodeEditor({
    super.key,
    required this.controller,
    required this.language,
    required this.onSave,
    this.wordWrap = true,
    this.readOnly = false,
  });

  final CodeLineEditingController controller;

  /// A [finderLanguageOf] id; null is plain text.
  final String? language;
  final VoidCallback onSave;
  final bool wordWrap;
  final bool readOnly;

  @override
  State<FinderCodeEditor> createState() => _FinderCodeEditorState();
}

class _FinderCodeEditorState extends State<FinderCodeEditor> {
  late CodeFindController _find = CodeFindController(widget.controller);

  @override
  void didUpdateWidget(FinderCodeEditor old) {
    super.didUpdateWidget(old);
    if (old.controller != widget.controller) {
      _find.dispose();
      _find = CodeFindController(widget.controller);
    }
  }

  @override
  void dispose() {
    _find.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final brightness = grid.AppTheme.watch(context);
    final code = grid.AppType.mono(color: AppColors.text);
    final number = grid.AppType.mono(color: AppColors.muted);
    return KeymapRegion(
      contextKind: KeymapContext.workspace,
      keeps: kFinderEditorKeys,
      child: CallbackShortcuts(
        bindings: {finderSaveKey: widget.onSave},
        child: CodeEditor(
          key: const ValueKey('finder-code-editor'),
          controller: widget.controller,
          findController: _find,
          readOnly: widget.readOnly,
          wordWrap: widget.wordWrap,
          padding: const EdgeInsets.fromLTRB(4, 6, 12, 24),
          style: CodeEditorStyle(
            fontSize: code.fontSize,
            fontFamily: code.fontFamily,
            fontFamilyFallback: code.fontFamilyFallback,
            fontHeight: 1.45,
            textColor: AppColors.text,
            backgroundColor: Colors.transparent,
            selectionColor: AppColors.accent.withValues(alpha: .28),
            cursorColor: AppColors.accent,
            cursorLineColor: AppColors.rowHover,
            chunkIndicatorColor: AppColors.muted,
            codeTheme: finderEditorHighlight(widget.language, brightness),
          ),
          indicatorBuilder: (context, editing, chunks, notifier) => Row(
            children: [
              DefaultCodeLineNumber(
                controller: editing,
                notifier: notifier,
                textStyle: number,
                focusedTextStyle: number.copyWith(color: AppColors.text),
              ),
              DefaultCodeChunkIndicator(
                width: 16,
                controller: chunks,
                notifier: notifier,
              ),
            ],
          ),
          findBuilder: (context, controller, readOnly) =>
              FinderFindPanel(controller: controller, readOnly: readOnly),
        ),
      ),
    );
  }
}
