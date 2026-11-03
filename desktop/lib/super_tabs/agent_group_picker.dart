import 'package:flutter/material.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/services.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../widgets/desktop_chrome.dart';
import 'controller.dart';
import 'model.dart';

/// Chooses a conversation context before opening an agent's existing terminal.
/// Selection is local to this dialog; only Open or a double-click navigates.
class SuperTabAgentGroupPicker extends StatefulWidget {
  const SuperTabAgentGroupPicker({
    super.key,
    required this.controller,
    required this.agentId,
  });

  final SuperTabController controller;
  final String agentId;

  @override
  State<SuperTabAgentGroupPicker> createState() =>
      _SuperTabAgentGroupPickerState();
}

class _SuperTabAgentGroupPickerState extends State<SuperTabAgentGroupPicker> {
  final _listFocus = FocusNode(debugLabel: 'Agent workgroups');
  final _scroll = ScrollController();
  final _rows = <String, GlobalKey>{};
  String? _selectedId;

  List<SuperTabConversation> get _groups {
    final snapshot = widget.controller.snapshot;
    if (widget.controller.accessRevoked ||
        snapshot?.agent(widget.agentId) == null) {
      return const [];
    }
    return snapshot!.conversations
        .where((g) => !g.closed && g.agentIds.contains(widget.agentId))
        .toList();
  }

  @override
  void initState() {
    super.initState();
    final groups = _groups;
    _selectedId = groups.any((g) => g.id == widget.controller.selectedId)
        ? widget.controller.selectedId
        : groups.firstOrNull?.id;
    widget.controller.addListener(_changed);
    _revealSelection();
  }

  void _changed() {
    if (!mounted) return;
    setState(() {
      // Never silently replace a choice that lost membership while open.
      if (!_groups.any((g) => g.id == _selectedId)) _selectedId = null;
    });
  }

  @override
  void dispose() {
    widget.controller.removeListener(_changed);
    _listFocus.dispose();
    _scroll.dispose();
    super.dispose();
  }

  bool _select(String id) {
    if (!_groups.any((g) => g.id == id)) return false;
    setState(() => _selectedId = id);
    _listFocus.requestFocus();
    _revealSelection();
    return true;
  }

