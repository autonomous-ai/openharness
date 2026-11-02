import 'dart:async';

import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_dialog.dart';
import '../shortcuts/app_keymap.dart';
import '../shortcuts/keymap.dart';
import '../state/app_state.dart';
import '../widgets/desktop_chrome.dart';
import 'agent_details.dart';
import 'controller.dart';
import 'detail_dialog.dart';
import 'dialog_scope.dart';
import 'identity.dart';
import 'model.dart';
import 'profile_sheet.dart';

const _gap = grid.AppDesktop.controlGap;

/// Native AppKit keys arrive at the workspace even while a modal covers it.
/// Dispatch only to this picker, before the workspace's modal guard.
bool dispatchSwarmQuickSwitcherCommand(String command) {
  final context = FocusManager.instance.primaryFocus?.context;
  final picker = context?.findAncestorStateOfType<_QuickSwitcherState>();
  if (picker == null ||
      !{
        'picker.next',
        'picker.previous',
        'picker.accept',
        'picker.cancel',
      }.contains(command)) {
    return false;
  }
  final composing = picker._query.value.composing;
  if (composing.isValid && !composing.isCollapsed) return true;
  switch (command) {
    case 'picker.next':
      picker._move(1);
    case 'picker.previous':
      picker._move(-1);
    case 'picker.cancel':
      Navigator.of(picker.context).pop();
    case 'picker.accept':
      if (picker._focus.hasFocus) {
        picker._choose();
      } else if (context != null) {
        Actions.maybeInvoke(context, const ActivateIntent());
      }
  }
  return true;
}

/// Chat-only shortcut scope. A nested terminal retains its terminal keymap.
/// History belongs to this window and account, and never writes backend state.
class SuperTabQuickSwitcherScope extends StatefulWidget {
  const SuperTabQuickSwitcherScope({
    super.key,
    required this.app,
    required this.child,
    this.focusNode,
    this.autofocus = false,
  });
  final AppNotifier app;
  final Widget child;
  final FocusNode? focusNode;
  final bool autofocus;

  @override
  State<SuperTabQuickSwitcherScope> createState() =>
      _SuperTabQuickSwitcherScopeState();
}

class _SuperTabQuickSwitcherScopeState
    extends State<SuperTabQuickSwitcherScope> {
  SuperTabController? _controller;
  final _histories = Expando<List<String>>();
  List<String> _recent = [];
  String? _last;
  bool _open = false;

  @override
  void initState() {
    super.initState();
    widget.app.addListener(_changed);
    _changed();
  }

  void _changed() {
    final id = kIsWeb ? null : widget.app.activeSwarm.superTabId;
    final next = id == null ? null : widget.app.superTabs.peek(id);
    if (!identical(next, _controller)) {
      _controller?.removeListener(_visited);
      _controller = next;
      _recent = next == null ? [] : (_histories[next] ??= <String>[]);
      _last = null;
      next?.addListener(_visited);
    }
    _visited();
    if (mounted) setState(() {});
  }

  void _visited() {
    final c = _controller;
    if (c == null) return;
    _recent.removeWhere((id) => !_readable(c, c.snapshot?.conversation(id)));
    if (c.devicesSelected ||
        !_readable(c, c.selected) ||
        _last == c.selectedId) {
      return;
    }
    _last = c.selectedId;
    _recent.remove(c.selectedId);
    _recent.insert(0, c.selectedId);
    if (_recent.length > 50) _recent.removeLast();
  }

  Future<void> _show() async {
    final c = _controller;
    if (_open || c == null || c.accessRevoked || c.snapshot == null) return;
    _open = true;
    final focus = FocusManager.instance.primaryFocus;
    final themes = InheritedTheme.capture(
      from: context,
      to: Navigator.of(context).context,
    );
    final selected = await showAppDialog<_Destination>(
      context: context,
      builder: (context) => themes.wrap(
        FocusScope(
          autofocus: true,
          child: _QuickSwitcher(controller: c, recent: List.of(_recent)),
        ),
      ),
    );
    _open = false;
    if (!mounted || !identical(_controller, c) || c.accessRevoked) return;
    if (selected == null) {
      if (focus?.context?.mounted == true && focus!.canRequestFocus) {
        focus.requestFocus();
      }
      return;
    }
    final current = _destinations(c)
        .where((d) => d.id == selected.id)
        .firstOrNull;
    if (current == null) return;
    if (current.conversation case final group?) {
      if (await c.select(group.id)) c.selectTerminal(group.id, null);
    } else if (current.person case final person?) {
      if (person.id == c.accountId) {
        await showSuperTabProfile(context, c);
      } else {
        await showAppDialog<void>(
          context: context,
          builder: (context) => SuperTabDialogScope(
            controller: c,
            requireWrite: false,
            child: SuperTabDetailDialog(
              title: superTabPersonName(person.email),
              detail:
                  '${person.email} · ${person.role == 'viewer'
                      ? 'Can view'
                      : person.role == 'owner'
                      ? 'Owner'
                      : 'Can collaborate'}',
              leading: SuperTabAvatar.person(
                person,
                size: grid.AppDesktop.identitySize,
              ),
              body: const SizedBox.shrink(),
            ),
          ),
        );
      }
    } else if (current.agent case final agent?) {
      await showSuperTabAgentDetails(context, c, widget.app, agent, (a) {
        final group = c.snapshot?.conversations
            .where((g) => _readable(c, g) && g.agentIds.contains(a.id))
            .firstOrNull;
        if (group != null) {
          unawaited(
            c.select(group.id).then((opened) {
              if (opened) c.selectTerminal(group.id, a.id);
            }),
          );
        }
      });
    }
  }

  @override
  void dispose() {
    widget.app.removeListener(_changed);
    _controller?.removeListener(_visited);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => KeymapRegion(
    contextKind: _controller == null
        ? KeymapContext.workspace
        : KeymapContext.swarmChat,
    actions: _controller == null
        ? null
        : {'swarm.quick_switcher': () => unawaited(_show())},
    child: Focus(
      focusNode: widget.focusNode,
      autofocus: widget.autofocus,
      child: widget.child,
    ),
  );
}

