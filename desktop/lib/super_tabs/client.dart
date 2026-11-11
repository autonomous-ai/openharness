import 'dart:async';
import 'dart:convert';

import 'package:clock/clock.dart';
import 'package:flutter/foundation.dart';

import '../core/local_key_value_store.dart';
import '../core/models.dart';
import 'account_keys.dart';
import 'attachment_upload.dart';
import 'controller.dart';
import 'model.dart';
import 'my_agents.dart';
import 'notifications.dart';
import 'parts.dart';
import 'reading.dart';
import 'saved_view.dart';

typedef SuperTabTransport = Future<Object?> Function(
  String method,
  String path, {
  Map<String, dynamic>? body,
});

typedef SuperTabListing = ({String id, String name});

/// Account-scoped client state. Backend membership never comes from the saved
/// layout, and a late response cannot cross an account change.
class SuperTabClient {
  SuperTabClient({
    required this.transport,
    required LocalKeyValueStore storage,
    LocalKeyValueStore? viewStorage,
    this.onSnapshot,
    this.onTabs,
    this.onSelection,
    this.onChatMessage,
    this.onNotices,
    this.upload = refuseUpload,
    this.discoveryInterval = const Duration(seconds: 15),
  }) : _storage = storage,
       viewStorage = viewStorage ?? storage;
  final SuperTabTransport transport;
  final LocalKeyValueStore _storage;

  /// Where Swarm drafts, launches, hidden Swarms and the switcher's pick are
  /// kept, per account. On the web a write for an account that is not signed
  /// in on this page is dropped ([SwarmAccountStorage]): one landing after a
  /// sign-out would put back what it cleared.
  late final LocalKeyValueStore storage = SwarmAccountStorage(
    _storage,
    writes: (account) => !_forgetsWebOnly || account == _account,
  );

  /// Where each Swarm's saved view is kept ([SuperTabSavedViews]): a few
  /// hundred KB each, so Desktop keeps them out of [storage]'s small file.
  final LocalKeyValueStore viewStorage;
  final void Function(SuperTabController)? onSnapshot;
  final void Function(List<SuperTabListing>, Set<String> hidden)? onTabs;

  /// A tab's selected conversation changed, by a click here or by a device.
  final void Function(SuperTabController)? onSelection;

  /// A new message in a chat the reader set to All new messages, or in an
  /// agent's own chat with them ([SuperTabChatNotices]), with the Swarm, the
  /// chat and how far it goes.
  final void Function(String tabId, SuperTabConversation group, int sequence)?
  onChatMessage;

  /// Which of the reader's agents ask them changed in an open Swarm ([agentsAsking]): what the menu bar lists and the
  /// Dock counts.
  final void Function()? onNotices;

  /// The reader's agents with something new for them in their 1:1 chats in a Swarm open here
  /// ([superTabAgentsAsking]); none in a Swarm not open.
  int agentsAsking(String id) => switch (_loaded[id]) {
    final controller? => superTabAgentsAsking(controller).length,
    null => 0,
  };

  final SuperTabUpload upload;
  final Duration discoveryInterval;

  /// How every Swarm tab here keeps itself current. Desktop's unless the host
  /// composition sets another (`SuperTabWorkspace` hands on its chrome's).
  SuperTabReading get reading => _reading;
  set reading(SuperTabReading value) {
    if (identical(value, _reading)) return;
    final claims = value.drawsSaved && !_reading.drawsSaved;
    _reading = value;
    // The account bound before the host said views are kept, at boot. With
    // none bound yet, the bind that follows claims.
    if (claims && _account != null) _claimViews();
    // A page that starts signed out still sweeps what another page wrote of
    // an account after it signed out.
    if (claims && _account == null) _forgetSignedOut();
    for (final controller in _loaded.values) {
      controller.reading = value;
    }
  }

  SuperTabReading _reading = const SuperTabReading();
  String? _shown;
  bool _pageVisible = true, _serverRead = false;

  /// The Swarm tab on screen, or null for none: every other one is away.
  void show(String? tabId) {
    if (_shown == tabId) return;
    _shown = tabId;
    _applyAway();
  }

