part of 'coding_memory_view.dart';

/// Project explanations and their original records share the owner library.
/// This is navigation only; opening a notebook never requests inference.
class _ProjectMemoryView extends StatefulWidget {
  const _ProjectMemoryView({required this.library, required this.onOpen});
  final CodingMemoryLibrary library;
  final Future<void> Function(String) onOpen;

  @override
  State<_ProjectMemoryView> createState() => _ProjectMemoryViewState();
}

class _ProjectMemoryViewState extends State<_ProjectMemoryView> {
  late CodingMemoryNotebooks notebooks;
  final _top = GlobalKey();
  final _backFocus = FocusNode();
  final _openFocus = <String, FocusNode>{};
  bool _individual = false;
  double? _indexOffset;
  int _navigation = 0;

  @override
  void initState() {
    super.initState();
    notebooks = CodingMemoryNotebooks(widget.library)..refresh();
  }

  @override
  void didUpdateWidget(_ProjectMemoryView oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.library != widget.library) {
      notebooks.dispose();
      notebooks = CodingMemoryNotebooks(widget.library)..refresh();
      _individual = false;
      _indexOffset = null;
      ++_navigation;
    }
  }

  @override
  void dispose() {
    notebooks.dispose();
    _backFocus.dispose();
    for (final node in _openFocus.values) {
      node.dispose();
    }
    super.dispose();
  }

  void _open(String id) {
    final navigation = ++_navigation;
    _indexOffset = Scrollable.maybeOf(context)?.position.pixels;
    unawaited(notebooks.open(id));
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted ||
          !notebooks.valid ||
          navigation != _navigation ||
          notebooks.selectedId != id) {
        return;
      }
      _backFocus.requestFocus();
      final top = _top.currentContext;
      if (top != null) unawaited(Scrollable.ensureVisible(top));
    });
  }

  Future<void> _back() async {
    final navigation = ++_navigation;
    final id = notebooks.selectedId;
    await notebooks.back();
    if (!mounted || navigation != _navigation) return;
    // A corrected or forgotten source also invalidates the index. Restore its
    // position after that read finishes, not against a temporary empty list.
    setState(() {});
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted ||
          !notebooks.valid ||
          navigation != _navigation ||
          notebooks.selectedId != null) {
        return;
      }
      _openFocus[id]?.requestFocus();
      final position = Scrollable.maybeOf(context)?.position;
      if (position != null && _indexOffset != null) {
        position.jumpTo(
          _indexOffset!.clamp(
            position.minScrollExtent,
            position.maxScrollExtent,
          ),
        );
      }
    });
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: notebooks,
    builder: (context, _) {
      final library = widget.library;
      final individual = _individual || notebooks.available == false;
      final busy = notebooks.busy || library.busy;
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              DesktopPill(
                label: 'Notebooks',
                selected: !individual,
                onPressed: notebooks.available == false
                    ? null
                    : () => setState(() {
                        ++_navigation;
                        _individual = false;
                      }),
              ),
              DesktopPill(
                label: 'Individual memories',
                selected: individual,
                onPressed: () => setState(() {
                  ++_navigation;
                  _individual = true;
                }),
              ),
            ],
          ),
          const SizedBox(height: 16),
          SizedBox(key: _top),
          if (individual) ...[
            _text(
              notebooks.available == false
                  ? 'Notebook explanations are not available in this local service. You can read and manage individual memories here.'
                  : 'The original decisions, findings and open questions. Read a memory to see its evidence, correct it or forget it.',
            ),
            const SizedBox(height: 16),
            if (library.items.isEmpty && !library.busy && library.error == null)
              _text('No project memories are available yet.'),
            ..._memoryRows(
              library.items,
              busy: library.busy,
              onOpen: widget.onOpen,
            ),
            if (library.nextCursor != null)
              TextButton(
                onPressed: library.busy
                    ? null
                    : () => library.refresh(more: true),
                child: const Text('Show more memories'),
              ),
          ] else ...[
            if (notebooks.selectedId != null)
              TextButton(
                focusNode: _backFocus,
                onPressed: _back,
                child: const Text('Back to notebooks'),
              ),
            if (notebooks.error != null) ...[
              _text(notebooks.error!),
              TextButton(
                onPressed: busy ? null : () => notebooks.refresh(),
                child: const Text('Refresh notebooks'),
              ),
            ],
            if (notebooks.busy)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 12),
                child: LinearProgressIndicator(),
              ),
            if (notebooks.selectedId == null) ...[
              _text(
                'A living guide to each project, drawn from saved memories. Each explanation keeps its sources and limits.',
              ),
              const SizedBox(height: 16),
              if (notebooks.items.isEmpty && !busy && notebooks.error == null)
                _text(
                  'Project notebooks appear as your companion learns about included work. Individual memories are available while a notebook is being prepared.',
                ),
              for (final item in notebooks.items)
                _memorySurface(
                  Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      _notebookHeading(item),
                      const SizedBox(height: 8),
                      _text(_notebookCounts(item), small: true),
                      _text(_notebookStatus(item, library.learn), small: true),
                      const SizedBox(height: 8),
                      TextButton(
                        focusNode: _openFocus.putIfAbsent(
                          item['id'] as String,
                          FocusNode.new,
                        ),
                        onPressed: library.busy
                            ? null
                            : () => _open(item['id'] as String),
                        child: const Text('Open notebook'),
                      ),
                    ],
                  ),
                ),
              if (notebooks.nextCursor != null)
                TextButton(
                  onPressed: busy ? null : () => notebooks.refresh(more: true),
                  child: const Text('Show more notebooks'),
                ),
            ] else if (notebooks.page != null)
              _page(notebooks.page!),
          ],
        ],
      );
    },
  );

  Widget _page(Map<String, dynamic> page) {
    final summary = memoryMap(page['summary']);
    final explanation = memoryMap(page['explanation']);
    final statements = _memoryMaps(explanation['statements']);
    final memories = memoryMap(page['memories']);
    final support = {
      for (final item in _memoryMaps(page['supporting'])) item['id']: item,
    };
    final busy = notebooks.busy || widget.library.busy;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const SizedBox(height: 12),
        _notebookHeading(summary),
        const SizedBox(height: 12),
        _text(_notebookCounts(summary), small: true),
        if (statements.isEmpty)
          _text(_notebookStatus(summary, widget.library.learn))
        else ...[
          _text(
            'An explanation from ${summary['supportingRecords']} saved ${summary['supportingRecords'] == 1 ? 'memory' : 'memories'}. It may cover only part of this topic. Read the sources to check a conclusion.',
            small: true,
          ),
          _text(
            'Updated ${_date(context, explanation['updatedAt'])}',
            small: true,
          ),
          const SizedBox(height: 12),
          for (final statement in statements) ...[
            const Divider(height: 24),
            SelectableText(
              statement['text'] as String,
              style: AppType.body(color: AppPalette.textPrimary, height: 1.5),
            ),
            const SizedBox(height: 8),
            for (final (index, source) in _memoryMaps(
              statement['supports'],
            ).indexed) ...[
              for (final constraint in _memoryMaps(
                statement['constraints'],
              ).where((c) => c['memoryId'] == source['memoryId']))
                _notebookConstraints(context, constraint, index + 1),
              Tooltip(
                message:
                    support[source['memoryId']]?['claim'] as String? ??
                    'Read the supporting memory',
                child: TextButton(
                  onPressed: busy
                      ? null
                      : () => widget.onOpen(source['memoryId'] as String),
                  child: Text(
                    'Read source ${index + 1} · revision ${source['revision']}',
                  ),
                ),
              ),
            ],
          ],
        ],
        const SizedBox(height: 24),
        Text(
          'Memories in this notebook',
          style: AppType.title(color: AppPalette.textPrimary),
        ),
        const SizedBox(height: 8),
        _text(
          'Original records, including possible memories and items needing review. Correcting or forgetting a source clears any explanation based on it.',
          small: true,
        ),
        const SizedBox(height: 16),
        ..._memoryRows(
          _memoryMaps(memories['items']),
          busy: busy,
          onOpen: widget.onOpen,
        ),
        if (memories['nextCursor'] != null)
          TextButton(
            onPressed: busy ? null : notebooks.moreMemories,
            child: const Text('Show more memories'),
          ),
      ],
    );
  }
}

