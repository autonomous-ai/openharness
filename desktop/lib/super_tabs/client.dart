import 'dart:async';
import 'dart:convert';

import 'package:clock/clock.dart';
import 'package:flutter/foundation.dart';

import '../core/local_key_value_store.dart';
import 'attachment_upload.dart';
import 'controller.dart';
import 'model.dart';
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
    required this.storage,
    LocalKeyValueStore? viewStorage,
    this.onSnapshot,
    this.onTabs,
    this.onSelection,
    this.onMention,
    this.onTagCounts,
    this.upload = refuseUpload,
    this.discoveryInterval = const Duration(seconds: 15),
  }) : viewStorage = viewStorage ?? storage;
  final SuperTabTransport transport;
  final LocalKeyValueStore storage;

  /// Where each Swarm's saved view is kept ([SuperTabSavedViews]): a few
  /// hundred KB each, so Desktop keeps them out of [storage]'s small file.
  final LocalKeyValueStore viewStorage;
  final void Function(SuperTabController)? onSnapshot;
  final void Function(List<SuperTabListing>, Set<String> hidden)? onTabs;

  /// A tab's selected conversation changed, by a click here or by a device.
  final void Function(SuperTabController)? onSelection;

  /// A Lead tagged this account in one of its Swarms while the app was open.
  final void Function(SuperTabMention)? onMention;

  /// The waiting tags of a Swarm that is not open changed ([waitingTags]).
  final void Function()? onTagCounts;
  final _tagCounts = <String, int>{};
  final _tagsSeen = <String, Set<String>>{};

  /// The tags waiting for this account in a Swarm: its own state once open,
  /// else what discovery last read, so a tab not opened yet still shows them.
  /// A Swarm paused while away ([SuperTabReading.pausesAway]) reads nothing:
  /// discovery's count is the fresh one until it is shown again.
  int waitingTags(String id) {
    final counted = _tagCounts[id];
    if (counted != null && _paused(id)) return counted;
    return _loaded[id]?.snapshot?.mentionsWaiting ?? _tagCounts[id] ?? 0;
  }

  /// The unread messages in this account's own PM chats in a Swarm open
  /// here ([SuperTabController.pmUnread]); none for one not open.
  int waitingPm(String id) => _loaded[id]?.pmUnread ?? 0;

  /// Open here, but not polling: not on screen while the reading pauses.
  bool _paused(String id) =>
      _reading.pausesAway && (_loaded[id]?.away ?? false);
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
  set pageVisible(bool visible) {
    if (_pageVisible == visible) return;
    _pageVisible = visible;
    _applyAway();
  }

  bool _isAway(String id) => !_pageVisible || id != _shown;

  late final _views = SuperTabSavedViews(viewStorage);
  final _viewSaves = <String, Timer>{};
  final _viewSavedAt = <String, DateTime>{};
  final _viewVersions = <String, int>{};

  /// Only the account using this device keeps views on it: any other one,
  /// after a reload too, is forgotten ([SuperTabSavedViews.claim]).
  void _claimViews() {
    if (!_reading.drawsSaved) return;
    unawaited(_views.claim(_account).catchError((Object _) {}));
  }

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
      // Back on screen, the Swarm reads its own tags: the count discovery
      // kept while it was away is stale from now on.
      if (!away && entry.value.away) _tagCounts.remove(entry.key);
      entry.value.away = away;
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
  Future<void> _savingHidden = Future.value();
  Set<String> _hidden = {};
  final _creating = <String>{};
  final _visibility = <String, bool>{};
  Object? discoveryError;
  final _controllers = <String, Future<SuperTabController>>{};
  final _loaded = <String, SuperTabController>{};
  SuperTabController? peek(String id) => _loaded[id];
  Iterable<SuperTabController> get loadedControllers => _loaded.values;

  /// Native close actions name the machine's harness id, not the Swarm agent id.
  String? leadProtectionReasonForHarness(String machineId, String harnessId) {
    for (final controller in loadedControllers) {
      final snapshot = controller.snapshot;
      if (snapshot == null) continue;
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

  void bind(String? account) {
    if (_account == account) return;
    for (final timer in _viewSaves.values) {
      timer.cancel();
    }
    _viewSaves.clear();
    _viewSavedAt.clear();
    _viewVersions.clear();
    _account = account;
    // Nothing of an account that left stays on this device.
    _claimViews();
    _generation++;
    _discoveryTimer?.cancel();
    _discovering = null;
    _loadingHidden = null;
    _hidden = {};
    _creating.clear();
    _visibility.clear();
    _tagCounts.clear();
    _tagsSeen.clear();
    discoveryError = null;
    for (final controller in _loaded.values) {
      controller.revokeAccess('The account changed. Open this Swarm again.');
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
    if (account != null &&
        onTabs != null &&
        discoveryInterval > Duration.zero) {
      unawaited(refreshTabs());
      _discoveryTimer = Timer.periodic(
        discoveryInterval,
        (_) => unawaited(refreshTabs()),
      );
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
    final generation = _generation;
    final account = _account!;
    final read = () async {
      try {
        await _readHidden(account, generation);
        if (generation != _generation) return;
        final tabs = <String, SuperTabListing>{};
        final cursors = <String>{};
        String? after;
        do {
          final page = await map(
            'GET',
            '/api/super-tabs/list${after == null ? '' : '?after=${Uri.encodeComponent(after)}'}',
          );
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
          }
          after = page['next'] as String?;
          if (after != null && !cursors.add(after)) {
            throw const FormatException('Repeated tab cursor');
          }
        } while (after != null);
        discoveryError = null;
        final hidden = Set<String>.unmodifiable({..._hidden, ..._creating});
        onTabs!(tabs.values.toList(), hidden);
        await _readTags([
          for (final id in tabs.keys)
            if (!hidden.contains(id) &&
                (!_loaded.containsKey(id) || _paused(id)))
              id,
        ], generation);
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

  Future<SuperTabController> open(String id) =>
      _controllers.putIfAbsent(id, () {
        final generation = _generation;
        return _open(id).catchError((Object failure, StackTrace stack) {
          if (_generation == generation) _controllers.remove(id);
          Error.throwWithStackTrace(failure, stack);
        });
      });

  Future<SuperTabController> _open(String id) async {
    final account = _account;
    final generation = _generation;
    if (account == null) {
      throw const SuperTabFailure('SIGNED_OUT', 'Sign in to use Swarm.');
    }
    final key = 'super_tab.$account.$id';
    final raw = await storage.read(key);
    if (generation != _generation) {
      throw const SuperTabFailure('ACCOUNT_CHANGED', 'The account changed.');
    }
    final saved = raw == null
        ? <String, dynamic>{}
        : superTabMap(jsonDecode(raw));
    final controller = SuperTabController(
      tabId: id,
      accountId: account,
      initial: saved,
      request: (method, path, {body}) {
        if (generation != _generation) {
          throw const SuperTabFailure('FORBIDDEN', 'The account changed.');
        }
        return map(method, path, body: body);
      },
      save: (state) => storage.write(key, jsonEncode(state)),
      upload: upload,
      reading: _reading,
    )..away = _isAway(id);
    var seenChange = (lastChangedAt: -1, mentionsWaiting: -1, pmUnread: -1);
    var seenSelected = controller.selectedId;
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
      if (controller.selectedId != seenSelected) {
        seenSelected = controller.selectedId;
        onSelection?.call(controller);
      }
      if (controller.snapshot case final snapshot?) {
        final change = (
          lastChangedAt: controller.lastChangedAt,
          mentionsWaiting: snapshot.mentionsWaiting,
          // A read mark or a PM chat's messages move the Swarm badge too.
          pmUnread: controller.pmUnread,
        );
        if (change != seenChange) {
          seenChange = change;
          onSnapshot?.call(controller);
        }
      }
    });
    // What discovery already announced is not news when the Swarm opens.
    SuperTabMentions.of(controller)
      ..seen(_tagsSeen.remove(id))
      ..onArrived = onMention;
    _tagCounts.remove(id);
    _loaded[id] = controller;
    Future<void> drawSaved() async {
      // Behind the lock shared with this browser's other tabs: one iOS has
      // suspended may hold it. Past a short wait, open with no saved view.
      final view = await _views
          .read(account, id)
          .timeout(_viewLockWait, onTimeout: () => null);
      if (view != null && generation == _generation) {
        controller.drawSaved(view);
      }
    }

    // Desktop's saved view is a local file, read before the first read so
    // that read asks only for what changed since it.
    if (_reading.drawsSaved && _reading.confirmsSaved) await drawSaved();
    controller.start();
    // After the first read is asked for: reading and drawing a saved view
    // takes the main thread a moment a phone's first read need not wait on.
    if (_reading.drawsSaved && !_reading.confirmsSaved) await drawSaved();
    return controller;
  }

  /// One light read per Swarm tab that is not open: its waiting tags. A
  /// failed read, a backend before tags included, changes nothing and is
  /// tried again on the next round.
  Future<void> _readTags(List<String> ids, int generation) async {
    var changed = false;
    for (final id in ids) {
      try {
        final answer = await map(
          'GET',
          '/api/super-tabs/${Uri.encodeComponent(id)}/mentions?state=waiting',
        );
        if (generation != _generation ||
            (_loaded.containsKey(id) && !_paused(id))) {
          continue;
        }
        final waiting = [
          for (final row in answer['mentions'] as List)
            SuperTabMention.fromJson(superTabMap(row)),
        ];
        // A paused Swarm already knows the tags it read before it was away.
        final mentions = _loaded[id] == null
            ? null
            : SuperTabMentions.of(_loaded[id]!);
        final seen = mentions == null
            ? _tagsSeen[id]
            : {...?_tagsSeen[id], for (final m in mentions.waiting) m.id};
        final told = <String>{};
        if (seen != null) {
          for (final mention in waiting.reversed) {
            if (!seen.contains(mention.id)) {
              onMention?.call(mention);
              told.add(mention.id);
            }
          }
        }
        // Not news again when the Swarm is shown and reads its own.
        mentions?.seen(told);
        _tagsSeen[id] = {...?seen, for (final m in waiting) m.id};
        if (_tagCounts[id] != waiting.length) {
          _tagCounts[id] = waiting.length;
          changed = true;
        }
      } catch (_) {}
    }
    if (changed && generation == _generation) onTagCounts?.call();
  }

  void dispose() => bind(null);
}