  /// False while the page or window is hidden: every Swarm tab is away.
  ///
  /// Hidden while the server pushes, nothing is read on a clock: a told change is still read at
  /// once, the safety nets wait (task #2953). Shown again, each open Swarm
  /// reads once ([SuperTabController.away]) and so does the list, if its safety net came due or
  /// the server's word came meanwhile.
  set pageVisible(bool visible) {
    if (_pageVisible == visible) return;
    _pageVisible = visible;
    _applyAway();
    if (!visible) return;
    final last = _lastDiscovery;
    if (_toldWhileHidden ||
        (_pushing &&
            last != null &&
            clock.now().difference(last) >= kSwarmDiscoverySafetyNet)) {
      _toldWhileHidden = false;
      _discoverWhenAllowed();
    }
  }

  /// The server's word that it pushes came while the page was hidden: what it asks for is read
  /// on return.
  bool _toldWhileHidden = false;

  /// When the server's word that it pushes was last heard.
  DateTime? _lastPushWord;

  /// How far from [kSwarmPushRepeat] a repeat may land: a hidden window's socket is read late
  /// (App Nap), and a reconnect inside this window waits, at worst, for the return.
  static const _pushBeatSlack = Duration(seconds: 30);

  /// Hidden while the server pushes: the reads on a clock rest.
  bool get _restsHidden => !_pageVisible && _pushing;

  bool _isAway(String id) => !_pageVisible || id != _shown;

  late final _views = SuperTabSavedViews(viewStorage);
  final _viewSaves = <String, Timer>{};
  final _viewSavedAt = <String, DateTime>{};
  final _viewVersions = <String, int>{};

  /// The web's forgets beyond Desktop's: the Swarms a discovery no longer
  /// lists, and the account leaving. Desktop forgets as it did with #1803.
  bool get _forgetsWebOnly => _reading.drawsSaved && !_reading.confirmsSaved;

  /// Only the account using this device keeps views on it: any other one,
  /// after a reload too, is forgotten ([SuperTabSavedViews.claim]).
  void _claimViews({String? leaving}) {
    if (!_reading.drawsSaved) return;
    unawaited(
      _views.claim(_account, leaving: leaving).catchError((Object _) {}),
    );
    _forgetSignedOut(leaving: leaving);
  }

  /// The web's sign-out: the drafts, launches, hidden Swarms and switcher
  /// pick of the account leaving go, and those of any account signed out on
  /// this browser that another page wrote after ([forgetSwarmAccounts]).
  /// The account signed in now, and any other, keep theirs. Desktop keeps
  /// each account's, as before.
  void _forgetSignedOut({String? leaving}) {
    if (!_forgetsWebOnly) return;
    final bound = _account;
    _forgetting = _forgetting
        .then(
          (_) => forgetSwarmAccounts(_storage, bound: bound, leaving: leaving),
        )
        .catchError((Object _) {});
  }

  Future<void> _forgetting = Future.value();

  /// The last sign-out's clearing, for tests and Settings.
  @visibleForTesting
  Future<void> get forgotten => _forgetting;

  /// Moves each time a Swarm's view is kept on this device: Settings' Clear
  /// now stops saying Cleared once one is kept again.
  ValueListenable<int> get viewsKept => _viewsKept;
  final _viewsKept = ValueNotifier(0);

  /// Settings' Clear now: the views this device keeps go, and none waiting
  /// for its 15 s turn is written after. A Swarm is kept again once what it
  /// shows changes.
  Future<void> clearSavedViews() {
    for (final timer in _viewSaves.values) {
      timer.cancel();
    }
    _viewSaves.clear();
    return _views.clear(_account);
  }

  /// How often a Swarm's view may be written while it keeps changing: each
  /// write is a few hundred KB into the browser's storage.
  static const _viewSaveEvery = Duration(seconds: 15);

  /// How long an open waits for a saved view before drawing without one.
  static const _viewLockWait = Duration(milliseconds: 250);

  void _saveViewSoon(String id) {
    if (_viewSaves.containsKey(id)) return;
    final last = _viewSavedAt[id];
    final since = last == null ? _viewSaveEvery : clock.now().difference(last);
    _viewSaves[id] = Timer(
      since >= _viewSaveEvery ? Duration.zero : _viewSaveEvery - since,
      () => _saveView(id),
    );
  }

