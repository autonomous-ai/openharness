import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';

import '../../shared/theme/app_icons.dart';
import '../../shared/widgets/app_icon_button.dart';
import '../../shared/widgets/empty_state.dart';
import '../../shared/widgets/skeleton.dart';
import '../../theme/app_theme.dart';
import '../finder_document.dart';
import '../finder_file_kind.dart';
import '../finder_language.dart';
import '../finder_load.dart';
import '../finder_models.dart';
import 'finder_code_editor.dart';
import 'finder_disk_banner.dart';
import 'finder_markdown_view.dart';
import 'finder_surface_bar.dart';

/// A file tab's content: the editor for text, Preview or Source for
/// Markdown, the picture for an image, and the system's app for the rest —
/// Orca's choice of viewer by kind.
class FinderFileSurface extends StatefulWidget {
  const FinderFileSurface({
    super.key,
    required this.document,
    required this.label,
    required this.onOpenExternally,
  });

  final FinderDocument document;
  final String label;
  final VoidCallback onOpenExternally;

  @override
  State<FinderFileSurface> createState() => _FinderFileSurfaceState();
}

class _FinderFileSurfaceState extends State<FinderFileSurface> {
  /// Markdown opens rendered; the eye switches to its source to edit it.
  bool _source = false;
  bool _wrap = true;

  FinderDocument get _document => widget.document;

  bool get _markdown =>
      finderFileKind(_document.path) == FinderFileKind.markdown;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: _document,
    builder: (context, _) => Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        FinderSurfaceBar(label: widget.label, actions: _actions()),
        Divider(height: 1, color: AppColors.border),
        FinderDiskBanner(document: _document),
        Expanded(child: _body()),
      ],
    ),
  );

  List<Widget> _actions() {
    final text = switch (_document.content) {
      FinderLoaded(value: FinderText()) => true,
      _ => false,
    };
    return [
      if (text && _markdown)
        AppIconButton(
          key: const ValueKey('finder-markdown-source'),
          icon: _source ? AppIcons.eye : AppIcons.code,
          tooltip: _source ? 'Show preview' : 'Edit source',
          onPressed: () => setState(() => _source = !_source),
        ),
      if (text && (!_markdown || _source))
        AppIconButton(
          key: const ValueKey('finder-word-wrap'),
          icon: AppIcons.wrapText,
          tooltip: _wrap ? 'Turn word wrap off' : 'Turn word wrap on',
          selected: _wrap,
          onPressed: () => setState(() => _wrap = !_wrap),
        ),
      AppIconButton(
        key: const ValueKey('finder-open-file'),
        icon: AppIcons.externalLink,
        tooltip: 'Open with default app',
        onPressed: widget.onOpenExternally,
      ),
    ];
  }

  Widget _body() => switch (_document.content) {
    FinderLoading() => const SkeletonList(
      rows: 12,
      padding: EdgeInsets.all(16),
    ),
    FinderFailed(:final message) => EmptyState(
      icon: AppIcons.circleAlert,
      title: 'Can’t open this file',
      message: message,
      compact: true,
    ),
    FinderLoaded(:final value) => _content(value),
  };

  Widget _content(FinderContent content) => switch (content) {
    FinderText() when _markdown && !_source => ListenableBuilder(
      listenable: _document.editor!,
      builder: (context, _) => FinderMarkdownView(_document.editor!.text),
    ),
    FinderText() => FinderCodeEditor(
      controller: _document.editor!,
      language: finderLanguageOf(_document.path),
      wordWrap: _wrap,
      onSave: _document.save,
    ),
    FinderImage(:final bytes, :final svg) => InteractiveViewer(
      key: const ValueKey('finder-image'),
      maxScale: 8,
      child: Center(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: svg ? SvgPicture.memory(bytes) : Image.memory(bytes),
        ),
      ),
    ),
    FinderBinary(:final reason) => EmptyState(
      icon: AppIcons.file,
      title: 'No preview',
      message: reason,
      compact: true,
      action: TextButton(
        key: const ValueKey('finder-open-externally'),
        onPressed: widget.onOpenExternally,
        child: const Text('Open with default app'),
      ),
    ),
  };
}