bool _readable(SuperTabController c, SuperTabConversation? g) {
  if (c.accessRevoked || g == null) return false;
  if (c.hiddenByBuddies(g)) return false;
  if (g.isBuddyChat) return g.buddyOwnerId == c.accountId;
  if (g.audience != null && !g.audience!.contains(c.accountId)) return false;
  return c.snapshot?.projects.any((p) => p.id == g.projectId) == true;
}

class _Destination {
  _Destination(
    this.id,
    this.title,
    this.detail, {
    this.conversation,
    this.person,
    this.agent,
    this.unread = false,
  }) : search = '$title $detail'.toLowerCase();
  final String id, title, detail, search;
  final SuperTabConversation? conversation;
  final SuperTabPerson? person;
  final SuperTabAgent? agent;
  final bool unread;
}

List<_Destination> _destinations(SuperTabController c) {
  final s = c.snapshot;
  if (c.accessRevoked || s == null) return [];
  final projects = {for (final p in s.projects) p.id: p};
  return [
    for (final g in s.conversations)
      if (_readable(c, g))
        _Destination(
          'conversation:${g.id}',
          s.isProjectLead(g.id) ? projects[g.projectId]!.name : g.label,
          g.isBuddyChat
              ? 'Your Buddy'
              : s.isProjectLead(g.id)
              ? 'Project chat'
              : projects[g.projectId]?.name ?? '',
          conversation: g,
          unread: c.unread(g),
        ),
    for (final p in s.people)
      _Destination(
        'person:${p.id}',
        superTabPersonName(p.email),
        'Person',
        person: p,
      ),
    for (final a in s.teamAgents)
      if (projects.containsKey(a.projectId))
        _Destination(
          'agent:${a.id}',
          s.agentName(a.id),
          'Agent · ${projects[a.projectId]!.name}',
          agent: a,
        ),
  ];
}

/// Linear subsequence matching: no network reads or quadratic edit distance.
int? _score(_Destination row, String query) {
  if (query.isEmpty) return 0;
  if (row.conversation case final g? when g.closed) {
    final exact = {
      g.title.toLowerCase(),
      g.label.toLowerCase(),
      if (g.number != null) '${g.number}',
      if (g.number != null) '#${g.number}',
    };
    if (!exact.contains(query)) return null;
  }
  if (row.search.contains(query)) {
    return row.title.toLowerCase().startsWith(query) ? 0 : 1;
  }
  var at = 0;
  for (final rune in query.runes.where((r) => r != 32)) {
    at = row.search.indexOf(String.fromCharCode(rune), at);
    if (at < 0) return null;
    at++;
  }
  return 2;
}

class _QuickSwitcher extends StatefulWidget {
  const _QuickSwitcher({required this.controller, required this.recent});
  final SuperTabController controller;
  final List<String> recent;