  void _saveView(String id) {
    _viewSaves.remove(id)?.cancel();
    final account = _account;
    final controller = _loaded[id];
    final view = controller?.savedView;
    // Nothing to keep is no write: the 15 s wait starts with a real one.
    if (account == null || view == null) return;
    _viewSavedAt[id] = clock.now();
    _viewVersions[id] = controller!.viewVersion;
    unawaited(
      _views
          .write(account, id, view)
          .then((kept) {
            if (kept) _viewsKept.value++;
          })
          .catchError((Object _) {}),
    );
  }

  void _applyAway() {
    for (final entry in _loaded.entries) {
      final away = _isAway(entry.key);
      // Going away: what changed since the last write is kept now.
      if (away && _viewSaves.containsKey(entry.key)) _saveView(entry.key);
      entry.value
        ..pageHidden = !_pageVisible
        ..away = away;
    }
  }

  /// A machine able to serve Swarm reads connected ([SuperTabReading.readsOnConnect]):
  /// one read of the tab on screen and one discovery, however many machines
  /// connect in the same moment.
  void serverAvailable() {
    if (!_reading.readsOnConnect || _account == null || _serverRead) return;
    _serverRead = true;
    scheduleMicrotask(() {
      _serverRead = false;
      for (final controller in _loaded.values) {
        unawaited(controller.machineAvailable());
      }
      unawaited(refreshTabs());
    });
  }

  String? _account;
  int _generation = 0;
  Timer? _discoveryTimer;
  Future<void>? _discovering, _loadingHidden;

  /// WS roadmap Phase 2a: until when the server is known to push this
  /// account's Swarm changes ([kSwarmPushLease]), the next discovery a change
  /// asked for, and when discovery last read.
  DateTime? _pushUntil;
  Timer? _discoverSoon;
  DateTime? _lastDiscovery;

  bool get _pushing {
    final until = _pushUntil;
    return until != null && clock.now().isBefore(until);
  }

  /// Whether the server is known to push this account's Swarm changes now.
  bool get pushing => _pushing;

  /// Every [discoveryInterval], unless the server pushes: then every
  /// [kSwarmDiscoverySafetyNet], a change asking for one sooner.
  bool get _discoveryDue {
    final last = _lastDiscovery;
    return !_pushing ||
        last == null ||
        clock.now().difference(last) >= kSwarmDiscoverySafetyNet;
  }

  /// The server's word over this account's socket (backend
  /// lib/swarmClientPushes.ts, a `swarm_changed` frame). Naming no Swarm, it
  /// pushes. Naming one, the Swarm open here reads it ([SuperTabController.told]),
  /// and a change to its main parts reads discovery ([_discoverWhenAllowed]),
  /// once for a burst of them across Swarms (a Swarm joined or left).
  void swarmChanged(Map<String, dynamic> payload) {
    if (_account == null) return;
    final tabId = payload['tabId'], parts = payload['parts'];
    if (tabId == null && parts == null) {
      // Hidden, the word repeated every 4 minutes renews the lease and reads nothing until the
      // page shows; once the lease had lapsed the away poll was reading all along. A word off that
      // beat is a socket that reconnected, the same payload (review of #3035): a push may have been
      // lost meanwhile, so Desktop reads once, as shown, for the menu bar and notices. The web
      // reads nothing while away anyway ([SuperTabReading.pausesAway]).
      final now = clock.now(), last = _lastPushWord;
      _lastPushWord = now;
      final onBeat =
          last != null &&
          (now.difference(last) - kSwarmPushRepeat).abs() <= _pushBeatSlack;
      if (_restsHidden && (onBeat || _reading.pausesAway)) {
        _pushUntil = clock.now().add(kSwarmPushLease);
        for (final controller in _loaded.values) {
          controller.pushUntil = _pushUntil;
        }
        _toldWhileHidden = true;
        return;
      }
      _pushUntil = clock.now().add(kSwarmPushLease);
      // Said on every connect (review of #2121): a daemon that reconnected
      // was not told what changed meanwhile, so each open Swarm and the list
      // read once, on their next allowed read.
      for (final controller in _loaded.values) {
        controller
          ..pushUntil = _pushUntil
          ..told(main: true);
      }
      _discoverWhenAllowed();
      return;
    }
    if (tabId is! String || parts is! List) return;
    final main = parts.contains('main');
    if (!main && !parts.contains('machine')) return;
    final at = payload['lastChangedAt'];
    _loaded[tabId]?.told(main: main, at: at is int ? at : null);
    if (main) _discoverWhenAllowed();
  }

