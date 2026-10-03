import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../clipboard/copied_files.dart';
import '../clipboard/native_clipboard.dart';
import '../clipboard/pasted_files.dart';
import '../clipboard/pasted_text.dart';
import '../state/harness_attachments.dart';
import 'new_harness_attachments.dart';

/// What a picture pasted off this computer's clipboard is called: a clipboard
/// holds pixels, not a file, so the picture has no name of its own.
const kPastedImageName = 'pasted-image.png';

/// The files a file manager's Copy left on this computer's clipboard.
Future<CopiedFiles> _clipboardFiles() async => readCopiedFiles(
  await NativeClipboard.readFilePaths(),
  maxBytes: HarnessAttachments.maxBytes,
);

/// Paste in [child]'s task field attaches what the clipboard holds besides
/// text. On this computer ⌘V adds to [attachments] the files copied in a file
/// manager, or the picture on the clipboard — a screenshot, Copy Image; in a
/// browser, the files a paste carries. Text still pastes into the field
/// ([pastedTextWins]).
class NewHarnessPasteTarget extends StatefulWidget {
  const NewHarnessPasteTarget({
    super.key,
    required this.attachments,
    required this.enabled,
    required this.focusNode,
    required this.child,
    this.readFiles = _clipboardFiles,
    this.readImage = NativeClipboard.readImagePng,
  });

  final HarnessAttachments attachments;
  final bool enabled;

  /// The task field's focus: a browser's paste is this box's only while the
  /// field holds it.
  final FocusNode focusNode;
  final Widget child;

  /// The clipboard's copied files; tests pass their own.
  final Future<CopiedFiles> Function() readFiles;

  /// The clipboard's picture as PNG, or null; tests pass their own.
  final Future<Uint8List?> Function() readImage;

  @override
  State<NewHarnessPasteTarget> createState() => _NewHarnessPasteTargetState();
}

class _NewHarnessPasteTargetState extends State<NewHarnessPasteTarget> {
  late final _actions = <Type, Action<Intent>>{
    PasteTextIntent: _PasteAction(_paste),
  };
  late final void Function() _stopListening;

  @override
  void initState() {
    super.initState();
    _stopListening = listenForPastedFiles(
      wanted: () => widget.enabled && widget.focusNode.hasFocus,
      onFiles: _attachFiles,
    );
  }

  @override
  void dispose() {
    _stopListening();
    super.dispose();
  }

  void _attach(
    Iterable<HarnessAttachment> files, {
    Iterable<String> oversized = const [],
  }) {
    // Reading a clipboard takes a moment the box may not have survived.
    if (!mounted || !widget.enabled) return;
    reportAttachProblem(
      context,
      widget.attachments.addPasted(files, oversized: oversized),
    );
  }

  void _attachFiles(
    List<PastedFile> files, {
    Iterable<String> oversized = const [],
  }) => _attach([
    for (final file in files) HarnessAttachment(file.name, file.bytes),
  ], oversized: oversized);

  /// ⌘V: what the clipboard holds as attachments, or [pasteText] — the
  /// field's own paste — when text is what was copied.
  ///
  /// Copied files come first. Beside them a file manager leaves each file's
  /// name as text and its icon as a picture, and neither is what was copied.
  Future<void> _paste(VoidCallback pasteText) async {
    if (!widget.enabled) return pasteText();
    final copied = await widget.readFiles();
    if (copied.files.isNotEmpty || copied.tooLarge.isNotEmpty) {
      return _attachFiles(copied.files, oversized: copied.tooLarge);
    }
    if (pastedTextWins(await _clipboardText())) return pasteText();
    final image = await widget.readImage();
    if (image == null || image.isEmpty) return pasteText();
    _attach([HarnessAttachment(kPastedImageName, image)]);
  }

  Future<String?> _clipboardText() async {
    try {
      return (await Clipboard.getData(Clipboard.kTextPlain))?.text;
    } on PlatformException {
      return null;
    }
  }

  @override
  Widget build(BuildContext context) =>
      Actions(actions: _actions, child: widget.child);
}

/// Stands in for the field's paste, which it is handed to fall back on.
class _PasteAction extends Action<PasteTextIntent> {
  _PasteAction(this.paste);

  final Future<void> Function(VoidCallback pasteText) paste;

  @override
  Object? invoke(PasteTextIntent intent) {
    // The field's own action, taken now: it is gone once this returns.
    final field = callingAction;
    unawaited(paste(() => field?.invoke(intent)));
    return null;
  }
}
