import 'package:flutter/widgets.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../state/harness_attachments.dart';
import '../widgets/new_harness_attachments.dart';
import 'controller.dart';

/// The files waiting in a chat box, as chips above its field. The main chat and the
/// thread pane draw them with this, so a change to the chips reaches both.
class SuperTabComposerChips extends StatelessWidget {
  const SuperTabComposerChips({
    super.key,
    required this.controller,
    required this.files,
  });

  final SuperTabController controller;
  final HarnessAttachments files;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: files,
    builder: (context, _) => files.isEmpty
        ? const SizedBox.shrink()
        : Padding(
            padding: const EdgeInsets.only(
              bottom: grid.AppDesktop.controlGap,
              right: grid.AppDesktop.controlGap,
            ),
            child: NewHarnessAttachmentChips(
              attachments: files,
              enabled: !controller.saving,
              isUploading: controller.isUploading,
              progressOf: controller.uploadProgress,
            ),
          ),
  );
}