  /// One discovery for the changes told since the last: a second from now,
  /// or once [discoveryInterval] has passed since the last, so the list is
  /// read no more often than its old poll (review of #2121).
  bool _discoveryWanted = false;
  void _discoverWhenAllowed() {
    if (onTabs == null || discoveryInterval <= Duration.zero) return;
    _discoveryWanted = true;
    if (_discoverSoon != null) return;
    final last = _lastDiscovery;
    var wait = const Duration(seconds: 1);
    if (last != null) {
      final left = discoveryInterval - clock.now().difference(last);
      if (left > wait) wait = left;
    }
    _discoverSoon = Timer(wait, () {
      _discoverSoon = null;
      if (_discoveryWanted) unawaited(refreshTabs());
    });
  }

  Future<void> _savingHidden = Future.value();
  Set<String> _hidden = {};
  final _creating = <String>{};
  final _visibility = <String, bool>{};
  Object? discoveryError;
  final _controllers = <String, Future<SuperTabController>>{};
  final _loaded = <String, SuperTabController>{};

  /// The last state of each Swarm closed here ([release]): a closed view
  /// still protects its Product Managers, without reading anything more.
  final _closedSnapshots = <String, SuperTabSnapshot>{};

  /// The files waiting to go in Swarms let go, for their next controllers: in
  /// memory for this account, and for the newest [_keptFilesSwarms] alone.
  final _keptFiles = <String, SuperTabKeptFiles>{};
  static const _keptFilesSwarms = 8;

  /// How many times each Swarm was closed here: an open a close overtook
  /// stops before it makes a controller.
  final _closes = <String, int>{};
  SuperTabController? peek(String id) => _loaded[id];
  Iterable<SuperTabController> get loadedControllers => _loaded.values;

  /// Native close actions name the machine's harness id, not the Swarm agent id.
  String? leadProtectionReasonForHarness(String machineId, String harnessId) =>
      _leadOfHarness(machineId, harnessId);

  /// Renames the agent a harness is in every loaded Swarm that holds it
  /// (Rename Harness, task #2912): each Swarm shows the agent by its own
  /// name, so the rename reaches everyone's sidebar. Why each Swarm that
  /// refused did, empty when all took it or none holds the harness.
  Future<List<String>> renameHarnessAgent(
    String machineId,
    String harnessId,
    String name,
  ) async {
    final errors = <String>[];
    for (final controller in loadedControllers.toList()) {
      final agent = controller.snapshot?.agents
          .where((a) => a.machineId == machineId && a.harnessId == harnessId)
          .firstOrNull;
      if (agent == null) continue;
      final error = await controller.renameAgent(agent.id, name);
      if (error != null) errors.add(error);
    }
    return errors;
  }

  /// Names already sent by [syncChosenNames]: Swarm, agent and name, so each is
  /// sent once per run, a refused one included.
  final _chosenNamesSent = <String>{};

  /// What each Swarm's agents and their names were when [agentNamesChanged]
  /// last looked.
  final _agentNamesSeen = <String, String>{};

  /// Whether Swarm [tabId]'s agents or the names it shows for them changed
  /// since this last said so: a message or a task moving in it is not a change,
  /// so the sync of chosen names does not run for it (review of #3021).
  bool agentNamesChanged(String tabId) {
    final snapshot = _loaded[tabId]?.snapshot;
    if (snapshot == null) return false;
    final now = [
      for (final agent in snapshot.agents)
        '${agent.id}:${snapshot.agentName(agent.id)}',
    ].join('|');
    if (_agentNamesSeen[tabId] == now) return false;
    _agentNamesSeen[tabId] = now;
    return true;
  }

