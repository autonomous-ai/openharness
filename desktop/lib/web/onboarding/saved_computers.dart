import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';

import '../../core/harness_file_store.dart';
import '../../core/local_key_value_store.dart';
import '../../state/app_state.dart';
import 'web_your_computers.dart';

/// One of the account's computers as the connect page last listed it: its
/// name and id, nothing about how to reach it.
@immutable
class SavedComputer {
  const SavedComputer({required this.id, required this.name});

  final String id;
  final String name;

  Map<String, String> toJson() => {'id': id, 'name': name};

  static SavedComputer? fromJson(Object? raw) =>
      raw is Map && raw['id'] is String && raw['name'] is String
      ? SavedComputer(id: raw['id'] as String, name: raw['name'] as String)
      : null;

  @override
  bool operator ==(Object other) =>
      other is SavedComputer && other.id == id && other.name == name;

  @override
  int get hashCode => Object.hash(id, name);

  @override
  String toString() => 'SavedComputer($id, $name)';
}

/// The account's computers kept in this browser, so the connect page can list
/// them before the machine list answers. Kept like a saved Super Tab view
/// (`super_tabs/saved_view.dart`): for the one account using this browser, and
/// forgotten when another signs in or this one signs out.
class SavedComputers {
  SavedComputers(this.storage);

  final LocalKeyValueStore storage;

  String _key(String account) => 'web.computers.$account';

  /// The account whose computers this browser keeps.
  static const _owner = 'web.computers.saved_by';

  Future<void> _tail = Future.value();

  /// One operation at a time here, and across this browser's tabs under its lock.
  Future<T> _serial<T>(Future<T> Function() action) {
    final run = _tail.then(
      (_) => storage.synchronized('web.computers', action),
    );
    _tail = run.then((_) {}, onError: (Object _) {});
    return run;
  }

  /// [account]'s computers, or null: none kept, unreadable, or a storage that
  /// refuses (full, private mode). It never throws.
  Future<List<SavedComputer>?> read(String account) => _serial(() async {
    try {
      if (await storage.read(_owner) != account) return null;
      final raw = await storage.read(_key(account));
      if (raw == null) return null;
      final list = jsonDecode(raw);
      if (list is! List) return null;
      return [for (final row in list) ?SavedComputer.fromJson(row)];
    } catch (_) {
      return null;
    }
  });

  /// Keeps [computers] for [account]. Only for the account using this
  /// browser: a late write after a sign-out or another account's claim keeps
  /// nothing.
  Future<void> write(String account, List<SavedComputer> computers) =>
      _serial(() async {
        try {
          if (await storage.read(_owner) != account) return;
          await storage.write(_key(account), jsonEncode(computers));
        } catch (_) {}
      });

  /// [account] (null when signed out) is the one using this browser now:
  /// any other's computers, kept before a reload too, are forgotten.
  Future<void> claim(String? account) => _serial(() async {
    try {
      final owner = await storage.read(_owner);
      if (owner == account) return;
      if (owner != null) await storage.delete(_key(owner));
      if (account == null) {
        await storage.delete(_owner);
      } else {
        await storage.write(_owner, account);
      }
    } catch (_) {}
  });
}

/// Keeps the computers the connect page lists in [store] whenever the machine
/// list answers, and offers the kept ones ([shown]) until it does: a
/// returning browser sees its computers at once rather than "Finding your
/// computers…" for as long as the list takes.
class SavedComputersWatch extends ChangeNotifier {
  SavedComputersWatch(this.app, this.store) {
    app.addListener(_changed);
    _changed();
  }

  final AppNotifier app;
  final SavedComputers store;

  String? _account;
  List<SavedComputer>? _kept;
  List<SavedComputer>? _written;
  List<SavedComputer>? _wasShown;

  /// The kept computers while the machine list has not answered; null once
  /// it has, or with none kept.
  List<SavedComputer>? get shown => app.machineInventoryLoaded ? null : _kept;

  void _changed() {
    final account = app.currentUser?.id;
    if (account != _account) _bind(account);
    // The list answering takes the kept computers off the page.
    if (!identical(shown, _wasShown)) {
      _wasShown = shown;
      notifyListeners();
    }
    if (account == null || !app.machineInventoryLoaded) return;
    final listed = [
      for (final state in WebYourComputers.listed(app))
        SavedComputer(
          id: state.machine.machineId,
          name: state.machine.displayName,
        ),
    ];
    if (listEquals(listed, _written)) return;
    _written = listed;
    unawaited(store.write(account, listed));
  }

  void _bind(String? account) {
    _account = account;
    _kept = null;
    _written = null;
    final claimed = store.claim(account);
    if (account == null) return;
    unawaited(
      claimed.then((_) => store.read(account)).then((kept) {
        if (_account != account || kept == null || kept.isEmpty) return;
        _kept = kept;
        _changed();
      }),
    );
  }

  @override
  void dispose() {
    app.removeListener(_changed);
    super.dispose();
  }
}

/// The one [SavedComputersWatch] of [app], kept in this browser's storage.
/// The web workspace asks for it when it is first drawn, so the list is kept
/// whenever it answers, not only once the connect page shows.
SavedComputersWatch savedComputersOf(AppNotifier app) =>
    _watches[app] ??= SavedComputersWatch(
      app,
      SavedComputers(app.localStore ?? HarnessFileStore.shared),
    );

final _watches = Expando<SavedComputersWatch>('savedComputersOf');
