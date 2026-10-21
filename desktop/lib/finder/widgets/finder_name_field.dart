import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:path/path.dart' as p;

import '../../shared/theme/app_icons.dart';
import '../../shared/theme/app_theme.dart' as grid;
import '../../theme/app_theme.dart';
import 'finder_row.dart';

/// The name typed in place in the tree — a new file, a new folder, or a
/// rename — the way Orca's explorer takes it: ↵ commits, Esc or leaving
/// cancels, and a refusal stays beside the field until the name changes.
class FinderNameField extends StatefulWidget {
  const FinderNameField({
    super.key,
    required this.depth,
    required this.icon,
    required this.onSubmit,
    required this.onCancel,
    this.initial = '',
  });

  final int depth;
  final IconData icon;
  final String initial;

  /// Answers why the name was refused, or null when it was taken.
  final Future<String?> Function(String name) onSubmit;
  final VoidCallback onCancel;

  @override
  State<FinderNameField> createState() => _FinderNameFieldState();
}

class _FinderNameFieldState extends State<FinderNameField> {
  late final _text = TextEditingController(text: widget.initial)
    // A rename selects the name, not its extension, as Finder does.
    ..selection = TextSelection(
      baseOffset: 0,
      extentOffset: p.basenameWithoutExtension(widget.initial).length,
    );
  final _focus = FocusNode();
  String? _error;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _focus.addListener(() {
      if (!_focus.hasFocus && !_busy) widget.onCancel();
    });
    WidgetsBinding.instance.addPostFrameCallback((_) => _focus.requestFocus());
  }

  @override
  void dispose() {
    _text.dispose();
    _focus.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    _busy = true;
    final error = await widget.onSubmit(_text.text);
    if (!mounted) return;
    _busy = false;
    setState(() => _error = error);
    if (error != null) _focus.requestFocus();
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return Padding(
      padding: EdgeInsets.only(
        left: 8 + (widget.depth + 1) * FinderRow.indentStep,
        right: 8,
      ),
      child: Row(
        children: [
          Icon(widget.icon, size: 14, color: AppColors.mutedStrong),
          const SizedBox(width: 6),
          Expanded(
            child: CallbackShortcuts(
              bindings: {
                const SingleActivator(LogicalKeyboardKey.escape):
                    widget.onCancel,
              },
              child: TextField(
                key: const ValueKey('finder-name-field'),
                controller: _text,
                focusNode: _focus,
                onSubmitted: (_) => _submit(),
                onChanged: (_) => setState(() => _error = null),
                style: grid.AppType.label(color: AppColors.text),
                decoration: InputDecoration(
                  isDense: true,
                  contentPadding: const EdgeInsets.symmetric(
                    horizontal: 6,
                    vertical: 4,
                  ),
                  border: OutlineInputBorder(
                    borderSide: BorderSide(
                      color: _error == null
                          ? AppColors.accent
                          : AppColors.danger,
                    ),
                  ),
                  suffixIconConstraints: const BoxConstraints(),
                  suffixIcon: _error == null
                      ? null
                      : Tooltip(
                          message: _error,
                          child: Padding(
                            padding: const EdgeInsets.only(right: 6),
                            child: Icon(
                              AppIcons.circleAlert,
                              key: const ValueKey('finder-name-error'),
                              size: 13,
                              color: AppColors.danger,
                            ),
                          ),
                        ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
