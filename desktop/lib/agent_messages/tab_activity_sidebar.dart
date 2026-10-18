import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';

import '../core/local_key_value_store.dart';
import '../core/open_in_browser.dart';
import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/skeleton.dart';
import '../state/app_state.dart';
import '../widgets/desktop_chrome.dart';
import 'shared_tab_errors.dart';
import 'shared_tab_placement.dart' show plainSharedText, shortSharedText;
import 'shared_tab_tasks.dart';
import 'shared_tabs.dart';
import 'shared_tabs_model.dart';
import 'tab_activity.dart';
import 'task_step.dart';

/// Whether each tab's Tab Activity is open, and its width, on this computer
/// (`tab_activity.open.<tabId>`, `tab_activity.width.<tabId>`). A tab never
/// resized starts at the width last chosen anywhere (`tab_activity.width`),
/// else [defaultWidth].
class TabActivityPrefs extends ChangeNotifier {
  TabActivityPrefs(this.storage);

  final LocalKeyValueStore? storage;

  static const minWidth = 220.0, maxWidth = 480.0, defaultWidth = 280.0;
  static const lastWidthKey = 'tab_activity.width';
  static String openKey(String tabId) => 'tab_activity.open.$tabId';
  static String widthKey(String tabId) => 'tab_activity.width.$tabId';

  final _open = <String, bool>{};
  final _width = <String, double>{};
  final _loads = <String, Future<void>>{};
  double? _lastWidth;
  bool _disposed = false;

  bool isOpen(String tabId) => _open[tabId] ?? false;

  double widthOf(String tabId) => _width[tabId] ?? _lastWidth ?? defaultWidth;

  static double clampWidth(double width) => width.isFinite
      ? width.clamp(minWidth, maxWidth).toDouble()
      : defaultWidth;

  /// Reads [tabId]'s saved state once. A choice made before it lands wins.
  Future<void> load(String tabId) => _loads[tabId] ??= _load(tabId);

  Future<void> _load(String tabId) async {
    final store = storage;
    if (store == null) return;
    Map<String, String?> values;
    try {
      values = await store.readMany([
        openKey(tabId),
        widthKey(tabId),
        lastWidthKey,
      ]);
    } catch (_) {
      return; // unreadable: closed, at the default width
    }
    if (_disposed) return;
    var changed = false;
    if (!_open.containsKey(tabId) && values[openKey(tabId)] == '1') {
      _open[tabId] = true;
      changed = true;
    }
    final width = double.tryParse(values[widthKey(tabId)] ?? '');
    if (!_width.containsKey(tabId) && width != null) {
      _width[tabId] = clampWidth(width);
      changed = true;
    }
    final last = double.tryParse(values[lastWidthKey] ?? '');
    if (_lastWidth == null && last != null) {
      _lastWidth = clampWidth(last);
      changed = true;
    }
    if (changed) notifyListeners();
  }

  void setOpen(String tabId, bool open) {
    if (isOpen(tabId) == open && _open.containsKey(tabId)) return;
    _open[tabId] = open;
    notifyListeners();
    final store = storage;
    if (store == null) return;
    unawaited(
      (open ? store.write(openKey(tabId), '1') : store.delete(openKey(tabId)))
          .catchError((Object _) {}),
    );
  }

  void toggle(String tabId) => setOpen(tabId, !isOpen(tabId));

  /// While dragging: drawn at once, written by [commitWidth].
  void setWidth(String tabId, double width) {
    final next = clampWidth(width);
    if (_width[tabId] == next) return;
    _width[tabId] = next;
    notifyListeners();
  }

  void commitWidth(String tabId) {
    final width = _width[tabId];
    final store = storage;
    if (width == null) return;
    _lastWidth = width;
    if (store == null) return;
    final text = width.toStringAsFixed(0);
    unawaited(store.write(widthKey(tabId), text).catchError((Object _) {}));
    unawaited(store.write(lastWidthKey, text).catchError((Object _) {}));
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}

/// The sidebar at its width with the handle that resizes it; nothing while
/// [deskTabId]'s is closed.
class TabActivityDock extends StatelessWidget {
  const TabActivityDock({
    super.key,
    required this.app,
    required this.deskTabId,
    required this.prefs,
    this.tabName,
  });

