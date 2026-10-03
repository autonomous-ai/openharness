import 'dart:async';
import 'dart:convert';

import 'device_form.dart';
import 'swarm_navigation.dart';
import 'swarm_search.dart';

/// A remote for the real Cmd-P controller. Speech filters; a separate explicit
/// activation opens one exact existing harness through the normal app route.
class DeviceFinder {
  DeviceFinder(
    this.search, {
    required this.choose,
    required this.dismiss,
    required this.isComposing,
  }) {
    port.attach(_read, _act);
  }

  final SwarmSearchController search;
  final Future<bool> Function(SwarmSearchSelection) choose;
  final void Function() dismiss;
  final bool Function() isComposing;
  final port = DeviceFormPort(explicitGuard: true);
  bool _busy = false, _closed = false, _finished = false;
  String _error = '';
  Map<String, dynamic> _last = {};

  bool get supported =>
      search.scopePrefix.isEmpty &&
      !search.isHelpMode &&
      !search.isCommandMode &&
      search.setupLayout &&
      !search.managing &&
      search.split == null;

  Map<String, dynamic> _read() {
    if (_finished) {
      return {'active': false, 'ok': _error.isEmpty, 'error': _error};
    }
    if (_closed && !_busy) return {'active': false};
    if (_busy) {
      return {
        ..._last,
        'busy': true,
        'enabled': false,
        'canQuery': false,
        'status': 'Opening...',
        'guard': 'opening',
      };
    }
    final row = search.selected;
    final valid =
        supported &&
        row?.agentId != null &&
        !row!.isCreate &&
        !row.isCommand &&
        !row.isModel &&
        !row.isStoreEntry;
    final enabled = valid && search.canSubmit(row);
    final composing = isComposing();
    String at(int index) => index >= 0 && index < search.rows.length
        ? search.rows[index].title
        : '';
    return _last = {
      'active': true, 'title': 'Find Harness',
      'label':
          row?.title ?? (search.rows.isEmpty ? 'No matches' : 'Say a name'),
      'detail': row?.terminalDetail ?? row?.detail ?? 'Or drag to browse',
      'previous': at(search.cursor - 1), 'next': at(search.cursor + 1),
      'position': search.cursor < 0 ? 0 : search.cursor + 1,
      'total': search.rows.length, 'busy': false,
      'enabled': enabled && !composing, 'canQuery': supported && !composing,
      'query': search.query, 'status': '',
      'action': 'open',
      'error': _error.isNotEmpty
          ? _error
          : !supported
          ? 'Continue this picker on desktop.'
          : row?.isCreate == true
          ? 'Use New Harness to start new work.'
          : valid && !enabled
          ? search.sessionUnavailable(row) ?? search.unavailableMessage
          : '',
      // Status/age/preview refreshes must not cancel a spoken name. Selection,
      // editing, scope, availability and destination changes must.
      'guard': jsonEncode([
        search.query,
        search.targetId,
        search.placement?.name,
        search.scopePrefix,
        search.draft.groupScope?.id,
        search.sessionFilter.name,
        search.scopedMachineId,
        search.scopedBranch,
        row?.id,
        row?.machineId,
        row?.agentId,
        row?.swarmId,
        row?.paneId,
        row?.closedId,
        enabled,
        supported,
        composing,
      ]),
    };
  }

  void _act(String op, int delta, String? text) {
    if (_busy || _closed || _finished || isComposing()) return;
    _error = '';
    if (op == 'back') {
      if (!search.back()) {
        if (search.query.isNotEmpty) {
          search.setQuery('');
        } else {
          dismiss();
        }
      }
    } else if (op == 'close') {
      dismiss();
    } else if (op == 'move' && supported) {
      search.move(delta);
    } else if (op == 'query' && supported && text != null) {
      final name = text
          .replaceAll(RegExp(r'[\r\n]+'), ' ')
          .trim()
          .replaceFirst(RegExp(r'[.!?。！？]+$'), '')
          .trim();
      // Names stay in harness search. Prefix commands and management scopes
      // need their own labeled entry points; STT cannot open them accidentally.
      if (name.isEmpty || RegExp(r'^[@#:*>?]').hasMatch(name)) {
        _error = 'Say a harness, project or machine name.';
      } else {
        search.setQuery(name);
      }
    } else if (op == 'activate' && _read()['enabled'] == true) {
      final choice = search.submit();
      if (choice == null) return;
      _busy = true;
      unawaited(_open(choice));
    }
  }

  Future<void> _open(SwarmSearchSelection choice) async {
    var opened = false;
    try {
      opened = await choose(choice);
    } catch (_) {
      /* Report below. */
    }
    _busy = false;
    _finished = true;
    if (opened) {
      port.detach();
    } else {
      _error = 'Could not open that harness. Check desktop, then retry.';
    }
  }

  void close() {
    _closed = true;
    if (!_busy) port.detach();
  }
}
