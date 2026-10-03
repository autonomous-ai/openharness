import 'dart:async';

import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart';
import '../shared/widgets/app_menu.dart';
import 'coding_memory_connection.dart';
import 'coding_memory_library.dart';

/// Searches host-known projects. Choosing a row opens a preview, never a write.
class CodingMemoryProjectPicker extends StatefulWidget {
  const CodingMemoryProjectPicker({
    super.key,
    required this.library,
    required this.enabled,
    required this.onPick,
    required this.onQueryChanged,
    this.initialQuery = '',
  });
  final CodingMemoryLibrary library;
  final bool enabled;
  final ValueChanged<Map<String, dynamic>> onPick;
  final ValueChanged<String> onQueryChanged;
  final String initialQuery;

  @override
  State<CodingMemoryProjectPicker> createState() =>
      _CodingMemoryProjectPickerState();
}

class _CodingMemoryProjectPickerState extends State<CodingMemoryProjectPicker> {
  late final _search = TextEditingController(text: widget.initialQuery);
  List<Map<String, dynamic>> _items = [];
  Timer? _debounce;
  int _request = 0;
  int? _nextBefore;
  bool _loading = true;
  String? _error;
  late int _seenChanges;

  @override
  void initState() {
    super.initState();
    _seenChanges = widget.library.changes;
    widget.library.addListener(_ownerChanged);
    unawaited(_load());
  }

  void _ownerChanged() {
    if (!mounted) return;
    if (widget.library.valid && _seenChanges == widget.library.changes) return;
    _seenChanges = widget.library.changes;
    ++_request;
    _debounce?.cancel();
    if (!widget.library.valid) _search.clear();
    setState(() {
      _items = [];
      _nextBefore = null;
      _loading = false;
      _error = widget.library.valid
          ? null
          : codingMemoryError(const CodingMemoryFailure('OWNER_CHANGED'));
    });
    if (widget.library.valid) unawaited(_load());
  }

  void _queryChanged(String value) {
    widget.onQueryChanged(value);
    ++_request; // An older reply cannot restore rows from the previous query.
    _debounce?.cancel();
    setState(() {
      _items = [];
      _nextBefore = null;
      _error = null;
      _loading = true;
    });
    _debounce = Timer(
      const Duration(milliseconds: 200),
      () => unawaited(_load()),
    );
  }

  Future<void> _load({bool more = false}) async {
    _debounce?.cancel();
    if (!widget.library.valid || (more && _nextBefore == null)) return;
    final request = ++_request;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final page = await widget.library.projects(
        search: _search.text,
        before: more ? _nextBefore : null,
      );
      if (!mounted || request != _request || !widget.library.valid) return;
      final items = (page['items'] as List).map(memoryMap).toList();
      setState(() {
        _items = more ? [..._items, ...items] : items;
        _nextBefore = (page['nextBefore'] as num?)?.toInt();
        _loading = false;
      });
    } catch (error) {
      if (!mounted || request != _request) return;
      setState(() {
        _items = [];
        _nextBefore = null;
        _loading = false;
        _error = codingMemoryError(error);
      });
    }
  }

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Text(
        'Choose where this memory should apply. Its meaning and evidence will stay the same.',
        style: AppType.body(color: AppPalette.textPrimary),
      ),
      const SizedBox(height: 16),
      TextField(
        controller: _search,
        autofocus: true,
        enabled: widget.enabled && widget.library.valid,
        maxLength: 200,
        decoration: const InputDecoration(
          labelText: 'Search projects',
          counterText: '',
        ),
        onChanged: _queryChanged,
        onSubmitted: (_) => unawaited(_load()),
      ),
      const SizedBox(height: 12),
      if (_loading) const LinearProgressIndicator(),
      if (_error != null) ...[
        Text(_error!, style: AppType.body(color: AppPalette.textPrimary)),
        TextButton(
          onPressed: widget.enabled && widget.library.valid ? _load : null,
          child: const Text('Try again'),
        ),
      ] else if (!_loading && _items.isEmpty)
        Text(
          _search.text.trim().isEmpty
              ? 'No projects are available yet. Open a coding project with memory enabled to make it available here.'
              : 'No projects match this search.',
          style: AppType.body(color: AppPalette.textPrimary),
        ),
      for (final project in _items)
        if (widget.enabled && widget.library.valid)
          Tooltip(
            message:
                project['location'] as String? ?? project['name'] as String,
            child: AppMenuItem(
              label: project['name'] as String,
              detail: project['location'] as String?,
              metrics: AppMenuRowMetrics.roomy,
              onPressed: () => widget.onPick(project),
            ),
          )
        else
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 8),
            child: Text(
              project['name'] as String,
              style: AppType.body(color: AppPalette.textPrimary),
            ),
          ),
      if (_nextBefore != null)
        TextButton(
          onPressed: widget.enabled && !_loading && widget.library.valid
              ? () => _load(more: true)
              : null,
          child: const Text('More projects'),
        ),
    ],
  );

  @override
  void dispose() {
    ++_request;
    _debounce?.cancel();
    widget.library.removeListener(_ownerChanged);
    _search.dispose();
    super.dispose();
  }
}