  final AppNotifier app;
  final String deskTabId;
  final TabActivityPrefs prefs;
  final String? tabName;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: prefs,
    builder: (context, _) {
      if (!prefs.isOpen(deskTabId)) {
        return const SizedBox.shrink(key: ValueKey('tab-activity-closed'));
      }
      return Row(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          SizedBox(
            width: prefs.widthOf(deskTabId),
            child: TabActivitySidebar(
              key: ValueKey('tab-activity:$deskTabId'),
              app: app,
              deskTabId: deskTabId,
              tabName: tabName,
              onClose: () => prefs.setOpen(deskTabId, false),
            ),
          ),
          _ResizeHandle(
            onDrag: (dx) =>
                prefs.setWidth(deskTabId, prefs.widthOf(deskTabId) + dx),
            onEnd: () => prefs.commitWidth(deskTabId),
          ),
        ],
      );
    },
  );
}

class _ResizeHandle extends StatelessWidget {
  const _ResizeHandle({required this.onDrag, required this.onEnd});

  final ValueChanged<double> onDrag;
  final VoidCallback onEnd;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return Semantics(
      label: 'Resize Tab Activity',
      child: MouseRegion(
        cursor: SystemMouseCursors.resizeColumn,
        child: GestureDetector(
          key: const ValueKey('tab-activity-handle'),
          behavior: HitTestBehavior.opaque,
          dragStartBehavior: DragStartBehavior.down,
          onHorizontalDragUpdate: (d) => onDrag(d.delta.dx),
          onHorizontalDragEnd: (_) => onEnd(),
          child: SizedBox(
            width: 5,
            child: Center(child: Container(width: 1, color: DesktopChrome.rim)),
          ),
        ),
      ),
    );
  }
}

/// Tab Activity: which harness of a tab does what, and how far each of its
/// tasks has got. Summaries, names and titles from other accounts are plain
/// text on one line.
///
/// Reads `tab_activity` when it opens, on a `shared_activity` frame for the
/// tab, when a harness of it goes from working to idle and else every
/// [activityEvery]; the tab's tasks when it opens, on working→idle and every
/// [tasksEvery]. Only while it is open and the window in front: what falls due
/// in the background is read once the window is back.
class TabActivitySidebar extends StatefulWidget {
  const TabActivitySidebar({
    super.key,
    required this.app,
    required this.deskTabId,
    this.tabName,
    this.onClose,
    this.activityEvery = const Duration(seconds: 30),
    this.tasksEvery = const Duration(seconds: 60),
  });

  final AppNotifier app;
  final String deskTabId;
  final String? tabName;
  final VoidCallback? onClose;
  final Duration activityEvery, tasksEvery;

  @override
  State<TabActivitySidebar> createState() => _TabActivitySidebarState();
}

/// One harness row as drawn.
@immutable
class _Harness {
  const _Harness({
    required this.machineId,
    required this.agentId,
    required this.name,
    required this.mark,
    required this.line,
    required this.leader,
    this.owner,
    this.summary = false,
    this.issue,
    this.paneId,
  });

  final String machineId, agentId, name, mark;

  /// The summary, or without one the state or why it waits; null for nothing.
  final String? line;

  /// Whether [line] is the summary (another account's words).
  final bool summary;
  final bool leader;
  final String? owner;
  final int? issue;
  final int? paneId;

  String get key => '$machineId/$agentId';
}

class _TabActivitySidebarState extends State<TabActivitySidebar> {
  AppNotifier get app => widget.app;

  /// The daemon's last answer; null before the first.
  List<TabHarnessActivity>? _rows;

  /// The daemon does not know the tab yet (`NOT_A_TAB`, for up to 15 s after
  /// it was made) or predates `tab_activity`: the tab's panes are listed.
  bool _panesOnly = false;
  String? _error;
  Future<void>? _flight;
  bool _again = false;
  int _generation = 0;
  Timer? _activityTimer, _tasksTimer;
  bool _activityDue = false, _tasksDue = false;
  Set<String> _working = const {};

  /// Harnesses a `shared_activity` frame last said are working.
  final _heardWorking = <String>{};
  bool _harnessesShown = true, _tasksShown = true;