  /// A name as the Swarm keeps it: one space between words, trimmed.
  static String _spaced(String name) =>
      name.replaceAll(RegExp(r'\s+'), ' ').trim();

  /// Sends the names people chose for their agents to the Swarms that show
  /// something else (task #2920): an agent renamed before the rename reached
  /// the Swarm shows its new name with no second rename. [native] reads the
  /// harness an agent runs as on this person's own machines, null for one this
  /// app cannot see or may not rename.
  ///
  /// Only a name the daemon says a person chose, never the creation name or an
  /// engine's session title; a daemon that does not say sends nothing. Only for
  /// an agent this person may rename (its contributor or its machine's owner,
  /// as the Swarm decides).
  /// [tabId] narrows it to one Swarm, [machineId] and [harnessId] to one
  /// harness: only what changed is looked at. Returns how many were sent.
  Future<int> syncChosenNames(
    Agent? Function(String machineId, String harnessId) native, {
    String? tabId,
    String? machineId,
    String? harnessId,
  }) async {
    var sent = 0;
    for (final MapEntry(key: swarm, value: controller)
        in _loaded.entries.toList()) {
      if (tabId != null && swarm != tabId) continue;
      final snapshot = controller.snapshot;
      if (snapshot == null) continue;
      for (final agent in snapshot.agents.toList()) {
        if (machineId != null && agent.machineId != machineId) continue;
        if (harnessId != null && agent.harnessId != harnessId) continue;
        final person = controller.accountId;
        if (agent.contributorId != person && agent.machineOwnerId != person) {
          continue;
        }
        final local = native(agent.machineId, agent.harnessId);
        if (local == null || local.nameChosen != true) continue;
        final name = _spaced(local.name);
        if (name.isEmpty || name == _spaced(snapshot.agentName(agent.id))) {
          continue;
        }
        if (!_chosenNamesSent.add('$swarm|${agent.id}|$name')) continue;
        if (await controller.renameAgent(agent.id, name) == null) sent++;
      }
    }
    return sent;
  }

  String? _leadOfHarness(String machineId, String harnessId) {
    for (final snapshot in [
      for (final controller in loadedControllers) ?controller.snapshot,
      ..._closedSnapshots.values,
    ]) {
      for (final agent in snapshot.agents) {
        if (agent.machineId != machineId || agent.harnessId != harnessId) {
          continue;
        }
        if (snapshot.leadProtectionReason(agent.id) case final reason?) {
          return reason;
        }
      }
    }
    return null;
  }

  /// The tabs closed on this computer. Only discovery says which of them the
  /// account still belongs to.
  Set<String> get hiddenIds => Set.unmodifiable(_hidden);

  /// Who owns Swarm [id], as the open Swarm says or the last full list read
  /// said; null for one this account is not listed in.
  String? ownerOf(String id) => _loaded[id]?.snapshot?.ownerId ?? _owners[id];
  Map<String, String> _owners = const {};

  void bind(String? account) {
    if (_account == account) return;
    for (final timer in _viewSaves.values) {
      timer.cancel();
    }
    _viewSaves.clear();
    _viewSavedAt.clear();
    _viewVersions.clear();
    final leaving = _account;
    _account = account;
    // Nothing of an account that left stays on this device.
    _claimViews(leaving: _forgetsWebOnly ? leaving : null);
    _generation++;
    _discoveryTimer?.cancel();
    _discoverSoon?.cancel();
    _discoverSoon = null;
    // The server's word was for the account that left; the next is told anew.
    _pushUntil = null;
    _discovering = null;
    _loadingHidden = null;
    _hidden = {};
    _creating.clear();
    _visibility.clear();
    _owners = const {};
    _listed = const {};
    _listAnswers = 0;
    _listAsked.clear();
    discoveryError = null;
    for (final controller in _loaded.values) {
      // Desktop keeps each account's unsent and unconfirmed messages for its
      // next sign-in; the web forgets them with the rest ([_forgetSignedOut]).
      controller.revokeAccess(
        'The account changed. Open this Swarm again.',
        keepSaved: !_forgetsWebOnly,
      );
    }
    for (final future in _controllers.values) {
      unawaited(
        future
            .then((c) async {
              c.dispose();
              await c.flush();
            })
            .catchError((Object _) {}),
      );
    }
    _controllers.clear();
    _loaded.clear();
    _closedSnapshots.clear();
    _keptFiles.clear();
    _closes.clear();
    if (account != null &&
        onTabs != null &&
        discoveryInterval > Duration.zero) {
      unawaited(refreshTabs());
      _discoveryTimer = Timer.periodic(discoveryInterval, (_) {
        if (_discoveryDue && !_restsHidden) unawaited(refreshTabs());
      });
    }
  }