  @override
  State<_QuickSwitcher> createState() => _QuickSwitcherState();
}

class _QuickSwitcherState extends State<_QuickSwitcher> {
  final _query = TextEditingController();
  final _focus = FocusNode(debugLabel: 'Switch conversation');
  final _scroll = ScrollController();
  List<_Destination> _rows = [];
  String? _selected;
  final _rowKeys = <String, GlobalKey>{};

  @override
  void initState() {
    super.initState();
    _query.addListener(_changed);
    widget.controller.addListener(_changed);
    _update();
  }

  void _update() {
    final query = _query.text.trim().toLowerCase();
    final recent = {
      for (var i = 0; i < widget.recent.length; i++)
        'conversation:${widget.recent[i]}': i,
    };
    final scored = <(_Destination, int)>[];
    for (final row in _destinations(widget.controller)) {
      if (query.isEmpty && row.conversation?.closed == true) continue;
      final score = _score(row, query);
      if (score != null) scored.add((row, score));
    }
    scored.sort((a, b) {
      final order = query.isEmpty
          ? (recent[a.$1.id] ?? 50).compareTo(recent[b.$1.id] ?? 50)
          : a.$2.compareTo(b.$2);
      if (order != 0) return order;
      return a.$1.title.toLowerCase().compareTo(b.$1.title.toLowerCase());
    });
    _rows = scored.map((s) => s.$1).toList();
    if (!_rows.any((r) => r.id == _selected)) _selected = _rows.firstOrNull?.id;
    _rowKeys.removeWhere((id, _) => !_rows.any((r) => r.id == id));
  }

  void _changed() {
    if (!mounted) return;
    setState(_update);
  }

