import 'swarm_search_field.dart';

import 'package:flutter/material.dart';

import '../shared/widgets/app_dialog.dart';
import '../state/app_state.dart';
import '../state/swarm_attention.dart';
import '../state/swarm_navigation.dart';
import 'engine_identity.dart';

Future<SwarmAttentionEntry?> showSwarmAttention(
  BuildContext context,
  AppNotifier app,
  SwarmNavigationHistory history,
) => showAppDialog<SwarmAttentionEntry>(
  context: context,
  transitionDuration: Duration.zero,
  veilBlur: 0,
  builder: (_) => _SwarmAttention(app: app, recent: history.recent),
);

class _SwarmAttention extends StatefulWidget {
  const _SwarmAttention({required this.app, required this.recent});
  final AppNotifier app;
  final List<String> recent;

  @override
  State<_SwarmAttention> createState() => _SwarmAttentionState();
}

class _SwarmAttentionState extends State<_SwarmAttention> {
  final _scroll = ScrollController();
  late List<SwarmAttentionEntry> _catalog;
  List<SwarmAttentionEntry> _rows = [];
  String _query = '';
  String? _selectedId;
  int _cursor = 0;
  double _rowHeight = 104;
  bool _revealScheduled = false;
  late final _targetName = widget.app.activeSwarm.name;

  @override
  void initState() {
    super.initState();
    _refreshCatalog();
    widget.app.addListener(_onAppChanged);
  }

  void _onAppChanged() => setState(_refreshCatalog);

  void _refreshCatalog() {
    _catalog = swarmAttentionEntries(widget.app, recent: widget.recent);
    _filter();
  }

  void _filter() {
    _rows = filterSwarmAttention(_catalog, _query);
    final index = _rows.indexWhere((row) => row.id == _selectedId);
    _cursor = _rows.isEmpty
        ? 0
        : index >= 0
        ? index
        : _cursor.clamp(0, _rows.length - 1);
    _selectedId = _rows.isEmpty ? null : _rows[_cursor].id;
    _revealSelection();
  }

  void _move(int delta) {
    if (_rows.isEmpty) return;
    setState(() {
      _cursor = (_cursor + delta) % _rows.length;
      _selectedId = _rows[_cursor].id;
    });
    // The list dimensions are already known during a key event. Move before
    // paint so the new highlight and its row arrive in the same frame.
    _scrollToSelection();
  }

  void _revealSelection() {
    if (_revealScheduled) return;
    _revealScheduled = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _revealScheduled = false;
      if (mounted) _scrollToSelection();
    });
  }

  void _scrollToSelection() {
    if (!_scroll.hasClients || _rows.isEmpty) return;
    final top = _cursor * _rowHeight;
    final bottom = top + _rowHeight;
    final position = _scroll.position;
    final offset = top < position.pixels
        ? top
        : bottom > position.pixels + position.viewportDimension
        ? bottom - position.viewportDimension
        : position.pixels;
    final target = offset.clamp(0.0, position.maxScrollExtent);
    if (target != position.pixels) _scroll.jumpTo(target);
  }

  void _submit() {
    if (_rows.isNotEmpty && _rows[_cursor].available) {
      Navigator.pop(context, _rows[_cursor]);
    }
  }

  @override
  void dispose() {
    widget.app.removeListener(_onAppChanged);
    _scroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final scale = MediaQuery.textScalerOf(context);
    _rowHeight = (scale.scale(13) * 1.35 * 3 + scale.scale(11) * 1.3 + 36)
        .clamp(104, double.infinity);
    final selected = _rows.isEmpty ? null : _rows[_cursor];
    return Dialog(
      alignment: const Alignment(0, -0.5),
      insetPadding: const EdgeInsets.symmetric(horizontal: 24, vertical: 48),
      child: SizedBox(
        width: 660,
        height: 560,
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            children: [
              Row(
                children: [
                  const Text('Needs input', style: TextStyle(fontSize: 16)),
                  const SizedBox(width: 8),
                  Text(
                    '${_catalog.length}',
                    style: const TextStyle(fontSize: 13, color: Colors.white54),
                  ),
                  const Spacer(),
                  IconButton(
                    tooltip: 'Close notifications',
                    onPressed: () => Navigator.pop(context),
                    icon: const Icon(Icons.close, size: 18),
                  ),
                ],
              ),
              const SizedBox(height: 8),
              SwarmSearchField(
                autofocus: true,
                hintText: 'Find a question, agent, or project',
                onChanged: (value) => setState(() {
                  _query = value;
                  _cursor = 0;
                  _selectedId = null;
                  _filter();
                }),
                onMove: _move,
                onSubmitted: _submit,
              ),
              const SizedBox(height: 12),
              Expanded(
                child: _rows.isEmpty
                    ? Center(
                        child: Text(
                          _catalog.isEmpty
                              ? 'No agents need your input'
                              : 'No matching questions',
                          style: const TextStyle(
                            fontSize: 13,
                            color: Colors.white60,
                          ),
                        ),
                      )
                    : ListView.builder(
                        controller: _scroll,
                        itemCount: _rows.length,
                        itemExtent: _rowHeight,
                        itemBuilder: (context, index) {
                          final row = _rows[index];
                          final destination = row.destination;
                          return ListTile(
                            key: ValueKey(row.id),
                            enabled: row.available,
                            selected: index == _cursor,
                            selectedColor: Colors.white,
                            selectedTileColor: Colors.white10,
                            shape: RoundedRectangleBorder(
                              borderRadius: BorderRadius.circular(8),
                            ),
                            contentPadding: const EdgeInsets.symmetric(
                              horizontal: 12,
                            ),
                            leading: EngineMark(
                              engine: destination.engine,
                              size: 20,
                            ),
                            title: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                Text(
                                  destination.title,
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: const TextStyle(
                                    fontSize: 13,
                                    height: 1.35,
                                    fontWeight: FontWeight.w500,
                                  ),
                                ),
                                const SizedBox(height: 2),
                                Text(
                                  row.question.prompt,
                                  maxLines: 2,
                                  overflow: TextOverflow.ellipsis,
                                  style: const TextStyle(
                                    fontSize: 13,
                                    height: 1.35,
                                    color: Colors.white70,
                                  ),
                                ),
                                const SizedBox(height: 4),
                                Text(
                                  destination.detail,
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: const TextStyle(
                                    fontSize: 11,
                                    height: 1.3,
                                    color: Colors.white54,
                                  ),
                                ),
                              ],
                            ),
                            trailing: Text(
                              !row.available
                                  ? 'Unavailable'
                                  : destination.hasView
                                  ? 'Jump'
                                  : 'Open Harness',
                              style: const TextStyle(
                                fontSize: 11,
                                color: Colors.white54,
                              ),
                            ),
                            onTap: row.available
                                ? () => Navigator.pop(context, row)
                                : null,
                          );
                        },
                      ),
              ),
              const SizedBox(height: 12),
              Align(
                alignment: Alignment.centerLeft,
                child: Text(
                  selected != null && !selected.available
                      ? 'This agent’s terminal is unavailable · Esc to close'
                      : selected != null && !selected.destination.hasView
                      ? '↵ Open Harness in $_targetName · Esc to close'
                      : '↑↓ or ⌃N ⌃P to choose · Return to jump · Esc to close',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 11, color: Colors.white54),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
