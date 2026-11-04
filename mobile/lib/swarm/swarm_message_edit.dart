import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/phone/phone_sheet.dart' show confirmPhoneAction;
import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/app_type.dart';

import 'swarm_style.dart';

/// The longest text a message takes (backend messageEdits.ts).
const swarmMessageMaxLength = 32000;

/// Edit message, from a message's long-press sheet: its [text] in a field to
/// change, Cancel and Save. Answers the new text, trimmed; null for Cancel,
/// or for Save with the text as it was. Empty is saved only for a message
/// with files ([hasFiles]), whose files then say it alone.
Future<String?> showSwarmEditMessage(
  BuildContext context, {
  required String text,
  bool hasFiles = false,
}) => showModalBottomSheet<String>(
  context: context,
  isScrollControlled: true,
  backgroundColor: AppGlass.rowFill,
  shape: AppControl.sheetShape,
  builder: (_) => _EditSheet(text: text, hasFiles: hasFiles),
);

/// Delete message's question: only Delete answers true.
Future<bool> confirmSwarmDeleteMessage(BuildContext context) =>
    confirmPhoneAction(
      context,
      title: 'Delete message?',
      message: "This can't be undone.",
      confirmLabel: 'Delete',
      icon: LucideIcons.trash2300,
    );

class _EditSheet extends StatefulWidget {
  const _EditSheet({required this.text, required this.hasFiles});

  final String text;
  final bool hasFiles;

  @override
  State<_EditSheet> createState() => _EditSheetState();
}

class _EditSheetState extends State<_EditSheet> {
  late final _field = TextEditingController(text: widget.text);

  @override
  void dispose() {
    _field.dispose();
    super.dispose();
  }

  bool get _can => _field.text.trim().isNotEmpty || widget.hasFiles;

  void _save() {
    if (!_can) return;
    final typed = _field.text.trim();
    Navigator.of(context).pop(typed == widget.text ? null : typed);
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return Padding(
      // Over the keyboard.
      padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(
            AppSpace.l,
            AppSpace.s,
            AppSpace.l,
            AppSpace.l,
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              // The grabber, as the long-press sheet's.
              Center(
                child: Container(
                  width: AppSpace.xl + AppSpace.m,
                  height: AppSpace.xs,
                  margin: const EdgeInsets.only(bottom: AppSpace.m),
                  decoration: ShapeDecoration(
                    color: AppGlass.hair,
                    shape: const StadiumBorder(),
                  ),
                ),
              ),
              Text(
                'Edit message',
                style: AppType.heading(color: AppPalette.textPrimary),
              ),
              const SizedBox(height: AppSpace.m),
              TextField(
                key: const ValueKey('swarm-edit-field'),
                controller: _field,
                autofocus: true,
                minLines: 3,
                maxLines: 8,
                maxLength: swarmMessageMaxLength,
                keyboardType: TextInputType.multiline,
                textCapitalization: TextCapitalization.sentences,
                style: AppType.body(color: AppPalette.textPrimary),
                decoration: InputDecoration(
                  counterText: '',
                  filled: true,
                  fillColor: AppPalette.swarmField,
                  border: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(AppControl.radius),
                    borderSide: BorderSide.none,
                  ),
                ),
                onChanged: (_) => setState(() {}),
              ),
              const SizedBox(height: AppSpace.m),
              Row(
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  SwarmButton(
                    key: const ValueKey('swarm-edit-cancel'),
                    label: 'Cancel',
                    style: SwarmButtonStyle.link,
                    onPressed: () => Navigator.of(context).pop(),
                  ),
                  const SizedBox(width: AppSpace.s),
                  SwarmButton(
                    key: const ValueKey('swarm-edit-save'),
                    label: 'Save',
                    style: SwarmButtonStyle.fill,
                    onPressed: _can ? _save : null,
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}
