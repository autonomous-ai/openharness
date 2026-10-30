import 'dart:async';

import 'package:flutter/material.dart';

import '../core/models.dart' show sameMachineId;
import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_menu.dart';
import '../state/app_state.dart';
import '../widgets/desktop_chrome.dart';
import 'buddy_rows.dart' show SuperTabCountBadge;
import 'controller.dart';
import 'machines.dart' show contributeComputer;

/// The Swarm dropdown at the top of a Swarm tab's left bar (Dee, 10-30): the
/// Swarm the tab shows, and in its menu Personal, every other Swarm the
/// person belongs to and New Swarm. Picking one shows it in the same tab
/// ([AppNotifier.showSuperTabIn]); nothing else about tabs changes.

const kPersonalSwarmName = 'Personal';

/// The request id Personal is created with. The server derives a new Swarm's
/// id from the signed-in account and this id (backend superTabs/store.ts
/// `create`), so each person has one Personal Swarm, made once whichever
/// window or computer asks first, and two people's never meet.
const kPersonalSwarmOperation = 'personal-swarm';

/// One Swarm the dropdown lists, with what waits for the person in it.
typedef SwarmChoice = ({String id, String name, int waiting});

/// The person's Personal Swarm, per app: which Swarm it is, and creating it
/// once. Created only when the person picks it, with this computer added and
/// no Product Manager started.
class PersonalSwarm extends ChangeNotifier {
  PersonalSwarm._(this.app);
  static final _of = Expando<PersonalSwarm>();
  static PersonalSwarm of(AppNotifier app) => _of[app] ??= PersonalSwarm._(app);

  final AppNotifier app;

  /// Each account's Personal Swarm as picked on this computer.
  final _picked = <String, String>{};
  final _reading = <String>{};
  final _creating = <String, Future<String>>{};
  final _adding = <String>{};

  /// Swarms taken away from each account while shown here: listed no more,
  /// even once their tab has let them go.
  final _lost = <String, Set<String>>{};
  String? _error, _errorAccount;

  String? get _account => app.currentUser?.id;
  static String _key(String account) => 'super_tab.personal.$account';

  /// The signed-in person's Personal Swarm, when there is one this computer
  /// knows of: picked here before, or a Swarm they own named Personal. Never
  /// one whose read was taken away.
  String? get id {
    final account = _account;
    if (account == null) return null;
    _read(account);
    final id = _picked[account] ?? _owned(account);
    if (id == null ||
        lost(id) ||
        app.superTabs.peek(id)?.accessRevoked == true) {
      return null;
    }
    return id;
  }

  /// Whether the person picked Personal on this computer: only then does a
  /// Swarm tab whose Swarm is taken away move to it.
  bool get picked => _picked.containsKey(_account) && id != null;

  /// Personal is being created or set up for the signed-in person.
  bool get busy =>
      _creating.containsKey(_account) || _adding.contains(_account);

  /// Why creating Personal or adding this computer to it failed last.
  String? get error => _errorAccount == _account ? _error : null;

  void clearError() {
    if (_error == null) return;
    _error = null;
    notifyListeners();
  }

  /// Whether Swarm [id] was taken away from the signed-in person while shown.
  bool lost(String id) => _lost[_account]?.contains(id) ?? false;

  /// A Swarm the person owns named Personal, of those they belong to.
  String? _owned(String account) {
    final ids = <String>[
      for (final tab in app.swarms) ?tab.superTabId,
      for (final closed in app.closedSuperTabs) closed.id,
    ]..sort();
    return ids
        .where(
          (id) =>
              !lost(id) &&
              app.superTabs.ownerOf(id) == account &&
              app.superTabName(id)?.trim() == kPersonalSwarmName,
        )
        .firstOrNull;
  }

  void _read(String account) {
    if (!_reading.add(account)) return;
    unawaited(() async {
      try {
        final saved = await app.superTabs.storage.read(_key(account));
        if (saved != null && saved.isNotEmpty && _account == account) {
          _picked.putIfAbsent(account, () => saved);
          notifyListeners();
        }
      } catch (_) {
        // Not remembered: the list's own Personal still stands.
      }
    }());
  }

  /// The person's Personal Swarm, created on the server if it is not known
  /// here. Every caller while one is being created joins that one.
  Future<String> ensure() {
    final account = _account;
    if (account == null) {
      return Future.error(
        const SuperTabFailure('SIGNED_OUT', 'Sign in to use Swarm.'),
      );
    }
    if (id case final known?) {
      _remember(account, known);
      return Future.value(known);
    }
    if (_creating[account] case final pending?) return pending;
    final creating = _create(account);
    _creating[account] = creating;
    notifyListeners();
    unawaited(
      creating.catchError((Object _) => '').whenComplete(() {
        _creating.remove(account);
        notifyListeners();
      }),
    );
    return creating;
  }

