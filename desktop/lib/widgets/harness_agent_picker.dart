import 'package:harness/shared/theme/app_icons.dart';
import 'package:flutter/material.dart';

import '../shared/widgets/app_menu.dart';
import '../theme/app_theme.dart';
import 'engine_identity.dart';
import 'transient_menus.dart';

/// The collection's agent. Models and permissions remain in its real terminal.
class HarnessAgentPicker extends StatefulWidget {
  const HarnessAgentPicker({
    super.key,
    required this.engine,
    required this.onSelected,
    this.busy = false,
    this.engines = const ['opencode', 'codex', 'claude'],
    this.compact = false,
    this.showPrefix = true,
    this.triggerKey,
  });

  final String? engine;
  final ValueChanged<String>? onSelected;
  final bool busy;
  final List<String> engines;
  final bool compact, showPrefix;
  final Key? triggerKey;

  static String label(String engine) =>
      engine == 'claude' ? 'Claude Code' : engineIdentity(engine).label;

  @override
  State<HarnessAgentPicker> createState() => _HarnessAgentPickerState();
}

class _HarnessAgentPickerState extends State<HarnessAgentPicker> {
  final _menu = MenuController();
  final _trigger = FocusNode();
  final _choices = <String, FocusNode>{};
  FocusNode _choice(String engine) =>
      _choices.putIfAbsent(engine, FocusNode.new);
  VoidCallback? _unregister;

  @override
  void dispose() {
    _unregister?.call();
    _trigger.dispose();
    for (final focus in _choices.values) {
      focus.dispose();
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Row(
    mainAxisSize: MainAxisSize.min,
    children: [
      if (widget.showPrefix)
        Text(
          'Powered by',
          style: Theme.of(context).textTheme.bodySmall
              ?.copyWith(color: AppColors.textSoft),
        ),
      if (widget.showPrefix) const SizedBox(width: 4),
      MenuAnchor(
        controller: _menu,
        childFocusNode: _trigger,
        onOpen: () {
          _unregister = registerTransientMenu(_menu.close);
          WidgetsBinding.instance.addPostFrameCallback((_) {
            if (mounted && _menu.isOpen) {
              _choice(
                widget.engines.contains(widget.engine)
                    ? widget.engine!
                    : widget.engines.first,
              ).requestFocus();
            }
          });
        },
        onClose: () {
          _unregister?.call();
          _unregister = null;
        },
        menuChildren: [
          for (final choice in widget.engines)
            AppMenuItem(
              label: HarnessAgentPicker.label(choice),
              leading: EngineMark(engine: choice),
              selected: widget.engine == choice,
              focusNode: _choice(choice),
              onPressed: () {
                _menu.close();
                widget.onSelected?.call(choice);
              },
            ),
        ],
        builder: (context, controller, child) => TextButton(
          key: widget.triggerKey ?? const ValueKey('harness-agent-picker'),
          style: TextButton.styleFrom(
            minimumSize: Size.zero,
            padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 5),
          ),
          focusNode: _trigger,
          onPressed: widget.busy || widget.onSelected == null
              ? null
              : () =>
                    controller.isOpen ? controller.close() : controller.open(),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (widget.engine != null) ...[
                EngineMark(engine: widget.engine, size: 16),
                if (!widget.compact) const SizedBox(width: 7),
              ],
              if (!widget.compact)
                Text(
                  widget.busy
                      ? 'Opening…'
                      : widget.engine == null
                      ? 'Choose agent'
                      : HarnessAgentPicker.label(widget.engine!),
                ),
              const SizedBox(width: 4),
              const Icon(AppIcons.chevronDown, size: 16),
            ],
          ),
        ),
      ),
    ],
  );
}
