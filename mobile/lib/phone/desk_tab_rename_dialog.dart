import 'package:flutter/material.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/widgets/app_dialog.dart';
import 'package:harness_mobile/state/app_state.dart';

/// Rename a tab, from a double tap on its name in the tabs panel.
///
/// ⚠️ **It writes and closes; it does not wait to be told it worked.** A tab
/// name is not the CLI's to refuse the way an agent's is (see
/// [showAgentRenameDialog], which shows the machine's answer under the field):
/// the desk takes the op, every computer on the account picks it up, and this
/// phone has already drawn the new name over its own copy — see
/// [PhoneDesk.renameTab]. A dialog held open for a round trip would sit there
/// on a phone in a lift for no reason.
Future<void> showDeskTabRenameDialog(
  BuildContext context,
  AppNotifier notifier, {
  required String tabId,
  required String currentName,
}) => showAppDialog<void>(
  context: context,
  builder: (_) => _RenameTabDialog(
    notifier: notifier,
    tabId: tabId,
    currentName: currentName,
  ),
);

/// ⚠️ A widget that OWNS its controller — see the note in
/// `widgets/rename_agent_dialog.dart` for the red screen the other shape
/// caused.
class _RenameTabDialog extends StatefulWidget {
  const _RenameTabDialog({
    required this.notifier,
    required this.tabId,
    required this.currentName,
  });

  final AppNotifier notifier;
  final String tabId;
  final String currentName;

  @override
  State<_RenameTabDialog> createState() => _RenameTabDialogState();
}

class _RenameTabDialogState extends State<_RenameTabDialog> {
  late final _controller = TextEditingController(text: widget.currentName)
    // The name is there to be replaced, not to be typed around: selected, the
    // first key wipes it, and a thumb that meant to edit still has the caret.
    ..selection = TextSelection(
      baseOffset: 0,
      extentOffset: widget.currentName.length,
    );

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _submit() {
    widget.notifier.renameDeskTab(widget.tabId, _controller.text);
    Navigator.of(context).pop();
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return AlertDialog(
      title: const Text('Rename tab'),
      content: TextField(
        controller: _controller,
        autofocus: true,
        style: kFieldTextStyle,
        textInputAction: TextInputAction.done,
        onSubmitted: (_) => _submit(),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Cancel'),
        ),
        FilledButton(onPressed: _submit, child: const Text('Save')),
      ],
    );
  }
}
