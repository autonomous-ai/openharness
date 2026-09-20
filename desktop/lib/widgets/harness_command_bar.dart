import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../state/command_bar.dart';

class HarnessCommandBar extends StatefulWidget {
  const HarnessCommandBar({
    super.key,
    required this.controller,
    required this.focusNode,
    required this.onNew,
    required this.onStore,
    this.compact = false,
    this.onDismiss,
  });
  final CommandBarController controller;
  final FocusNode focusNode;
  final VoidCallback onNew, onStore;
  final bool compact;
  final VoidCallback? onDismiss;

  @override
  State<HarnessCommandBar> createState() => _HarnessCommandBarState();
}

class _HarnessCommandBarState extends State<HarnessCommandBar> {
  late final _text = TextEditingController(text: widget.controller.query);
  bool _findOnly = false, _showWatches = false;
  final _rowKeys = <String, GlobalKey>{};
  int _lastSelected = 0;
  CommandBarController get controller => widget.controller;

  @override
  void initState() {
    super.initState();
    controller.addListener(_changed);
  }

  @override
  void didUpdateWidget(HarnessCommandBar oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.controller != controller) {
      oldWidget.controller.removeListener(_changed);
      controller.addListener(_changed);
      _changed();
    }
  }

  void _changed() {
    final selectionMoved = _lastSelected != controller.selected;
    _lastSelected = controller.selected;
    final ids = controller.rows.map((row) => row.id).toSet();
    _rowKeys.removeWhere((id, _) => !ids.contains(id));
    if (_text.text != controller.query) {
      _text.value = TextEditingValue(
        text: controller.query,
        selection: TextSelection.collapsed(offset: controller.query.length),
      );
    }
    if (mounted) setState(() {});
    if (selectionMoved && controller.rows.isNotEmpty) {
      final id = controller.rows[controller.selected].id;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        final row = _rowKeys[id]?.currentContext;
        if (mounted && row != null) {
          unawaited(Scrollable.ensureVisible(row, alignment: .5));
        }
      });
    }
  }

  @override
  void dispose() {
    controller.removeListener(_changed);
    _text.dispose();
    super.dispose();
  }

  void _submit() {
    if (controller.busy) return;
    if (controller.phase == CommandPhase.choosing &&
        controller.rows.isNotEmpty) {
      unawaited(controller.choose(controller.rows[controller.selected]));
      return;
    }
    if (_findOnly) {
      controller.edit(_text.text);
      unawaited(controller.find());
    } else {
      unawaited(controller.submit(_text.text));
    }
  }

  void _example(String text) {
    controller.edit(text);
    widget.focusNode.requestFocus();
  }

  KeyEventResult _key(FocusNode node, KeyEvent event) {
    if (_text.value.composing.isValid && !_text.value.composing.isCollapsed) {
      return KeyEventResult.ignored;
    }
    if (event is! KeyDownEvent && event is! KeyRepeatEvent) {
      return KeyEventResult.ignored;
    }
    if (HardwareKeyboard.instance.isMetaPressed ||
        HardwareKeyboard.instance.isControlPressed ||
        HardwareKeyboard.instance.isAltPressed) {
      return KeyEventResult.ignored;
    }
    if (event.logicalKey == LogicalKeyboardKey.escape) {
      if (controller.phase != CommandPhase.executing) {
        controller.dismiss();
        setState(() => _showWatches = false);
        if (widget.onDismiss case final dismiss?) {
          dismiss();
        } else {
          widget.focusNode.unfocus();
        }
      }
      return KeyEventResult.handled;
    }
    if (event.logicalKey == LogicalKeyboardKey.arrowDown ||
        event.logicalKey == LogicalKeyboardKey.arrowUp) {
      if (controller.rows.isEmpty) return KeyEventResult.ignored;
      controller.move(
        event.logicalKey == LogicalKeyboardKey.arrowDown ? 1 : -1,
      );
      return KeyEventResult.handled;
    }
    if (event.logicalKey == LogicalKeyboardKey.enter &&
        controller.phase == CommandPhase.choosing &&
        controller.rows.isNotEmpty) {
      unawaited(controller.choose(controller.rows[controller.selected]));
      return KeyEventResult.handled;
    }
    return KeyEventResult.ignored;
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final showPanel =
        controller.busy ||
        controller.error != null ||
        controller.rows.isNotEmpty ||
        controller.message.isNotEmpty;
    return Focus(
      onKeyEvent: _key,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          LayoutBuilder(
            builder: (context, constraints) {
              final narrow = constraints.maxWidth < 520;
              return Material(
                color: grid.AppPalette.commandField,
                elevation: widget.compact ? 0 : 5,
                shadowColor: Colors.black26,
                shape: const StadiumBorder(),
                child: Padding(
                  padding: EdgeInsets.symmetric(
                    horizontal: narrow ? 8 : 12,
                    vertical: widget.compact ? 3 : 7,
                  ),
                  child: Row(
                    children: [
                      PopupMenuButton<String>(
                        tooltip: 'Create or explore',
                        icon: const Icon(
                          Icons.add,
                          color: grid.AppPalette.commandInk,
                          size: 24,
                        ),
                        onSelected: (value) =>
                            value == 'new' ? widget.onNew() : widget.onStore(),
                        itemBuilder: (_) => const [
                          PopupMenuItem(
                            value: 'new',
                            child: Text('New harness'),
                          ),
                          PopupMenuItem(
                            value: 'store',
                            child: Text('Explore harnesses'),
                          ),
                        ],
                      ),
                      Expanded(
                        child: TextField(
                          key: const ValueKey('jev-command-input'),
                          controller: _text,
                          focusNode: widget.focusNode,
                          enabled: controller.phase != CommandPhase.executing,
                          autofocus: !widget.compact,
                          maxLength: 2000,
                          style: TextStyle(
                            fontSize: widget.compact ? 14 : 17,
                            color: grid.AppPalette.commandInk,
                          ),
                          cursorColor: grid.AppPalette.commandInk,
                          decoration: InputDecoration(
                            isDense: true,
                            filled: false,
                            counterText: '',
                            hintText: narrow
                                ? 'Ask Harness…'
                                : 'Ask, find, or make something happen',
                            hintStyle: TextStyle(
                              fontSize: widget.compact ? 14 : 17,
                              color: grid.AppPalette.commandMuted,
                            ),
                            border: InputBorder.none,
                            enabledBorder: InputBorder.none,
                            focusedBorder: InputBorder.none,
                            contentPadding: const EdgeInsets.symmetric(
                              vertical: 15,
                              horizontal: 6,
                            ),
                          ),
                          onChanged: controller.edit,
                          // Keep keyboard ownership while an action preview is being chosen.
                          onEditingComplete: () {},
                          onSubmitted: (_) => _submit(),
                        ),
                      ),
                      if (controller.busy &&
                          controller.phase != CommandPhase.executing)
                        IconButton(
                          onPressed: controller.dismiss,
                          tooltip: 'Cancel command',
                          icon: const Icon(
                            Icons.close,
                            color: grid.AppPalette.commandMuted,
                            size: 19,
                          ),
                        ),
                      if (!narrow)
                        PopupMenuButton<bool>(
                          tooltip: 'Command mode',
                          initialValue: _findOnly,
                          onSelected: (find) =>
                              setState(() => _findOnly = find),
                          itemBuilder: (_) => const [
                            PopupMenuItem(
                              value: false,
                              child: Text('Auto — choose an action'),
                            ),
                            PopupMenuItem(
                              value: true,
                              child: Text('Find — search recent activity'),
                            ),
                          ],
                          child: Container(
                            padding: const EdgeInsets.symmetric(
                              horizontal: 13,
                              vertical: 10,
                            ),
                            decoration: const ShapeDecoration(
                              color: grid.AppPalette.commandChip,
                              shape: StadiumBorder(),
                            ),
                            child: Row(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                Icon(
                                  _findOnly
                                      ? Icons.search
                                      : Icons.auto_awesome_outlined,
                                  size: 17,
                                  color: grid.AppPalette.commandInk,
                                ),
                                const SizedBox(width: 7),
                                Text(
                                  _findOnly ? 'Find' : 'Auto',
                                  style: const TextStyle(
                                    fontSize: 13,
                                    fontWeight: FontWeight.w500,
                                    color: grid.AppPalette.commandInk,
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ),
                      const SizedBox(width: 5),
                      IconButton(
                        key: const ValueKey('jev-submit'),
                        onPressed: controller.busy ? null : _submit,
                        tooltip: 'Run command',
                        icon: controller.busy
                            ? const SizedBox.square(
                                dimension: 18,
                                child: CircularProgressIndicator(
                                  strokeWidth: 2,
                                  color: grid.AppPalette.commandMuted,
                                ),
                              )
                            : const Icon(
                                Icons.arrow_upward_rounded,
                                size: 22,
                                color: grid.AppPalette.commandInk,
                              ),
                      ),
                    ],
                  ),
                ),
              );
            },
          ),
          if (showPanel) ...[const SizedBox(height: 10), _results()],
          if (!widget.compact || watchesVisible) ...[
            const SizedBox(height: 12),
            SizedBox(
              width: double.infinity,
              child: Wrap(
                alignment: WrapAlignment.spaceBetween,
                crossAxisAlignment: WrapCrossAlignment.center,
                spacing: 16,
                runSpacing: 6,
                children: [
                  if (!widget.compact) ...[
                    Tooltip(
                      message: 'When you submit, your request and short session excerpts go to JEV through OpenRouter. Typing stays on this computer.',
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Icon(
                            Icons.auto_awesome,
                            size: 12,
                            color: grid.AppPalette.textFaint,
                          ),
                          const SizedBox(width: 6),
                          Text(
                            'JEV · OpenRouter',
                            style: TextStyle(
                              fontSize: 11,
                              color: grid.AppPalette.textFaint,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ],
                  if (watchesVisible)
                    TextButton.icon(
                      key: const ValueKey('jev-watches'),
                      onPressed: () =>
                          setState(() => _showWatches = !_showWatches),
                      icon: Badge(
                        isLabelVisible: controller.watchMatches > 0,
                        label: Text('${controller.watchMatches}'),
                        child: const Icon(
                          Icons.notifications_active_outlined,
                          size: 14,
                        ),
                      ),
                      label: Text(
                        '${controller.watches.length} ${controller.watches.length == 1 ? 'watch' : 'watches'}',
                      ),
                      style: TextButton.styleFrom(
                        foregroundColor: grid.AppPalette.textSecondary,
                        textStyle: const TextStyle(fontSize: 11),
                      ),
                    ),
                  if (!widget.compact && !watchesVisible)
                    Text(
                      '⌘⇧J · toggle   Esc · close',
                      style: TextStyle(
                        fontSize: 11,
                        color: grid.AppPalette.textFaint,
                      ),
                    ),
                ],
              ),
            ),
          ],
          if (_showWatches && watchesVisible) _watches(),
        ],
      ),
    );
  }

  bool get watchesVisible => controller.watches.isNotEmpty;

  Widget _results() => Material(
    key: const ValueKey('jev-results'),
    color: grid.AppPalette.panelBg,
    shape: RoundedRectangleBorder(
      borderRadius: BorderRadius.circular(20),
      side: BorderSide(color: grid.AppPalette.divider),
    ),
    clipBehavior: Clip.antiAlias,
    child: ConstrainedBox(
      constraints: BoxConstraints(maxHeight: widget.compact ? 340 : 390),
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: [
            Row(
              children: [
                Icon(
                  controller.phase == CommandPhase.done &&
                          controller.error == null
                      ? Icons.check_circle_outline
                      : Icons.auto_awesome_outlined,
                  size: 15,
                  color: grid.AppPalette.swarmAccent,
                ),
                const SizedBox(width: 9),
                Expanded(
                  child: Semantics(
                    liveRegion: true,
                    child: Text(
                      controller.message,
                      style: TextStyle(
                        fontSize: 12,
                        color: grid.AppPalette.textSecondary,
                      ),
                    ),
                  ),
                ),
                if (controller.elapsedMs != null)
                  Text(
                    '${(controller.elapsedMs! / 1000).toStringAsFixed(1)}s',
                    style: TextStyle(
                      fontSize: 11,
                      color: grid.AppPalette.textFaint,
                    ),
                  ),
                IconButton(
                  visualDensity: VisualDensity.compact,
                  onPressed: controller.phase == CommandPhase.executing
                      ? null
                      : controller.dismiss,
                  tooltip: 'Dismiss results',
                  icon: const Icon(Icons.close, size: 15),
                ),
              ],
            ),
            if (controller.error != null)
              Padding(
                padding: const EdgeInsets.fromLTRB(24, 2, 6, 12),
                child: Semantics(
                  liveRegion: true,
                  child: Text(
                    controller.error!,
                    style: TextStyle(
                      fontSize: 12,
                      height: 1.5,
                      color: grid.AppPalette.textPrimary,
                    ),
                  ),
                ),
              ),
            for (var i = 0; i < controller.rows.length; i++)
              _result(controller.rows[i], i),
            if (controller.semanticResults && !controller.busy)
              Align(
                alignment: Alignment.centerLeft,
                child: TextButton.icon(
                  key: const ValueKey('jev-watch-results'),
                  onPressed: () {
                    unawaited(controller.startWatch());
                    setState(() => _showWatches = true);
                  },
                  icon: const Icon(Icons.notifications_none, size: 16),
                  label: const Text('Watch for this'),
                ),
              ),
            if (controller.rows.isEmpty &&
                !controller.busy &&
                controller.phase == CommandPhase.choosing)
              Wrap(
                spacing: 6,
                children: [
                  TextButton(
                    onPressed: () =>
                        _example('Show me sessions that need a review'),
                    child: const Text('Find work'),
                  ),
                  TextButton(
                    onPressed: widget.onNew,
                    child: const Text('New harness'),
                  ),
                ],
              ),
          ],
        ),
      ),
    ),
  );

  Widget _result(CommandBarAction action, int index) {
    final selected = index == controller.selected;
    final preview =
        selected &&
        (action.kind == CommandKind.send ||
            action.kind == CommandKind.create ||
            action.kind == CommandKind.watch);
    return Padding(
      key: _rowKeys.putIfAbsent(action.id, GlobalKey.new),
      padding: const EdgeInsets.only(top: 5),
      child: Material(
        color: selected ? grid.AppPalette.cardBgHover : Colors.transparent,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
        child: InkWell(
          borderRadius: BorderRadius.circular(12),
          onTap: controller.busy
              ? null
              : () {
                  if (action.kind == CommandKind.send ||
                      action.kind == CommandKind.create ||
                      action.kind == CommandKind.watch) {
                    controller.move(index - controller.selected);
                  } else {
                    unawaited(controller.choose(action));
                  }
                },
          child: Padding(
            padding: const EdgeInsets.all(12),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Icon(
                      _icon(action.kind),
                      size: 20,
                      color: grid.AppPalette.textSecondary,
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            action.title,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(
                              fontSize: 14,
                              fontWeight: FontWeight.w500,
                              color: grid.AppPalette.textPrimary,
                            ),
                          ),
                          const SizedBox(height: 4),
                          Text(
                            action.detail,
                            maxLines: 2,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(
                              fontSize: 11,
                              height: 1.4,
                              color: grid.AppPalette.textSecondary,
                            ),
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(width: 8),
                    TextButton(
                      key: ValueKey('jev-action:${action.id}'),
                      onPressed: controller.busy
                          ? null
                          : () => unawaited(controller.choose(action)),
                      child: Text(
                        action.buttonLabel,
                        style: const TextStyle(fontSize: 12),
                      ),
                    ),
                  ],
                ),
                if (preview) ...[
                  const SizedBox(height: 12),
                  Text(
                    '“${controller.query}”',
                    maxLines: 3,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 13,
                      height: 1.5,
                      color: grid.AppPalette.textPrimary,
                    ),
                  ),
                  if (action.kind == CommandKind.watch)
                    Padding(
                      padding: const EdgeInsets.only(top: 8),
                      child: Text(
                        'Current sessions only · checks changed activity once a minute · alerts appear here',
                        style: TextStyle(
                          fontSize: 11,
                          color: grid.AppPalette.textFaint,
                        ),
                      ),
                    ),
                ],
                if (controller.semanticResults && action.context.isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.only(top: 10),
                    child: Text(
                      action.context,
                      maxLines: 4,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 12,
                        height: 1.5,
                        color: grid.AppPalette.textSecondary,
                      ),
                    ),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _watches() => Padding(
    padding: const EdgeInsets.only(top: 8),
    child: Column(
      children: [
        for (final watch in controller.watches)
          Container(
            margin: const EdgeInsets.only(bottom: 8),
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(
              color: grid.AppPalette.panelBg,
              borderRadius: BorderRadius.circular(16),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Icon(
                      Icons.notifications_none,
                      size: 17,
                      color: grid.AppPalette.swarmAccent,
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Text(
                        watch.prompt,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(fontSize: 13),
                      ),
                    ),
                    IconButton(
                      onPressed: () => controller.stopWatch(watch),
                      tooltip: 'Stop watch',
                      icon: const Icon(Icons.close, size: 16),
                    ),
                  ],
                ),
                Text(
                  watch.error ??
                      (watch.checking
                          ? 'Checking recent activity…'
                          : '${watch.matches.length} matches · watching ${watch.scope.length} sessions'),
                  style: TextStyle(
                    fontSize: 11,
                    color: grid.AppPalette.textSecondary,
                  ),
                ),
                if (watch.error != null)
                  TextButton(
                    onPressed: () => controller.resumeWatch(watch),
                    child: const Text('Resume'),
                  ),
                for (final match in watch.matches)
                  TextButton.icon(
                    onPressed: () => unawaited(controller.choose(match)),
                    icon: const Icon(Icons.arrow_forward, size: 14),
                    label: Text(match.title, overflow: TextOverflow.ellipsis),
                  ),
              ],
            ),
          ),
      ],
    ),
  );
}

IconData _icon(CommandKind kind) => switch (kind) {
  CommandKind.open => Icons.terminal_rounded,
  CommandKind.command => Icons.bolt_outlined,
  CommandKind.send => Icons.send_outlined,
  CommandKind.create => Icons.add_circle_outline,
  CommandKind.search => Icons.manage_search,
  CommandKind.watch => Icons.notifications_active_outlined,
};
