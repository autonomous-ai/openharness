import 'package:flutter/foundation.dart';

import '../state/dial_status.dart';

/// A host is an owned machine, not a shared harness or a caller-supplied route.
class DeviceHost {
  const DeviceHost({
    required this.id,
    required this.name,
    required this.online,
    this.local = false,
    this.available = false,
    this.status = DialStatus.none,
    this.error,
    this.revision,
  });
  final String id, name;
  final bool local, online, available;
  final DialStatus status;
  final String? error;
  final int? revision;
  List<DialStatus> get devices => status.devices.isNotEmpty
      ? status.devices
      : status.attached || status.settings != null
      ? [status]
      : const [];
}

/// Isolated from workspace repaint notifications and cleared on account changes.
class DeviceHosts extends ChangeNotifier {
  final _hosts = <String, DeviceHost>{};
  List<DeviceHost> get hosts => List.unmodifiable(_hosts.values);
  DeviceHost? host(String id) => _hosts[id];

  void reconcile(Iterable<DeviceHost> inventory) {
    final ids = <String>{};
    var changed = false;
    for (final item in inventory) {
      ids.add(item.id);
      final old = _hosts[item.id];
      if (old != null &&
          old.name == item.name &&
          old.local == item.local &&
          old.online == item.online &&
          (item.error == null || old.error == item.error)) {
        continue;
      }
      _hosts[item.id] = DeviceHost(
        id: item.id,
        name: item.name,
        local: item.local,
        online: item.online,
        available: old?.online == true && item.online && old!.available,
        status: old?.status ?? DialStatus.none,
        error: item.error,
        revision: old?.online == true && item.online ? old?.revision : null,
      );
      changed = true;
    }
    final removed = _hosts.keys.where((id) => !ids.contains(id)).toList();
    for (final id in removed) {
      _hosts.remove(id);
    }
    if (changed || removed.isNotEmpty) notifyListeners();
  }

  void receive(String id, DialStatus status, {int? revision}) {
    final old = _hosts[id];
    if (old == null || !old.online) return;
    if (revision != null && old.revision != null && revision < old.revision!) {
      return;
    }
    _hosts[id] = DeviceHost(
      id: id,
      name: old.name,
      local: old.local,
      online: true,
      available: true,
      status: status,
      revision: revision ?? old.revision,
    );
    notifyListeners();
  }

  void failed(String id, String message) {
    final old = _hosts[id];
    if (old == null) return;
    _hosts[id] = DeviceHost(
      id: id,
      name: old.name,
      local: old.local,
      online: old.online,
      available: false,
      status: old.status,
      error: message,
      revision: old.revision,
    );
    notifyListeners();
  }

  void clear() {
    _hosts.clear();
    notifyListeners();
  }
}