  Future<void> _readHidden(String account, int generation) =>
      _loadingHidden ??= () async {
        final raw = await storage.read('super_tab.hidden.$account');
        if (generation != _generation) return;
        _hidden = raw == null
            ? <String>{}
            : (jsonDecode(raw) as List).whereType<String>().toSet();
        for (final entry in _visibility.entries) {
          if (entry.value) {
            _hidden.remove(entry.key);
          } else {
            _hidden.add(entry.key);
          }
        }
      }();

  /// Closing a tab hides its view on this computer. Membership and running
  /// agents stay on the backend; another computer still discovers that tab.
  Future<void> setTabVisible(String id, bool visible) async {
    final account = _account;
    final generation = _generation;
    if (account == null) return;
    if (visible) _creating.remove(id);
    _visibility[id] = visible;
    if (visible) {
      _hidden.remove(id);
    } else {
      _hidden.add(id);
    }
    await _readHidden(account, generation);
    if (generation != _generation) return;
    final saved = jsonEncode(_hidden.toList()..sort());
    final write = _savingHidden
        .catchError((Object _) {})
        .then((_) => storage.write('super_tab.hidden.$account', saved));
    _savingHidden = write;
    await write;
  }

  /// The lead form already represents a creation in flight on this computer.
  /// Its backend row can arrive through discovery before the lead is ready.
  void deferTabDiscovery(String id) => _creating.add(id);

  /// Discovery is account membership, independent of this computer's saved
  /// layout. Read every page before applying; a failed page cannot drop tabs.
  Future<void> refreshTabs() {
    if (_account == null || onTabs == null) return Future.value();
    if (_discovering case final active?) return active;
    _lastDiscovery = clock.now();
    _discoveryWanted = false;
    final generation = _generation;
    final account = _account!;
    final read = () async {
      try {
        await _readHidden(account, generation);
        if (generation != _generation) return;
        final tabs = <String, SuperTabListing>{};
        final owners = <String, String>{};
        final cursors = <String>{};
        String? after;
        do {
          final page = await _readListPage(after);
          if (generation != _generation) return;
          if (page['tabs'] is! List) {
            throw const FormatException('Missing tabs');
          }
          for (final raw in page['tabs'] as List) {
            final row = superTabMap(raw);
            if (row['id'] is! String || row['name'] is! String) {
              throw const FormatException('Invalid tab');
            }
            final id = row['id'] as String;
            tabs[id] = (id: id, name: row['name'] as String);
            if (row['ownerId'] case final String owner) owners[id] = owner;
          }
          after = page['next'] as String?;
          if (after != null && !cursors.add(after)) {
            throw const FormatException('Repeated tab cursor');
          }
        } while (after != null);
        discoveryError = null;
        _owners = owners;
        _listed = tabs.keys.toSet();
        _listAnswers++;
        final hidden = Set<String>.unmodifiable({..._hidden, ..._creating});
        onTabs!(tabs.values.toList(), hidden);
        // Every page read: a Swarm not listed is no longer this account's.
        // In the background: the lock another tab holds never delays discovery.
        if (_forgetsWebOnly) {
          unawaited(
            _views
                .keepOnly(account, {...tabs.keys, ..._creating})
                .catchError((Object _) {}),
          );
        }
      } catch (error) {
        if (generation == _generation) {
          discoveryError = error;
          _loadingHidden = null;
        }
      }
    }();
    _discovering = read;
    return read.whenComplete(() {
      if (identical(_discovering, read)) _discovering = null;
    });
  }

  /// The Swarms the last list read that answered named, and how many list
  /// reads have answered for this account.
  Set<String> _listed = const {};
  int _listAnswers = 0;