List<Map<String, dynamic>> _memoryMaps(Object? value) =>
    value is List ? value.map(memoryMap).toList() : [];

Widget _notebookHeading(Map<String, dynamic> summary) {
  final project = memoryMap(summary['project']);
  final scope = memoryMap(summary['scope']);
  return Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      _text(project['name'] as String? ?? 'Project', small: true),
      Semantics(
        header: true,
        child: Text(
          summary['title'] as String? ?? 'Notebook',
          style: AppType.title(color: AppPalette.textPrimary),
        ),
      ),
      if (project['location'] != null)
        _text(project['location'] as String, small: true),
      const SizedBox(height: 4),
      _text(
        scope['taskId'] != null || scope['branchId'] != null
            ? 'Limited to the ${scope['taskId'] != null && scope['branchId'] != null
                  ? 'task and branch'
                  : scope['taskId'] != null
                  ? 'task'
                  : 'branch'} below'
            : 'For this project',
        small: true,
      ),
      if (scope['taskId'] != null)
        _text('Task reference: ${scope['taskId']}', small: true),
      if (scope['branchId'] != null)
        _text('Branch reference: ${scope['branchId']}', small: true),
    ],
  );
}

String _notebookCounts(Map<String, dynamic> summary) {
  final active = summary['activeRecords'] ?? 0;
  final unresolved = summary['unresolvedRecords'] ?? 0;
  return '$active current ${active == 1 ? 'memory' : 'memories'}'
      '${unresolved == 0 ? '' : ' · $unresolved needing review'}';
}

