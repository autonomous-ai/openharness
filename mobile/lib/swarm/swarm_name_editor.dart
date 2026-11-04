import 'package:flutter/material.dart';

import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/app_type.dart';
import 'package:harness_mobile/theme/app_theme.dart' show AppColors;

import 'swarm_style.dart';

/// The name the Swarm shows for the reader ("Minh Nguyen"): the field, Save,
/// and why a name was refused (taken, or not one a name can be), said under
/// the field — beside [SwarmUsernameEditor], whose username stays the handle
/// a tag types. Emptied, Save clears it, and the username shows again.
class SwarmNameEditor extends StatefulWidget {
  const SwarmNameEditor({
    super.key,
    required this.name,
    required this.enabled,
    required this.busy,
    required this.onSave,
  });

  /// The name they set; null while they show by their username.
  final String? name;

  /// The person may change it now: off while another change is saving, and
  /// for a reader who is no longer in the Swarm.
  final bool enabled;

  /// This field's own Save is on its way.
  final bool busy;

  /// Saves the name, null to clear it; answers why it was refused, or null
  /// once saved.
  final Future<String?> Function(String? name) onSave;

  /// The server's limit (backend/src/superTabs/personNames.ts).
  static const maxLength = 40;

  @override
  State<SwarmNameEditor> createState() => _SwarmNameEditorState();
}

class _SwarmNameEditorState extends State<SwarmNameEditor> {
  late final _text = TextEditingController(text: widget.name ?? '');
  String? _error;

  /// The last name saved ('' for a clear), until the server's version of it
  /// arrives.
  String? _sent;

  @override
  void didUpdateWidget(SwarmNameEditor old) {
    super.didUpdateWidget(old);
    // A saved name comes back as the server keeps it (one space between
    // words), but never over a newer edit typed while it was on its way.
    final typed = _text.text.trim();
    if (old.name == widget.name) return;
    if (typed == (old.name ?? '') || typed == _sent) {
      _text.text = widget.name ?? '';
    }
    _sent = null;
  }

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  bool get _changed => _text.text.trim() != (widget.name ?? '');

  bool get _can => widget.enabled && !widget.busy && _changed;

  Future<void> _save() async {
    if (!_can) return;
    final typed = _sent = _text.text.trim();
    final error = await widget.onSave(typed.isEmpty ? null : typed);
    if (error != null) _sent = null;
    // Closed, or the Swarm replaced, meanwhile: the answer is for nobody here.
    if (mounted) setState(() => _error = error);
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const SwarmCaption('Name'),
        Row(
          children: [
            Expanded(
              child: TextField(
                key: const ValueKey('swarm-name-field'),
                controller: _text,
                enabled: widget.enabled,
                maxLength: SwarmNameEditor.maxLength,
                textCapitalization: TextCapitalization.words,
                textInputAction: TextInputAction.done,
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
                onChanged: (_) => setState(() => _error = null),
                onSubmitted: (_) => _save(),
              ),
            ),
            const SizedBox(width: AppSpace.s),
            SwarmButton(
              key: const ValueKey('swarm-name-save'),
              label: 'Save',
              style: SwarmButtonStyle.fill,
              busy: widget.busy,
              busyLabel: 'Saving…',
              onPressed: _can ? _save : null,
            ),
          ],
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(
            AppSpace.xs,
            AppSpace.xs,
            AppSpace.xs,
            0,
          ),
          child: Text(
            'Leave empty to show your username.',
            style: AppType.caption(color: AppPalette.textSecondary),
          ),
        ),
        if (_error case final error?)
          Padding(
            padding: const EdgeInsets.fromLTRB(
              AppSpace.xs,
              AppSpace.xs,
              AppSpace.xs,
              0,
            ),
            child: Text(
              error,
              key: const ValueKey('swarm-name-error'),
              style: AppType.caption(color: AppColors.danger),
            ),
          ),
      ],
    );
  }
}