  /// When each Swarm last asked for the list ([_stillListed]), and how many
  /// list reads had answered then.
  final _listAsked = <String, ({DateTime at, int answers})>{};

  /// Whether the account's list still names Swarm [id]: a Swarm refuses a
  /// read while its backend restarts, and only the list says it is gone.
  /// Throws when the list cannot be read, or the account changed meanwhile.
  ///
  /// A restart refuses every read for a while, so the list is read for a
  /// Swarm at most once a minute (task #2767). Within that minute the answer
  /// is the latest list that answered since this Swarm asked, whoever read it
  /// (discovery too); with none, it is unknown.
  Future<bool> _stillListed(String id) async {
    final now = clock.now();
    final asked = _listAsked[id];
    if (asked != null && now.difference(asked.at) < kSwarmListRecheckEvery) {
      if (_listAnswers == asked.answers) {
        throw const SuperTabFailure(
          'LIST_UNREAD',
          'The Swarm list has not answered since it was asked.',
        );
      }
      return _listed.contains(id);
    }
    _listAsked[id] = (at: now, answers: _listAnswers);
    final generation = _generation;
    await refreshTabs();
    if (generation != _generation) {
      throw const SuperTabFailure('ACCOUNT_CHANGED', 'The account changed.');
    }
    if (discoveryError case final error?) throw error;
    return _listed.contains(id);
  }

  /// One page of the Swarm list.
  Future<Map<String, dynamic>> _readListPage(String? after) => map(
    'GET',
    after == null
        ? '/api/super-tabs/list'
        : '/api/super-tabs/list?after=${Uri.encodeComponent(after)}',
  );

  Future<Object?> request(
    String method,
    String path, {
    Map<String, dynamic>? body,
  }) async {
    if (_account == null) {
      throw const SuperTabFailure('SIGNED_OUT', 'Sign in to use Swarm.');
    }
    final generation = _generation;
    final result = await transport(method, path, body: body);
    if (generation != _generation) {
      throw const SuperTabFailure(
        'ACCOUNT_CHANGED',
        'The account changed. Open this Swarm again.',
      );
    }
    return result;
  }

  Future<Map<String, dynamic>> map(
    String method,
    String path, {
    Map<String, dynamic>? body,
  }) async => superTabMap(await request(method, path, body: body));

  /// The Swarm as it is now, read once with a first load: for a check outside
  /// an open tab (a launch revalidating its destination).
  Future<SuperTabSnapshot> readSnapshot(String id) async {
    final parts = SuperTabParts.firstLoad(
      await map('GET', '/api/super-tabs/${Uri.encodeComponent(id)}/parts'),
    );
    return SuperTabSnapshot.fromJson(parts.state);
  }

  Future<SuperTabController> open(String id) => _controllers.putIfAbsent(
    id,
    () {
      final generation = _generation;
      late final Future<SuperTabController> opening;
      opening = _open(id).catchError((Object failure, StackTrace stack) {
        // An open since a close has its own entry.
        if (_generation == generation && identical(_controllers[id], opening)) {
          _controllers.remove(id);
        }
        Error.throwWithStackTrace(failure, stack);
      });
      return opening;
    },
  );

  /// A tab closed here: its controller stops polling, notifying and saving,
  /// and the next [open] reads the Swarm afresh. What changed since the last
  /// view write is kept now, as when a tab goes away.
  void release(String id) {
    if (_viewSaves.containsKey(id)) _saveView(id);
    final future = _controllers.remove(id);
    final loaded = _loaded.remove(id);
    // One that has read nothing yet keeps what the last close kept.
    if (loaded?.snapshot case final snapshot?) _closedSnapshots[id] = snapshot;
    if (loaded != null) {
      final kept = loaded.keptFiles;
      _keptFiles.remove(id);
      if (kept.chats.isNotEmpty || kept.threads.isNotEmpty) {
        _keptFiles[id] = kept;
        if (_keptFiles.length > _keptFilesSwarms) {
          _keptFiles.remove(_keptFiles.keys.first);
        }
      }
    }
    loaded?.dispose();
    if (loaded != null) unawaited(loaded.flush().catchError((Object _) {}));
    // Still reading its saved state: that open stops ([_open]).
    if (future != null && loaded == null) _closes[id] = (_closes[id] ?? 0) + 1;
  }

