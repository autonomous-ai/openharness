import 'dart:convert';

import 'package:flutter/foundation.dart';

import 'package:harness_mobile/core/harness_file_store.dart';
import 'package:harness_mobile/core/local_key_value_store.dart';

/// How an agent opens on this phone: its terminal, or its conversation as chat (`chat/chat_view.dart`).
///
/// Settings ▸ Chat UI sets the default for every agent; the header's switch flips one agent away from it.
/// Both are this phone's own, in its state file — the desktop and other phones keep their terminal.
///
/// ⚠️ **Terminal is the default.** Chat is read from the agent's transcript, which says less than its
/// screen (no tool output, no thinking, no images over the relay), so it is opt-in.
class ChatViewStore extends ChangeNotifier {
  ChatViewStore({LocalKeyValueStore? storage})
    : _storage = storage ?? HarnessFileStore.shared;

  static const _defaultKey = 'chat_ui_default';
  static const _overridesKey = 'chat_ui_agents';

  /// The most per-agent choices kept: the oldest goes first. An agent long deleted leaves its choice
  /// behind, and nothing else would ever clear it.
  static const maxOverrides = 200;

  LocalKeyValueStore _storage;

  /// Where the shared [chatViewStore] keeps its choice, swapped by a widget test: the state file's
  /// lock waits on real I/O, which a fake-clock test never lets finish.
  @visibleForTesting
  set storageForTest(LocalKeyValueStore storage) => _storage = storage;

  bool _chatByDefault = false;

  /// `machineId\u0000agentId` → true for chat, false for the terminal; insertion order is age.
  final Map<String, bool> _overrides = {};

  /// Whether agents open as chat unless switched one by one.
  bool get chatByDefault => _chatByDefault;

  static String _key(String machineId, String agentId) =>
      '$machineId\u0000$agentId';

  /// Whether [agentId] on [machineId] shows as chat.
  bool showsChat(String machineId, String agentId) =>
      _overrides[_key(machineId, agentId)] ?? _chatByDefault;

  Future<void> load() async {
    try {
      final saved = await _storage.readMany([_defaultKey, _overridesKey]);
      _chatByDefault = saved[_defaultKey] == 'chat';
      final raw = saved[_overridesKey];
      if (raw != null) {
        final decoded = jsonDecode(raw);
        if (decoded is Map) {
          for (final entry in decoded.entries) {
            if (entry.key is String && entry.value is bool) {
              _overrides[entry.key as String] = entry.value as bool;
            }
          }
        }
      }
    } on Exception {
      // The terminal for every agent; only the memory is missing.
    }
    notifyListeners();
  }

  /// Settings ▸ Chat UI. Clears every per-agent choice: the switch says how ALL agents open.
  Future<void> setChatByDefault(bool on) async {
    if (on == _chatByDefault && _overrides.isEmpty) return;
    _chatByDefault = on;
    _overrides.clear();
    notifyListeners();
    await _save();
  }

  /// The header's switch, for one agent.
  Future<void> setShowsChat(String machineId, String agentId, bool chat) async {
    if (showsChat(machineId, agentId) == chat) return;
    final key = _key(machineId, agentId);
    _overrides.remove(key);
    if (chat != _chatByDefault) _overrides[key] = chat;
    while (_overrides.length > maxOverrides) {
      _overrides.remove(_overrides.keys.first);
    }
    notifyListeners();
    await _save();
  }

  Future<void> _save() async {
    try {
      await _storage.write(_defaultKey, _chatByDefault ? 'chat' : 'terminal');
      await _storage.write(_overridesKey, jsonEncode(_overrides));
    } on Exception {
      // Kept in memory for this run.
    }
  }
}

final chatViewStore = ChatViewStore();