  @override
  void initState() {
    super.initState();
    app.addListener(_appChanged);
    app.foreground.addListener(_foregroundChanged);
    app.sharedTabs.heard.addListener(_heardFrame);
    _start();
  }

  @override
  void didUpdateWidget(TabActivitySidebar old) {
    super.didUpdateWidget(old);
    if (old.deskTabId == widget.deskTabId) return;
    _generation++;
    _heardWorking.clear();
    _rows = null;
    _panesOnly = false;
    _error = null;
    _start();
  }

  void _start() {
    _working = _liveWorking();
    // Not while the tree is building: a read notifies its listeners at once.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      if (app.foreground.value) {
        unawaited(_readActivity());
        _readTasks();
      } else {
        _activityDue = _tasksDue = true;
      }
    });
  }

  @override
  void dispose() {
    _activityTimer?.cancel();
    _tasksTimer?.cancel();
    app.removeListener(_appChanged);
    app.foreground.removeListener(_foregroundChanged);
    app.sharedTabs.heard.removeListener(_heardFrame);
    super.dispose();
  }

  SharedTab? get _shared => app.sharedTabs.tabForDesk(widget.deskTabId);

  /// The id this computer's daemon files the tab's activity under: for another
  /// account's shared tab the roster's, which the member's own desk tab (derived
  /// from it) does not carry; otherwise the desk tab's.
  String get _activityTabId {
    final tab = _shared;
    final me = app.sharedTabs.snapshot.me?.accountId;
    return tab != null && me != null && !tab.ownedBy(me)
        ? tab.sharedTabId
        : widget.deskTabId;
  }

  String get _tasksKey => _shared?.sharedTabId ?? 'tab:${widget.deskTabId}';

  // ---- reading ----

  void _armActivity() {
    _activityTimer?.cancel();
    _activityDue = false;
    _activityTimer = Timer(widget.activityEvery, () {
      _activityTimer = null;
      if (!mounted) return;
      if (app.foreground.value) {
        unawaited(_readActivity());
      } else {
        _activityDue = true;
      }
    });
  }

  void _armTasks() {
    _tasksTimer?.cancel();
    _tasksDue = false;
    _tasksTimer = Timer(widget.tasksEvery, () {
      _tasksTimer = null;
      if (!mounted) return;
      if (app.foreground.value) {
        _readTasks();
      } else {
        _tasksDue = true;
      }
    });
  }

  void _readTasks() {
    _armTasks();
    final shared = _shared;
    unawaited(
      app.sharedTabs.loadTasks(
        _tasksKey,
        tabId: shared == null ? widget.deskTabId : null,
      ),
    );
  }

  /// One read at a time: a call while one runs asks for one more after it.
  Future<void> _readActivity() {
    final running = _flight;
    if (running != null) {
      _again = true;
      return running;
    }
    late final Future<void> flight;
    flight = _readWhileAsked().whenComplete(() {
      if (identical(_flight, flight)) _flight = null;
    });
    return _flight = flight;
  }

  Future<void> _readWhileAsked() async {
    do {
      _again = false;
      await _readOnce();
    } while (_again && mounted);
  }

  Future<void> _readOnce() async {
    if (!mounted) return;
    final generation = _generation;
    _armActivity();
    try {
      final rows = await app.tabActivity.read(_activityTabId);
      if (!mounted || generation != _generation) return;
      setState(() {
        _rows = rows;
        _panesOnly = false;
        _error = null;
      });
    } on SharedTabsFailure catch (e) {
      if (!mounted || generation != _generation) return;
      setState(() {
        switch (e.code) {
          // Not known yet, or a daemon from before Tab Activity: the panes,
          // and the next read asks again. Never an error.
          case 'NOT_A_TAB' ||
              'UNKNOWN_ACTION' ||
              'DAEMON_TOO_OLD' ||
              'UNSUPPORTED':
            _panesOnly = true;
            _error = null;
          default:
            if (_rows == null) _panesOnly = true;
            _error = sharedTabErrorText(e);
        }
      });
    }
    _working = _liveWorking();
  }

  void _foregroundChanged() {
    if (!mounted || !app.foreground.value) return;
    if (_activityDue) unawaited(_readActivity());
    if (_tasksDue) _readTasks();
  }

  void _heardFrame() {
    final frame = app.sharedTabs.heard.value;
    if (!mounted ||
        frame == null ||
        _shared?.sharedTabId != frame.sharedTabId) {
      return;
    }
    // Another account's harness that was working (as a frame or the last read
    // said) going idle: it often just pushed, so the tasks are read too.
    final key = '${frame.machineId}/${frame.agentId}';
    final wasWorking =
        _heardWorking.contains(key) ||
        (_rows ?? const <TabHarnessActivity>[]).any(
          (r) =>
              r.machineId == frame.machineId &&
              r.agentId == frame.agentId &&
              r.state == TabHarnessState.working,
        );
    if (frame.state == 'working') {
      _heardWorking.add(key);
    } else {
      _heardWorking.remove(key);
    }
    final stopped = wasWorking && frame.state == 'idle';
    if (app.foreground.value) {
      unawaited(_readActivity());
      if (stopped) _readTasks();
    } else {
      _activityDue = true;
      if (stopped) _tasksDue = true;
    }
  }

  /// The tab's harnesses working now, as their computers last said.
  Set<String> _liveWorking() {
    final keys = <(String, String)>{
      for (final r in _rows ?? const <TabHarnessActivity>[])
        (r.machineId, r.agentId),
      for (final p in _panes()) (p.machineId, p.agentId!),
    };
    return {
      for (final (m, a) in keys)
        if (app.machineStates[m]?.processingAgentIds.contains(a) == true)
          '$m/$a',
    };
  }

  void _appChanged() {
    if (!mounted) return;
    final now = _liveWorking();
    final stopped = _working.any((k) => !now.contains(k));
    _working = now;
    if (!stopped) return;
    // It often just pushed or opened a pull request.
    if (app.foreground.value) {
      unawaited(_readActivity());
      _readTasks();
    } else {
      _activityDue = _tasksDue = true;
    }
  }

  // ---- what is drawn ----

  Iterable<({String machineId, String? agentId, int id})> _panes() sync* {
    final swarm = app.swarms.where((s) => s.id == widget.deskTabId).firstOrNull;
    for (final p in swarm?.panes ?? const []) {
      if (p.agentId != null) {
        yield (machineId: p.machineId, agentId: p.agentId, id: p.id);
      }
    }
  }

  int? _paneOf(String machineId, String agentId) => _panes()
      .where((p) => p.machineId == machineId && p.agentId == agentId)
      .firstOrNull
      ?.id;

  void _focus(String machineId, String agentId) {
    final pane = _paneOf(machineId, agentId);
    if (pane == null) return;
    if (app.activeSwarmId != widget.deskTabId) {
      app.selectSwarm(widget.deskTabId);
    }
    app.focusPane(pane, reveal: true);
  }

  void _open(String url) => unawaited(openInBrowser(Uri.parse(url)));

  /// The short name of an account in a shared tab: its address before `@`.
  String? _ownerOf(SharedTab tab, String accountId) {
    final me = app.sharedTabs.snapshot.me;
    final member = tab.members
        .where((m) => m.accountId == accountId)
        .firstOrNull;
    final email = accountId == me?.accountId
        ? me!.email
        : accountId == tab.ownerAccountId
        ? tab.ownerEmail
        : member?.email ?? '';
    final local = email.split('@').first;
    final label = local.isNotEmpty ? local : member?.name ?? '';
    return label.isEmpty ? null : shortSharedText(label, 20);
  }

  List<_Harness> _harnessRows(SharedTab? tab, SharedTasks tasks) {
    final source = _panesOnly || _rows == null
        ? [
            for (final p in _panes())
              TabHarnessActivity(
                machineId: p.machineId,
                agentId: p.agentId!,
                state: TabHarnessState.idle,
              ),
          ]
        : _rows!;
    final leader = app.tabLeader(widget.deskTabId);
    final me = app.sharedTabs.snapshot.me;
    final issues = <String, int>{};
    for (final row in tasks.rows) {
      if (row.state != 'open' || row.pr?.state == 'Merged') continue;
      final h = taskAssigneeHarness(app, widget.deskTabId, tab, row.assignee);
      if (h != null) {
        issues.putIfAbsent('${h.machineId}/${h.agentId}', () => row.issue);
      }
    }
    final seen = <String>{};
    final leaders = <_Harness>[], others = <_Harness>[];
    for (final h in source) {
      final key = '${h.machineId}/${h.agentId}';
      if (!seen.add(key)) continue;
      final machine = app.machineStates[h.machineId];
      final own = machine != null && !machine.belongsToOtherAccount;
      final roster = tab?.harnesses
          .where((r) => r.machineId == h.machineId && r.agentId == h.agentId)
          .firstOrNull;
      final agent = machine?.agents.where((a) => a.id == h.agentId).firstOrNull;
      final rawName = agent?.displayName ?? roster?.name ?? '';
      final name = shortSharedText(
        rawName.trim().isEmpty ? h.agentId : rawName,
        40,
      );
      final accountId = own ? me?.accountId : roster?.accountId;
      final owner = tab == null || accountId == null
          ? null
          : _ownerOf(tab, accountId);
      final working =
          machine?.processingAgentIds.contains(h.agentId) == true ||
          (!own && h.state == TabHarnessState.working);
      final isLeader =
          leader != null &&
          leader.machineId == h.machineId &&
          leader.agentId == h.agentId;
      final summary = h.summary == null ? '' : shortSharedText(h.summary!, 120);
      final String mark;
      final String? line;
      var isSummary = false;
      if (h.away) {
        mark = '⚠';
        final ownerName = plainSharedText(machine?.machine.ownerName ?? '');
        final who =
            owner ??
            (ownerName.isEmpty ? null : shortSharedText(ownerName, 20));
        line = own || (accountId != null && accountId == me?.accountId)
            ? 'computer away'
            : 'waiting for ${who ?? 'its owner'}\'s computer';
      } else if (working) {
        mark = '●';
        isSummary = summary.isNotEmpty;
        line = isSummary ? summary : 'working';
      } else {
        mark = '○';
        isSummary = summary.isNotEmpty;
        final known = h.state != TabHarnessState.unknown || own;
        line = isSummary
            ? (known ? 'idle · $summary' : summary)
            : (known ? 'idle' : null);
      }
      final row = _Harness(
        machineId: h.machineId,
        agentId: h.agentId,
        name: name,
        mark: mark,
        line: line,
        summary: isSummary,
        leader: isLeader,
        owner: owner,
        issue: issues[key],
        paneId: _paneOf(h.machineId, h.agentId),
      );
      (isLeader ? leaders : others).add(row);
    }
    return [...leaders, ...others];
  }

  static int _rank(TaskStep step) => switch (step) {
    TaskStep.working => 0,
    TaskStep.workingDraft => 1,
    TaskStep.notStarted => 2,
    TaskStep.buildFailed => 3,
    TaskStep.building => 4,
    TaskStep.waitingForReview => 5,
    TaskStep.prClosed => 6,
    TaskStep.merging => 7,
    TaskStep.merged => 8,
    TaskStep.closed => 9,
  };

  List<
    ({
      SharedTaskRow row,
      TaskStep step,
      ({String machineId, String agentId})? assignee,
    })
  >
  _taskRows(SharedTab? tab, SharedTasks tasks) {
    final now = DateTime.now();
    final rows =
        <
          ({
            int index,
            SharedTaskRow row,
            TaskStep step,
            ({String machineId, String agentId})? assignee,
          })
        >[];
    for (final (index, row) in tasks.rows.indexed) {
      final step = taskStep(
        row,
        assigneeWorking: taskAssigneeWorking(
          app,
          widget.deskTabId,
          tab,
          row.assignee,
        ),
      );
      // A merged task stays for 24 hours after its pull request merged; without
      // that time, after the issue last changed; with neither, it stays.
      final updated = row.pr?.mergedAt ?? row.updatedAt;
      if (step == TaskStep.merged &&
          updated != null &&
          now.difference(updated) > const Duration(hours: 24)) {
        continue;
      }
      rows.add((
        index: index,
        row: row,
        step: step,
        assignee: taskAssigneeHarness(app, widget.deskTabId, tab, row.assignee),
      ));
    }
    rows.sort((a, b) {
      final byStep = _rank(a.step).compareTo(_rank(b.step));
      return byStep != 0 ? byStep : a.index.compareTo(b.index);
    });
    return [
      for (final r in rows) (row: r.row, step: r.step, assignee: r.assignee),
    ];
  }

  static String _stepText(TaskStep step) => switch (step) {
    TaskStep.merged => '${taskStepLabel(step)} ✓',
    TaskStep.buildFailed => '${taskStepLabel(step)} ✗',
    _ => taskStepLabel(step),
  };

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return ListenableBuilder(
      listenable: Listenable.merge([app, app.sharedTabs]),
      builder: (context, _) {
        final tab = _shared;
        final tasks = app.sharedTabs.tasksFor(_tasksKey);
        final swarm = app.swarms
            .where((s) => s.id == widget.deskTabId)
            .firstOrNull;
        final name = plainSharedText(widget.tabName ?? swarm?.name ?? '');
        return Material(
          key: const ValueKey('tab-activity'),
          color: DesktopChrome.surface,
          child: Semantics(
            container: true,
            label: 'Tab Activity',
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                _header(name),
                Expanded(
                  child: LayoutBuilder(
                    builder: (context, constraints) {
                      final width = constraints.maxWidth;
                      return ListView(
                        padding: const EdgeInsets.only(bottom: 12),
                        children: [
                          _section(
                            'Harnesses',
                            _harnessesShown,
                            () => setState(
                              () => _harnessesShown = !_harnessesShown,
                            ),
                          ),
                          if (_harnessesShown)
                            ..._harnessBody(tab, tasks, width),
                          _section(
                            'Tasks',
                            _tasksShown,
                            () => setState(() => _tasksShown = !_tasksShown),
                          ),
                          if (_tasksShown) ..._tasksBody(tab, tasks, width),
                        ],
                      );
                    },
                  ),
                ),
              ],
            ),
          ),
        );
      },
    );
  }

  Widget _header(String name) => Padding(
    padding: const EdgeInsets.fromLTRB(12, 6, 4, 2),
    child: Row(
      children: [
        Expanded(
          child: Text(
            name.isEmpty ? 'TAB ACTIVITY' : 'TAB ACTIVITY · $name',
            maxLines: 1,
            softWrap: false,
            overflow: TextOverflow.ellipsis,
            style: DesktopChrome.metadata().copyWith(
              letterSpacing: .4,
              fontWeight: FontWeight.w600,
            ),
          ),
        ),
        if (widget.onClose != null)
          IconButton(
            key: const ValueKey('tab-activity-close'),
            tooltip: 'Hide Tab Activity',
            onPressed: widget.onClose,
            iconSize: 14,
            visualDensity: VisualDensity.compact,
            icon: Icon(AppIcons.close, color: DesktopChrome.muted),
          ),
      ],
    ),
  );

  Widget _section(String title, bool shown, VoidCallback toggle) => Semantics(
    button: true,
    expanded: shown,
    child: InkWell(
      key: ValueKey('tab-activity-section:${title.toLowerCase()}'),
      onTap: toggle,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(8, 8, 12, 4),
        child: Row(
          children: [
            SizedBox(
              width: 16,
              child: Text(shown ? '▾' : '▸', style: DesktopChrome.metadata()),
            ),
            Expanded(
              child: Text(
                title.toUpperCase(),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: DesktopChrome.metadata().copyWith(
                  letterSpacing: .4,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
          ],
        ),
      ),
    ),
  );

  static Widget _line(String text, {Key? key, TextStyle? style}) => Text(
    text,
    key: key,
    maxLines: 1,
    softWrap: false,
    overflow: TextOverflow.ellipsis,
    style: style ?? DesktopChrome.control(),
  );

  Widget _note(String text, {required Key key, Color? color}) => Padding(
    padding: const EdgeInsets.fromLTRB(24, 4, 12, 8),
    child: Text(
      text,
      key: key,
      maxLines: 2,
      overflow: TextOverflow.ellipsis,
      style: DesktopChrome.metadata(color: color),
    ),
  );

  /// The shape of a harness row: its mark, its name and its line.
  static Widget _skeletonRow(BuildContext context, int index) => Padding(
    padding: const EdgeInsets.fromLTRB(24, 7, 12, 7),
    child: Row(
      children: [
        const Skeleton.circle(size: 8),
        const SizedBox(width: 8),
        const Skeleton.text(width: 44),
        const SizedBox(width: 8),
        Expanded(
          child: FractionallySizedBox(
            alignment: Alignment.centerLeft,
            widthFactor: index.isEven ? .8 : .55,
            child: const Skeleton.text(),
          ),
        ),
      ],
    ),
  );

  List<Widget> _harnessBody(SharedTab? tab, SharedTasks tasks, double width) {
    if (_rows == null && !_panesOnly) {
      final count = _panes().length.clamp(1, 9);
      return [
        SkeletonList(
          key: const ValueKey('tab-activity-loading'),
          rows: count,
          semanticsLabel: 'Loading harnesses',
          itemBuilder: _skeletonRow,
        ),
      ];
    }
    final rows = _harnessRows(tab, tasks);
    return [
      if (_error case final error?)
        _note(
          error,
          key: const ValueKey('tab-activity-error'),
          color: Theme.of(context).colorScheme.error,
        ),
      if (rows.isEmpty)
        _note(
          'No harnesses in this tab.',
          key: const ValueKey('tab-activity-empty'),
        )
      else
        for (final h in rows) _harnessRow(h, width),
    ];
  }

  Widget _harnessRow(_Harness h, double width) {
    final muted = DesktopChrome.muted;
    final markColor = switch (h.mark) {
      '●' => DesktopChrome.accent,
      '⚠' => grid.AppTheme.pick(grid.AppPalette.warn, Colors.orangeAccent),
      _ => muted,
    };
    final row = _ActivityRow(
      key: ValueKey('tab-activity-harness:${h.key}'),
      onTap: h.paneId == null ? null : () => _focus(h.machineId, h.agentId),
      semanticsLabel: [
        h.name,
        ?h.owner,
        if (h.leader) 'Leader',
        ?h.line,
        if (h.issue case final issue?) 'issue $issue',
      ].join(', '),
      child: Row(
        children: [
          SizedBox(
            width: 16,
            child: Text(
              h.mark,
              key: ValueKey('tab-activity-state:${h.key}'),
              style: DesktopChrome.metadata(color: markColor),
            ),
          ),
          ConstrainedBox(
            constraints: BoxConstraints(maxWidth: width * .3),
            child: _line(h.name, style: DesktopChrome.control(medium: true)),
          ),
          if (h.owner case final owner?) ...[
            const SizedBox(width: 6),
            ConstrainedBox(
              constraints: BoxConstraints(maxWidth: width * .18),
              child: _line(owner, style: DesktopChrome.metadata()),
            ),
          ],
          const SizedBox(width: 6),
          if (h.leader) ...[
            Text(
              'Leader',
              key: ValueKey('tab-activity-leader:${h.key}'),
              maxLines: 1,
              style: DesktopChrome.metadata(color: DesktopChrome.accent),
            ),
            const SizedBox(width: 6),
          ],
          Expanded(
            child: h.line == null
                ? const SizedBox.shrink()
                : _line(
                    h.line!,
                    key: h.summary
                        ? ValueKey('tab-activity-summary:${h.key}')
                        : null,
                    style: DesktopChrome.metadata(),
                  ),
          ),
          if (h.issue case final issue?) ...[
            const SizedBox(width: 6),
            Text(
              '#$issue',
              key: ValueKey('tab-activity-issue:${h.key}'),
              maxLines: 1,
              style: DesktopChrome.metadata(),
            ),
          ],
        ],
      ),
    );
    return h.paneId == null
        ? Tooltip(message: 'Not shown in this tab', child: row)
        : row;
  }

  List<Widget> _tasksBody(SharedTab? tab, SharedTasks tasks, double width) {
    // A tab made a moment ago is not known to the daemon for a while: that is
    // "no tasks yet", never an error.
    final young = tab == null && tasks.error == 'NOT_A_TAB';
    final error = young ? null : tasks.error;
    if (!tasks.loaded && error == null && !young) {
      return [
        const SkeletonList(
          key: ValueKey('tab-activity-tasks-loading'),
          rows: 3,
          semanticsLabel: 'Loading tasks',
          itemBuilder: _skeletonRow,
        ),
      ];
    }
    final rows = _taskRows(tab, tasks);
    return [
      if (error != null)
        _note(
          sharedTasksErrorText(error),
          key: const ValueKey('tab-activity-tasks-error'),
          color: Theme.of(context).colorScheme.error,
        ),
      if (rows.isEmpty && error == null)
        _note(
          'No tasks in this tab.',
          key: const ValueKey('tab-activity-tasks-empty'),
        ),
      for (final t in rows) _taskRow(t.row, t.step, t.assignee, width),
    ];
  }

  Widget _taskRow(
    SharedTaskRow row,
    TaskStep step,
    ({String machineId, String agentId})? assignee,
    double width,
  ) {
    final id = '${row.repo}#${row.issue}';
    final assigneeName = row.assignee == null
        ? null
        : shortSharedText(row.assignee!.harness, 24);
    final pane = assignee == null
        ? null
        : _paneOf(assignee.machineId, assignee.agentId);
    final url = row.pr?.url ?? row.url;
    final stepText = _stepText(step);
    return _ActivityRow(
      key: ValueKey('tab-activity-task:$id'),
      onTap: () => _open(url),
      semanticsLabel: [
        'Issue ${row.issue}',
        plainSharedText(row.title),
        ?assigneeName,
        stepText,
      ].join(', '),
      // The step is the column's point: it keeps its whole label and the
      // title and the assignee give way (the title first). Only a row too
      // narrow even for that cuts it, with the label in a tooltip.
      child: LayoutBuilder(
        builder: (context, box) {
          const idWidth = 40.0, gaps = 12.0, floor = 48.0;
          final stepRoom = math.max(0.0, box.maxWidth - idWidth - gaps - floor);
          return Row(
            children: [
              SizedBox(
                width: idWidth,
                child: _line(
                  '#${row.issue}',
                  style: DesktopChrome.metadata(
                    color: row.state == 'open'
                        ? DesktopChrome.foreground
                        : null,
                  ),
                ),
              ),
              Expanded(
                flex: 3,
                child: _line(
                  plainSharedText(row.title),
                  style: DesktopChrome.control(),
                ),
              ),
              if (assigneeName != null) ...[
                const SizedBox(width: 6),
                Flexible(
                  child: ConstrainedBox(
                    constraints: BoxConstraints(maxWidth: width * .22),
                    child: pane == null
                        ? _line(assigneeName, style: DesktopChrome.metadata())
                        : InkWell(
                            key: ValueKey('tab-activity-task-assignee:$id'),
                            onTap: () =>
                                _focus(assignee!.machineId, assignee.agentId),
                            child: _line(
                              assigneeName,
                              style: DesktopChrome.metadata(
                                color: DesktopChrome.accent,
                              ),
                            ),
                          ),
                  ),
                ),
              ],
              const SizedBox(width: 6),
              ConstrainedBox(
                constraints: BoxConstraints(maxWidth: stepRoom),
                child: Tooltip(
                  message: stepText,
                  child: _line(
                    stepText,
                    key: ValueKey('tab-activity-task-step:$id'),
                    style: DesktopChrome.metadata(
                      color: step == TaskStep.buildFailed
                          ? Theme.of(context).colorScheme.error
                          : null,
                    ),
                  ),
                ),
              ),
            ],
          );
        },
      ),
    );
  }
}

/// A one-line row: the whole row is the click target, with the desktop's
/// focus ring; without [onTap] it is plain.
class _ActivityRow extends StatelessWidget {
  const _ActivityRow({
    super.key,
    required this.child,
    required this.semanticsLabel,
    this.onTap,
  });

  final Widget child;
  final String semanticsLabel;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) => Semantics(
    button: onTap != null,
    label: semanticsLabel,
    excludeSemantics: true,
    child: Padding(
      padding: const EdgeInsets.symmetric(horizontal: 4),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
        focusColor: DesktopChrome.selection,
        hoverColor: DesktopChrome.selection,
        mouseCursor: onTap == null
            ? SystemMouseCursors.basic
            : SystemMouseCursors.click,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(4, 6, 8, 6),
          child: child,
        ),
      ),
    ),
  );
}
