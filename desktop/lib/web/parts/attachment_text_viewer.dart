import 'package:flutter/widgets.dart';

import '../../super_tabs/attachment_text_viewer.dart' deferred as viewer;
import '../../super_tabs/file_links.dart';
import '../../super_tabs/model.dart';
import 'deferred_part.dart';

/// The chat's text viewer, built on the Finder's editor and its colours:
/// left out of `main.dart.js`. A browser opens chat files in a new tab
/// (`opensAsText`), so today it is downloaded only if that changes.
final attachmentTextPart = DeferredPart(viewer.loadLibrary);

/// The browser's stand-in for `super_tabs/attachment_text_viewer.dart`, picked
/// by the attachment chips' conditional import: the same viewer, once
/// [attachmentTextPart] is in.
class AttachmentTextViewer extends StatelessWidget {
  const AttachmentTextViewer({
    super.key,
    required this.file,
    required this.url,
    this.ref,
  });

  final SuperTabAttachment file;
  final Uri url;
  final SuperTabFileRef? ref;

  @override
  Widget build(BuildContext context) => DeferredPartView(
    part: attachmentTextPart,
    builder: (_) => viewer.AttachmentTextViewer(file: file, url: url, ref: ref),
  );
}