String _notebookStatus(Map<String, dynamic> summary, bool learn) =>
    summary['state'] == 'ready'
    ? 'Explanation available'
    : !learn
    ? 'Learning is paused. Saved memories are available below.'
    : switch (summary['state']) {
        'reviewing' => 'Preparing an explanation from saved memories.',
        'empty' =>
          'No supported explanation yet. You can read the individual memories.',
        'waiting_for_model' =>
          'Waiting for the model selected in your companion.',
        'budget_deferred' => 'Waiting for the next learning allowance.',
        'failed' => 'The last explanation could not be completed. Saved memories are still available.',
        _ => 'An explanation will be prepared when your companion is free.',
      };

Widget _notebookConstraints(
  BuildContext context,
  Map<String, dynamic> source,
  int index,
) {
  final conditions = memoryMap(source['applicability']);
  final exceptions = _memoryMaps(source['exceptions']);
  final validity = memoryMap(source['validity']);
  String when(Map<String, dynamic> values) => values.entries
      .map(
        (entry) =>
            '${_label(entry.key)}: ${entry.value is List ? (entry.value as List).join(', ') : entry.value}',
      )
      .join('; ');
  String date(Object value) {
    final time = DateTime.fromMillisecondsSinceEpoch((value as num).toInt())
        .toLocal();
    return '${_date(context, value)} at ${MaterialLocalizations.of(context).formatTimeOfDay(TimeOfDay.fromDateTime(time))}';
  }

  return Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      if (conditions.isNotEmpty)
        _text('Source $index applies when ${when(conditions)}.', small: true),
      for (final exception in exceptions)
        _text(
          'Source $index exception — ${when(memoryMap(exception['when']))}: ${exception['reason']}',
          small: true,
        ),
      if (validity['validFrom'] != null)
        _text(
          'Source $index applies from ${date(validity['validFrom']!)}.',
          small: true,
        ),
      if (validity['validUntil'] != null)
        _text(
          'Source $index applies until ${date(validity['validUntil']!)}.',
          small: true,
        ),
      for (final reason in validity['recheckWhen'] as List? ?? [])
        _text('Recheck source $index: $reason', small: true),
    ],
  );
}

Widget _memorySurface(Widget child) => Padding(
  padding: const EdgeInsets.only(bottom: 12),
  child: Container(
    width: double.infinity,
    padding: const EdgeInsets.all(16),
    decoration: BoxDecoration(
      color: AppPalette.cardBg,
      border: Border.all(color: AppPalette.divider),
      borderRadius: BorderRadius.circular(AppDesktop.rowRadius),
    ),
    child: child,
  ),
);

List<Widget> _memoryRows(
  List<Map<String, dynamic>> items, {
  required bool busy,
  required Future<void> Function(String) onOpen,
}) => [
  for (final item in items)
    _memorySurface(
      Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _text(
            '${_stateLabel(item['state'])} · ${_scopeLabel(item)}',
            small: true,
          ),
          const SizedBox(height: 8),
          Text(
            item['claim'] as String,
            style: AppType.body(color: AppPalette.textPrimary, height: 1.5),
          ),
          const SizedBox(height: 8),
          TextButton(
            onPressed: busy ? null : () => onOpen(item['id'] as String),
            child: const Text('Read memory'),
          ),
        ],
      ),
    ),
];