  Future<SuperTabController> _open(String id) async {
    final account = _account;
    final generation = _generation;
    final closes = _closes[id];
    if (account == null) {
      throw const SuperTabFailure('SIGNED_OUT', 'Sign in to use Swarm.');
    }
    final key = 'super_tab.$account.$id';
    final raw = await storage.read(key);
    if (generation != _generation) {
      throw const SuperTabFailure('ACCOUNT_CHANGED', 'The account changed.');
    }
    if (_closes[id] != closes) {
      throw const SuperTabFailure('CLOSED', 'This Swarm was closed.');
    }
    final saved = raw == null
        ? <String, dynamic>{}
        : superTabMap(jsonDecode(raw));
    final controller =
        SuperTabController(
            tabId: id,
            accountId: account,
            initial: saved,
            request: (method, path, {body}) {
              if (generation != _generation) {
                throw const SuperTabFailure(
                  'FORBIDDEN',
                  'The account changed.',
                );
              }
              return map(method, path, body: body);
            },
            save: (state) => storage.write(key, jsonEncode(state)),
            upload: upload,
            reading: _reading,
            stillListed: onTabs == null ? null : () => _stillListed(id),
          )
          ..pageHidden = !_pageVisible
          ..away = _isAway(id)
          ..pushUntil = _pushUntil;
    if (_keptFiles.remove(id) case final kept?) controller.adoptFiles(kept);
    var seenChange = -1;
    var seenSelected = controller.selectedId;
    var seenThread = controller.threadOnScreen;
    controller.addListener(() {
      if (_reading.drawsSaved && generation == _generation) {
        if (controller.accessRevoked) {
          _viewSaves.remove(id)?.cancel();
          unawaited(_views.forget(account, id).catchError((Object _) {}));
        } else if (controller.viewVersion != _viewVersions[id]) {
          // Kept only when what it holds changed; none while a saved view
          // is still on screen ([SuperTabController.savedView]).
          _saveViewSoon(id);
        }
      }
      // A thread opened or closed beside the chat is a selection too: the
      // round dial's face follows it.
      if (controller.selectedId != seenSelected ||
          controller.threadOnScreen != seenThread) {
        seenSelected = controller.selectedId;
        seenThread = controller.threadOnScreen;
        onSelection?.call(controller);
      }
      if (controller.snapshot != null) {
        // Its own state replaces what a close kept.
        _closedSnapshots.remove(id);
        if (controller.lastChangedAt != seenChange) {
          seenChange = controller.lastChangedAt;
          onSnapshot?.call(controller);
        }
      }
    });
    if (onChatMessage case final told?) {
      SuperTabChatNotices.of(controller).onMessage = (group, sequence) =>
          told(id, group, sequence);
    }
    if (onNotices case final changed?) {
      // A read mark moved here, or a message arrived: told only when which agents ask moves.
      var asking = const <String>[];
      controller.addListener(() {
        final now = [
          for (final (_, chat) in superTabAgentsAsking(controller)) chat.id,
        ];
        if (listEquals(now, asking)) return;
        asking = now;
        changed();
      });
    }
    _loaded[id] = controller;
    void drawSaved(Map<String, dynamic>? view) {
      if (view != null && generation == _generation) {
        controller.drawSaved(view);
      }
    }

    // Desktop's saved view is a local file, read before the first read so
    // that read asks only for what changed since it. It waits its turn
    // behind the views' other work; past a short wait, it opens with none.
    if (_reading.drawsSaved && _reading.confirmsSaved) {
      drawSaved(
        await _views
            .readInTurn(account, id)
            .timeout(_viewLockWait, onTimeout: () => null),
      );
    }
    controller.start();
    // After the first read is asked for: reading and drawing a saved view
    // takes the main thread a moment a phone's first read need not wait on.
    // Drawn when it is read, unless that read landed first; the open waits
    // for neither.
    if (_reading.drawsSaved && !_reading.confirmsSaved) {
      unawaited(_views.read(account, id).then(drawSaved));
    }
    return controller;
  }

  void dispose() => bind(null);
}