  Future<String> _create(String account) async {
    _error = null;
    try {
      final created = await app.superTabs.map(
        'POST',
        '/api/super-tabs',
        body: {
          'operationId': kPersonalSwarmOperation,
          'name': kPersonalSwarmName,
        },
      );
      if (_account != account) {
        throw const SuperTabFailure('ACCOUNT_CHANGED', 'The account changed.');
      }
      final id = created['id'];
      if (id is! String || id.isEmpty) {
        throw const SuperTabFailure(
          'INVALID_RESPONSE',
          'Could not create your Personal Swarm. Try again.',
        );
      }
      // Discovery may list it before this tab shows it: no second tab.
      app.superTabs.deferTabDiscovery(id);
      _remember(account, id);
      return id;
    } catch (failure) {
      _fail(account, failure, 'Could not create your Personal Swarm.');
      rethrow;
    }
  }

  void _remember(String account, String id) {
    if (_picked[account] == id) return;
    _picked[account] = id;
    unawaited(
      app.superTabs.storage.write(_key(account), id).catchError((Object _) {}),
    );
  }

  void _fail(String account, Object failure, String fallback) {
    if (_account != account) return;
    final message = failure is SuperTabFailure ? failure.message : fallback;
    if (failure is SuperTabFailure && failure.code == 'ACCOUNT_CHANGED') return;
    _error = message;
    _errorAccount = account;
    notifyListeners();
  }

  /// Shows Personal in Swarm tab [swarmId], creating it first if needed, then
  /// adds this computer to it. A tab that moved to another Swarm meanwhile,
  /// or a person who signed out, is left as it is.
  Future<void> show(String swarmId) async {
    final account = _account;
    final shown = _tabShowing(swarmId);
    if (account == null || shown == null) return;
    final String personal;
    try {
      personal = await ensure();
    } catch (_) {
      return;
    }
    if (_account != account || _tabShowing(swarmId) != shown) return;
    app.showSuperTabIn(swarmId, personal, kPersonalSwarmName);
    await _addThisComputer(account, personal);
  }

  String? _tabShowing(String swarmId) =>
      app.swarms.where((s) => s.id == swarmId).firstOrNull?.superTabId;

  /// This computer, added as Add machine adds it: only the person's own,
  /// linked and online, and never a Harness Team account's machine.
  Future<void> _addThisComputer(String account, String personal) async {
    final here = app.machineStates.values
        .where(
          (m) =>
              m.isLocalMachine &&
              !m.machine.isTeamAccount &&
              !m.belongsToOtherAccount &&
              !m.needsLink &&
              !m.isOffline,
        )
        .firstOrNull;
    if (here == null || !_adding.add(account)) return;
    notifyListeners();
    try {
      final c = await app.superTabs.open(personal);
      bool alive() => _account == account && !c.accessRevoked;
      if (c.snapshot == null) await c.refresh();
      final machineId = here.machine.machineId;
      final snapshot = c.snapshot;
      if (!alive() || snapshot == null) return;
      if (snapshot.machines.any(
        (m) =>
            m['machineId'] is String &&
            sameMachineId(m['machineId'], machineId),
      )) {
        return;
      }
      await contributeComputer(
        c,
        app,
        machineId,
        setupId: 'personal-swarm-setup',
        alive: alive,
        offerTeamAccount: false,
      );
    } catch (failure) {
      _fail(account, failure, 'Could not add this computer to Personal.');
    } finally {
      _adding.remove(account);
      notifyListeners();
    }
  }
}

/// The Swarms the dropdown lists under Personal, by name: every Swarm the
/// person belongs to, open in a tab here or closed, but not Personal and not
/// one whose read was taken away. Only Swarms the signed-in account's own
/// list or read named: a tab left from another account lists nothing.
List<SwarmChoice> swarmChoices(AppNotifier app) {
  final personal = PersonalSwarm.of(app).id;
  final names = <String, String>{};
  for (final tab in app.swarms) {
    final id = tab.superTabId;
    if (id != null) names[id] = app.superTabName(id) ?? tab.name;
  }
  for (final closed in app.closedSuperTabs) {
    names.putIfAbsent(closed.id, () => closed.name);
  }
  return [
    for (final MapEntry(key: id, value: name) in names.entries)
      if (id != personal &&
          app.superTabs.ownerOf(id) != null &&
          !PersonalSwarm.of(app).lost(id) &&
          app.superTabs.peek(id)?.accessRevoked != true)
        (
          id: id,
          name: name.trim().isEmpty ? 'Swarm' : name,
          waiting: swarmWaiting(app, id),
        ),
  ]..sort((a, b) => a.name.toLowerCase().compareTo(b.name.toLowerCase()));
}

/// What a Swarm's tab badge counts: its tags and unread Buddy chat lines.
int swarmWaiting(AppNotifier app, String id) =>
    app.superTabs.waitingTags(id) + app.superTabs.waitingBuddy(id);

/// The Swarm tab showing [c]'s Swarm moves to Personal when that Swarm is
/// taken away, once the person has picked Personal here; it never creates
/// Personal. Nothing of the lost Swarm stays in the tab.
void fallBackToPersonal(AppNotifier app, SuperTabController c) {
  final personal = PersonalSwarm.of(app);
  final id = personal.id;
  if (!c.accessRevoked ||
      c.accountId != app.currentUser?.id ||
      !personal.picked ||
      id == null ||
      id == c.tabId) {
    return;
  }
  final tab = app.swarms.where((s) => s.superTabId == c.tabId).firstOrNull;
  if (tab == null) return;
  (personal._lost[c.accountId] ??= {}).add(c.tabId);
  app.showSuperTabIn(tab.id, id, kPersonalSwarmName);
}