  void _move(int delta) {
    if (_rows.isEmpty) return;
    final at = _rows.indexWhere((r) => r.id == _selected);
    setState(
      () => _selected = _rows[(at + delta).clamp(0, _rows.length - 1)].id,
    );
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final at = _rows.indexWhere((r) => r.id == _selected);
      final row = _rowKeys[_selected]?.currentContext;
      if (row != null) {
        Scrollable.ensureVisible(row, alignment: .5);
      } else if (_scroll.hasClients && at >= 0) {
        // Jump by the measured average extent; the list stays lazy at 500 rows.
        _scroll.jumpTo(
          (_scroll.position.maxScrollExtent *
                  at /
                  (_rows.length - 1).clamp(1, _rows.length))
              .clamp(0, _scroll.position.maxScrollExtent),
        );
      }
    });
  }

  void _choose() {
    final row = _rows.where((r) => r.id == _selected).firstOrNull;
    if (row != null) Navigator.pop(context, row);
  }

  KeyEventResult _key(FocusNode node, KeyEvent event) {
    if (event is KeyUpEvent ||
        (_query.value.composing.isValid &&
            !_query.value.composing.isCollapsed)) {
      return KeyEventResult.ignored;
    }
    if (event.logicalKey == LogicalKeyboardKey.arrowDown) {
      _move(1);
      return KeyEventResult.handled;
    }
    if (event.logicalKey == LogicalKeyboardKey.arrowUp) {
      _move(-1);
      return KeyEventResult.handled;
    }
    if (event.logicalKey == LogicalKeyboardKey.enter ||
        event.logicalKey == LogicalKeyboardKey.numpadEnter) {
      _choose();
      return KeyEventResult.handled;
    }
    return KeyEventResult.ignored;
  }

  @override
  void dispose() {
    widget.controller.removeListener(_changed);
    _query.dispose();
    _focus.dispose();
    _scroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return KeymapRegion(
      contextKind: KeymapContext.picker,
      child: Dialog(
        backgroundColor: Colors.transparent,
        shape: DesktopChrome.bareDialogShape,
        child: SizedBox(
          width: grid.AppDesktop.formWidth,
          height: grid.AppDesktop.formWidth,
          child: DesktopDialogSurface(
            child: Column(
              children: [
                DesktopDialogHeader(
                  title: 'Switch conversation',
                  onClose: () => Navigator.pop(context),
                ),
                Padding(
                  padding: const EdgeInsets.symmetric(
                    horizontal: grid.AppDesktop.panelPadding,
                  ),
                  child: KeymapRegion(
                    contextKind: KeymapContext.picker,
                    composing: () =>
                        _query.value.composing.isValid &&
                        !_query.value.composing.isCollapsed,
                    actions: {
                      'picker.next': () => _move(1),
                      'picker.previous': () => _move(-1),
                      'picker.accept': _choose,
                      'picker.cancel': () => Navigator.pop(context),
                    },
                    child: Focus(
                      onKeyEvent: _key,
                      child: TextField(
                        key: const ValueKey('swarm-quick-query'),
                        controller: _query,
                        focusNode: _focus,
                        autofocus: true,
                        style: grid.AppType.heading(
                          fontWeight: grid.AppFont.regular,
                        ),
                        decoration: const InputDecoration(
                          hintText: 'Find a conversation, person or agent',
                          labelText: 'Search Swarm',
                        ),
                      ),
                    ),
                  ),
                ),
                const SizedBox(height: _gap),
                Expanded(
                  child: _rows.isEmpty
                      ? Center(
                          child: Text(
                            widget.controller.accessRevoked
                                ? 'This Swarm is no longer available.'
                                : 'No matches',
                            style: DesktopChrome.text(),
                          ),
                        )
                      : ListView.builder(
                          controller: _scroll,
                          padding: const EdgeInsets.symmetric(
                            horizontal: grid.AppDesktop.panelPadding,
                          ),
                          itemCount: _rows.length,
                          itemBuilder: (context, i) {
                            final row = _rows[i];
                            final active = row.id == _selected;
                            final ink = active
                                ? grid.AppDesktop.onSelection
                                : DesktopChrome.foreground;
                            return KeyedSubtree(
                              key: _rowKeys.putIfAbsent(row.id, GlobalKey.new),
                              child: Semantics(
                                button: true,
                                selected: active,
                                liveRegion: active,
                                label:
                                    '${row.title}, ${row.detail}${row.unread ? ', unread' : ''}',
                                excludeSemantics: true,
                                onTap: () => Navigator.pop(context, row),
                                child: Material(
                                  color: active
                                      ? grid.AppDesktop.selection
                                      : Colors.transparent,
                                  borderRadius: BorderRadius.circular(
                                    grid.AppDesktop.rowRadius,
                                  ),
                                  child: InkWell(
                                    key: ValueKey('swarm-quick-${row.id}'),
                                    borderRadius: BorderRadius.circular(
                                      grid.AppDesktop.rowRadius,
                                    ),
                                    mouseCursor: SystemMouseCursors.click,
                                    onTap: () => Navigator.pop(context, row),
                                    onHover: (hover) {
                                      if (hover && _selected != row.id) {
                                        setState(() => _selected = row.id);
                                      }
                                    },
                                    child: Padding(
                                      padding: const EdgeInsets.all(_gap),
                                      child: Row(
                                        children: [
                                          if (row.person case final p?) ...[
                                            SuperTabAvatar.person(
                                              p,
                                              size:
                                                  grid.AppDesktop.identitySize,
                                            ),
                                            const SizedBox(width: _gap),
                                          ],
                                          if (row.agent case final a?) ...[
                                            SuperTabAvatar.agent(
                                              a,
                                              name: row.title,
                                              size:
                                                  grid.AppDesktop.identitySize,
                                            ),
                                            const SizedBox(width: _gap),
                                          ],
                                          Expanded(
                                            child: Column(
                                              crossAxisAlignment:
                                                  CrossAxisAlignment.start,
                                              children: [
                                                Text(
                                                  row.title,
                                                  maxLines: 1,
                                                  overflow:
                                                      TextOverflow.ellipsis,
                                                  style: grid.AppType.body(
                                                    color: ink,
                                                    fontWeight: row.unread
                                                        ? grid.AppFont.semibold
                                                        : grid.AppFont.regular,
                                                  ),
                                                ),
                                                Text(
                                                  row.detail,
                                                  maxLines: 1,
                                                  overflow:
                                                      TextOverflow.ellipsis,
                                                  style: DesktopChrome.metadata(
                                                    color: active
                                                        ? grid
                                                              .AppDesktop
                                                              .selectionDetail
                                                        : DesktopChrome.muted,
                                                  ),
                                                ),
                                              ],
                                            ),
                                          ),
                                        ],
                                      ),
                                    ),
                                  ),
                                ),
                              ),
                            );
                          },
                        ),
                ),
                Padding(
                  padding: const EdgeInsets.all(grid.AppDesktop.groupGap),
                  child: Text(
                    '↑ ↓ to move · Enter to open · Esc to close',
                    style: DesktopChrome.metadata(),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
