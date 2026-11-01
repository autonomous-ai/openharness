import 'package:flutter/material.dart';

import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/app_type.dart';
import 'package:harness_mobile/theme/app_theme.dart' show AppColors;

import 'swarm_style.dart';

/// The reader's username: the field, Save, and why a name was refused (taken,
/// or not one a username can be), said under the field it is about — the
/// desktop's `SuperTabUsernameEditor` in the phone's own way.
class SwarmUsernameEditor extends StatefulWidget {
  const SwarmUsernameEditor({
    super.key,
    required this.username,
    required this.enabled,
    required this.busy,
    required this.onSave,
  });

  final String username;

  /// The person may change it now: off while another change is saving, and
  /// for a reader who is no longer in the Swarm.
  final bool enabled;

  /// This field's own Save is on its way.
  final bool busy;

  /// Saves the name; answers why it was refused, or null once saved.
  final Future<String?> Function(String username) onSave;

  @override
  State<SwarmUsernameEditor> createState() => _SwarmUsernameEditorState();
}

class _SwarmUsernameEditorState extends State<SwarmUsernameEditor> {
  late final _text = TextEditingController(text: widget.username);
  String? _error;

  /// The last name saved, until the server's version of it arrives.
  String? _sent;

  @override
  void didUpdateWidget(SwarmUsernameEditor old) {
    super.didUpdateWidget(old);
    // A saved name comes back as the server keeps it (lowercased), but never
    // over a newer edit typed while it was on its way.
    final typed = _text.text.trim();
    if (old.username == widget.username) return;
    if (typed == old.username || typed == _sent) _text.text = widget.username;
    _sent = null;
  }

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  bool get _changed {
    final typed = _text.text.trim();
    return typed.isNotEmpty && typed != widget.username;
  }

  bool get _can => widget.enabled && !widget.busy && _changed;

  Future<void> _save() async {
    if (!_can) return;
    final error = await widget.onSave(_sent = _text.text.trim());
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
        const SwarmCaption('Username'),
        Row(
          children: [
            Expanded(
              child: TextField(
                key: const ValueKey('swarm-username-field'),
                controller: _text,
                enabled: widget.enabled,
                maxLength: 32,
                autocorrect: false,
                enableSuggestions: false,
                textCapitalization: TextCapitalization.none,
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
              key: const ValueKey('swarm-username-save'),
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
            'How people see and tag you in this Swarm.',
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
              key: const ValueKey('swarm-username-error'),
              style: AppType.caption(color: AppColors.danger),
            ),
          ),
      ],
    );
  }
}