/// The top row of a Swarm tab's left bar and its menu. [row] draws the row
/// as the sidebar draws its others: a label, an icon, a tap, and a trailing
/// mark.
class SwarmSwitcher extends StatefulWidget {
  const SwarmSwitcher({
    super.key,
    required this.app,
    required this.controller,
    required this.onNewSwarm,
    required this.row,
  });

  final AppNotifier app;
  final SuperTabController controller;
  final VoidCallback onNewSwarm;
  final Widget Function({
    required String label,
    required IconData icon,
    required VoidCallback? onTap,
    required Widget trailing,
  })
  row;

  @override
  State<SwarmSwitcher> createState() => _SwarmSwitcherState();
}

class _SwarmSwitcherState extends State<SwarmSwitcher> {
  final _menu = MenuController();

  AppNotifier get app => widget.app;
  PersonalSwarm get personal => PersonalSwarm.of(app);

  /// The Swarm tab this left bar is in.
  String? get _tab => app.swarms
      .where((s) => s.superTabId == widget.controller.tabId)
      .firstOrNull
      ?.id;

  void _pick(String id) {
    _menu.close();
    final tab = _tab;
    // Taken away since the menu was drawn: nothing to show.
    final choice = swarmChoices(app).where((c) => c.id == id).firstOrNull;
    if (tab == null || choice == null) return;
    app.showSuperTabIn(tab, choice.id, choice.name);
  }

  void _pickPersonal() {
    _menu.close();
    final tab = _tab;
    if (tab != null) unawaited(personal.show(tab));
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: Listenable.merge([app, personal, widget.controller]),
    builder: (context, _) {
      grid.AppTheme.watch(context);
      final c = widget.controller;
      final personalId = personal.id;
      final current = c.accessRevoked ? null : c.tabId;
      final isPersonal = current != null && current == personalId;
      final label = isPersonal
          ? kPersonalSwarmName
          : current == null
          ? 'Swarm'
          : app.superTabName(current) ?? c.snapshot?.name ?? 'Swarm';
      final choices = swarmChoices(app);
      final personalWaiting = personalId == null || isPersonal
          ? 0
          : swarmWaiting(app, personalId);
      Widget? badge(int count) => count > 0 ? SuperTabCountBadge(count) : null;
      return LayoutBuilder(
        builder: (context, box) {
          final width = box.maxWidth.isFinite ? box.maxWidth : 260.0;
          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            mainAxisSize: MainAxisSize.min,
            children: [
              MenuAnchor(
                controller: _menu,
                consumeOutsideTap: true,
                alignmentOffset: const Offset(0, grid.AppControl.menuGap),
                style: grid.AppMenu.style(minWidth: width, maxWidth: width),
                onOpen: personal.clearError,
                menuChildren: [
                  AppMenuItem(
                    key: const ValueKey('swarm-switch-personal'),
                    label: kPersonalSwarmName,
                    icon: AppIcons.user,
                    selected: isPersonal,
                    expandLabel: true,
                    trailing: personal.busy
                        ? const SizedBox.square(
                            dimension: 12,
                            child: CircularProgressIndicator(strokeWidth: 1.5),
                          )
                        : badge(personalWaiting),
                    onPressed: _pickPersonal,
                  ),
                  for (final choice in choices)
                    AppMenuItem(
                      key: ValueKey('swarm-switch-${choice.id}'),
                      label: choice.name,
                      icon: AppIcons.users,
                      selected: choice.id == current,
                      expandLabel: true,
                      trailing: choice.id == current
                          ? null
                          : badge(choice.waiting),
                      onPressed: () => _pick(choice.id),
                    ),
                  AppMenuItem(
                    key: const ValueKey('swarm-switch-new'),
                    label: 'New Swarm',
                    icon: AppIcons.plus,
                    expandLabel: true,
                    onPressed: () {
                      _menu.close();
                      widget.onNewSwarm();
                    },
                  ),
                ],
                builder: (context, menu, _) => Semantics(
                  label: 'Swarm: $label',
                  hint: 'Shows another Swarm in this tab',
                  child: widget.row(
                    label: label,
                    icon: isPersonal ? AppIcons.user : AppIcons.users,
                    onTap: () => menu.isOpen ? menu.close() : menu.open(),
                    trailing: Icon(
                      AppIcons.chevronDown,
                      size: 14,
                      color: DesktopChrome.muted,
                    ),
                  ),
                ),
              ),
              if (personal.error case final error?)
                Padding(
                  key: const ValueKey('super-swarm-switcher-error'),
                  padding: const EdgeInsets.fromLTRB(12, 0, 12, 8),
                  child: Text(
                    error,
                    style: DesktopChrome.metadata(color: grid.AppPalette.warn),
                  ),
                ),
            ],
          );
        },
      );
    },
  );
}