  void _revealSelection() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final row = _rows[_selectedId]?.currentContext;
      if (row != null) Scrollable.ensureVisible(row);
    });
  }

  void _open() {
    final selected = _selectedId;
    if (selected != null && _groups.any((g) => g.id == selected)) {
      Navigator.pop(context, selected);
    }
  }

  KeyEventResult _onKey(FocusNode node, KeyEvent event) {
    if (event is! KeyDownEvent && event is! KeyRepeatEvent) {
      return KeyEventResult.ignored;
    }
    final key = event.logicalKey;
    if (key == LogicalKeyboardKey.enter ||
        key == LogicalKeyboardKey.numpadEnter) {
      if (event is KeyDownEvent) _open();
      return KeyEventResult.handled;
    }
    if (key != LogicalKeyboardKey.arrowUp &&
        key != LogicalKeyboardKey.arrowDown) {
      return KeyEventResult.ignored;
    }
    final groups = _groups;
    if (groups.isNotEmpty) {
      final index = groups.indexWhere((g) => g.id == _selectedId);
      final up = key == LogicalKeyboardKey.arrowUp;
      final next = index < 0
          ? (up ? groups.length - 1 : 0)
          : (index + (up ? -1 : 1)).clamp(0, groups.length - 1);
      _select(groups[next].id);
    }
    return KeyEventResult.handled;
  }

  Widget _row(SuperTabConversation group) {
    final snapshot = widget.controller.snapshot!;
    final selected = group.id == _selectedId;
    final project = snapshot.projectFor(group.id);
    final label = snapshot.isProjectLead(group.id)
        ? snapshot.coordinatorNameOf(group.projectId)
        : group.label;
    final ink = selected ? DesktopChrome.onSelection : DesktopChrome.foreground;
    return Padding(
      key: _rows.putIfAbsent(group.id, GlobalKey.new),
      padding: const EdgeInsets.only(bottom: 4),
      child: Semantics(
        selected: selected,
        inMutuallyExclusiveGroup: true,
        child: Material(
          color: selected ? DesktopChrome.activeSelection : Colors.transparent,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
            side: BorderSide(
              width: grid.AppDesktop.focusWidth,
              color: selected && _listFocus.hasFocus
                  ? DesktopChrome.onSelection
                  : Colors.transparent,
            ),
          ),
          clipBehavior: Clip.antiAlias,
          child: Listener(
            // Double-click recognition waits before dispatching onTap. Select
            // immediately, so a quick click on Open never uses the old row.
            onPointerDown: (event) {
              if (event.buttons == kPrimaryMouseButton) _select(group.id);
            },
            child: InkWell(
              key: ValueKey('super-agent-group-${group.id}'),
              canRequestFocus: false,
              mouseCursor: SystemMouseCursors.click,
              hoverColor: ink.withValues(alpha: .08),
              onTap: () => _select(group.id),
              onDoubleTap: () {
                if (_select(group.id)) _open();
              },
              child: Padding(
                padding: const EdgeInsets.symmetric(
                  horizontal: 12,
                  vertical: 10,
                ),
                child: Row(
                  children: [
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            label,
                            style: DesktopChrome.text(color: ink, medium: true),
                          ),
                          if (project != null) ...[
                            const SizedBox(height: 2),
                            Text(
                              project.name,
                              style: DesktopChrome.metadata(
                                color: selected
                                    ? DesktopChrome.selectionDetail
                                    : DesktopChrome.muted,
                              ),
                            ),
                          ],
                        ],
                      ),
                    ),
                    const SizedBox(width: 12),
                    SizedBox(
                      width: AppIcons.inlineSize,
                      child: selected
                          ? Icon(
                              AppIcons.check,
                              size: AppIcons.inlineSize,
                              color: ink,
                            )
                          : null,
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final groups = _groups;
    final available = groups.any((g) => g.id == _selectedId);
    return Dialog(
      backgroundColor: Colors.transparent,
      elevation: 0,
      shape: DesktopChrome.bareDialogShape,
      child: DesktopDialogSurface(
        child: SizedBox(
          width: grid.AppDesktop.formWidth,
          child: Padding(
            padding: const EdgeInsets.all(DesktopChrome.panelPadding),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                DesktopDialogHeader(
                  title:
                      'Open ${widget.controller.snapshot?.agentName(widget.agentId) ?? 'agent'}',
                  detail: 'Choose a workgroup to open its terminal.',
                  padding: EdgeInsets.zero,
                ),
                const SizedBox(height: DesktopChrome.groupGap),
                Flexible(
                  child: ConstrainedBox(
                    constraints: const BoxConstraints(maxHeight: 320),
                    child: Focus(
                      key: const ValueKey('super-agent-group-list'),
                      focusNode: _listFocus,
                      autofocus: true,
                      onFocusChange: (_) => setState(() {}),
                      onKeyEvent: _onKey,
                      child: Scrollbar(
                        controller: _scroll,
                        child: SingleChildScrollView(
                          controller: _scroll,
                          child: groups.isEmpty
                              ? Text(
                                  'No available workgroups for this agent.',
                                  style: DesktopChrome.text(),
                                )
                              : Column(
                                  crossAxisAlignment:
                                      CrossAxisAlignment.stretch,
                                  children: groups.map(_row).toList(),
                                ),
                        ),
                      ),
                    ),
                  ),
                ),
                const SizedBox(height: DesktopChrome.groupGap),
                OverflowBar(
                  alignment: MainAxisAlignment.end,
                  spacing: DesktopChrome.controlGap,
                  overflowSpacing: DesktopChrome.controlGap,
                  children: [
                    TextButton(
                      key: const ValueKey('super-agent-group-cancel'),
                      onPressed: () => Navigator.pop(context),
                      child: const Text('Cancel'),
                    ),
                    FilledButton(
                      key: const ValueKey('super-agent-group-open'),
                      onPressed: available ? _open : null,
                      child: const Text('Open'),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
