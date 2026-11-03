import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'package:harness_mobile/clipboard/native_clipboard.dart';

import 'swarm_outgoing_files.dart';

/// What a picture pasted into a message box is called: a clipboard holds
/// pixels, not a file (the desktop's `kPastedImageName`).
const swarmPastedImageName = 'pasted-image.png';

/// Whether the clipboard holds a picture, asked without reading it, so iOS
/// shows no "Allow Paste" prompt and Android no toast. Replaced in tests.
@visibleForTesting
Future<bool> Function() swarmClipboardHasImage = NativeClipboard.hasImage;

/// The clipboard's picture as PNG: null when there is none, empty when there
/// is one the phone cannot read. Replaced in tests.
@visibleForTesting
Future<Uint8List?> Function() readSwarmClipboardImage =
    NativeClipboard.readImagePng;

/// How long the box's menu waits to learn whether a picture is on the
/// clipboard before it opens without Paste for it.
const _askLimit = Duration(milliseconds: 400);

/// A picture pasted into a message box: its [name] and how to [read] its
/// bytes. Read only once the person chose Paste.
class SwarmPastedImage {
  const SwarmPastedImage(this.name, this.read);

  /// The clipboard's picture, from the box's Paste.
  factory SwarmPastedImage.clipboard() =>
      SwarmPastedImage(swarmPastedImageName, () => readSwarmClipboardImage());

  /// A picture the keyboard put in — Gboard's clipboard, a sticker, a GIF.
  factory SwarmPastedImage.inserted(KeyboardInsertedContent content) {
    final data = content.data;
    final extension = switch (content.mimeType) {
      'image/gif' => 'gif',
      'image/jpeg' || 'image/jpg' => 'jpg',
      'image/webp' => 'webp',
      _ => 'png',
    };
    // No bytes is a picture the keyboard sent that could not be read.
    return SwarmPastedImage(
      'pasted-image.$extension',
      () async => data ?? Uint8List(0),
    );
  }

  final String name;
  final Future<Uint8List?> Function() read;
}

/// A message box that takes pasted pictures: [onImage] gets each, and the
/// box's menu offers Paste for one only while [enabled] — when the + would
/// take files.
class SwarmImagePaste {
  const SwarmImagePaste({required this.enabled, required this.onImage});

  final bool enabled;
  final ValueChanged<SwarmPastedImage> onImage;
}

/// The kinds of picture a keyboard may put in a box: those a chat shows.
const swarmInsertedImageTypes = [
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
];

/// Adds [image] to [files] beside what is there, numbered as photos are
/// (`pasted-image-2.png`…), by the same limits: ten files a message, 256 MB
/// each. What to say under the box goes to [note]; null clears it. Nothing
/// is added, or said, once [stillWanted] fails — the chat closed, was
/// replaced, or access to it was lost while the clipboard was read. The
/// bytes stay in memory only.
Future<void> pasteSwarmImage(
  SwarmOutgoingFiles files,
  SwarmPastedImage image, {
  required bool Function() stillWanted,
  required ValueChanged<String?> note,
}) async {
  if (files.room <= 0) {
    note('Attach at most $swarmAttachmentMaxFiles files.');
    return;
  }
  Uint8List? bytes;
  try {
    bytes = await image.read();
  } catch (_) {
    bytes = Uint8List(0);
  }
  if (!stillWanted()) return;
  if (bytes == null) {
    note('There is no picture on the clipboard.');
    return;
  }
  if (bytes.isEmpty) {
    note("That picture isn't one this phone can read.");
    return;
  }
  note(files.addNumbered([SwarmOutgoingFile(image.name, bytes)]));
}

/// The message box's long-press menu: the field's own — text Paste
/// unchanged — and, while [paste] takes pictures and one is on the
/// clipboard, Paste for it ("Paste image" beside a text Paste).
Widget swarmFieldMenu(
  BuildContext context,
  EditableTextState field,
  SwarmImagePaste? paste,
) {
  if (paste == null || !paste.enabled || field.widget.readOnly) {
    return _fieldMenu(field, null);
  }
  return _ImagePasteMenu(field: field, paste: paste);
}

Widget _fieldMenu(EditableTextState field, VoidCallback? pasteImage) {
  final textPaste = field.contextMenuButtonItems.any(
    (item) => item.type == ContextMenuButtonType.paste,
  );
  final label = textPaste ? 'Paste image' : 'Paste';
  if (SystemContextMenu.isSupportedByField(field)) {
    final items = SystemContextMenu.getDefaultItems(field);
    if (pasteImage != null) {
      items.insert(
        _afterEditing(items, (item) => item is IOSSystemContextMenuItemPaste, (
          item,
        ) {
          return item is IOSSystemContextMenuItemCut ||
              item is IOSSystemContextMenuItemCopy;
        }),
        IOSSystemContextMenuItemCustom(title: label, onPressed: pasteImage),
      );
    }
    return SystemContextMenu.editableText(
      editableTextState: field,
      items: items,
    );
  }
  final buttons = [...field.contextMenuButtonItems];
  if (pasteImage != null) {
    buttons.insert(
      _afterEditing(
        buttons,
        (item) => item.type == ContextMenuButtonType.paste,
        (item) =>
            item.type == ContextMenuButtonType.cut ||
            item.type == ContextMenuButtonType.copy,
      ),
      ContextMenuButtonItem(label: label, onPressed: pasteImage),
    );
  }
  return AdaptiveTextSelectionToolbar.buttonItems(
    anchors: field.contextMenuAnchors,
    buttonItems: buttons,
  );
}

/// Where a picture's Paste goes in [items]: after the text Paste, else after
/// Cut and Copy, else first.
int _afterEditing<T>(
  List<T> items,
  bool Function(T) isPaste,
  bool Function(T) isCutOrCopy,
) {
  final paste = items.indexWhere(isPaste);
  if (paste >= 0) return paste + 1;
  return items.lastIndexWhere(isCutOrCopy) + 1;
}

/// The menu once the clipboard has said whether it holds a picture — asked as
/// the menu opens, and for no more than [_askLimit].
class _ImagePasteMenu extends StatefulWidget {
  const _ImagePasteMenu({required this.field, required this.paste});

  final EditableTextState field;
  final SwarmImagePaste paste;

  @override
  State<_ImagePasteMenu> createState() => _ImagePasteMenuState();
}

class _ImagePasteMenuState extends State<_ImagePasteMenu> {
  bool? _hasImage;

  @override
  void initState() {
    super.initState();
    unawaited(_ask());
  }

  Future<void> _ask() async {
    bool has;
    try {
      has = await swarmClipboardHasImage().timeout(
        _askLimit,
        onTimeout: () => false,
      );
    } catch (_) {
      has = false;
    }
    if (mounted) setState(() => _hasImage = has);
  }

  void _pasteImage() {
    widget.field.hideToolbar();
    widget.paste.onImage(SwarmPastedImage.clipboard());
  }

  @override
  Widget build(BuildContext context) => switch (_hasImage) {
    null => const SizedBox.shrink(),
    true => _fieldMenu(widget.field, _pasteImage),
    false => _fieldMenu(widget.field, null),
  };
}
