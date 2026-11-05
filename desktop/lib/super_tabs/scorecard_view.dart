import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_select_field.dart';
import '../widgets/desktop_chrome.dart';
import '../widgets/laid_out_list.dart';
import 'model.dart';
import 'scorecard.dart';

/// The widest the table grows.
const _maxWidth = 960.0;
const _labelWidth = 240.0;
const _cellWidth = 72.0;
const _rowHeight = 32.0;

/// Manage ▸ Scorecard (task #3386): one project's figures for its last 7
/// local days, newest first, so a change to how the Swarm works can be judged
/// day over day. A day with no row says "–", never zeros.
class SuperTabScorecardView extends StatefulWidget {
  const SuperTabScorecardView({
    super.key,
    required this.projects,
    required this.reader,
    this.projectId,
  });

  final List<SuperTabProject> projects;
  final SuperTabScorecardReader reader;

  /// The project shown first: the open chat's, else the first.
  final String? projectId;

  @override
  State<SuperTabScorecardView> createState() => _SuperTabScorecardViewState();
}

class _SuperTabScorecardViewState extends State<SuperTabScorecardView> {
  String? _project;

  @override
  void initState() {
    super.initState();
    _project = widget.projects.any((p) => p.id == widget.projectId)
        ? widget.projectId
        : widget.projects.firstOrNull?.id;
    if (_project case final project?) widget.reader.show(project);
  }

  void _choose(String? project) {
    if (project == null || project == _project) return;
    setState(() => _project = project);
    widget.reader.show(project);
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final muted = DesktopChrome.metadata(color: DesktopChrome.muted);
    return ListenableBuilder(
      listenable: widget.reader,
      builder: (context, _) {
        final reader = widget.reader;
        final byDay = {for (final d in reader.days) d.on: d};
        final newest = reader.days.isEmpty
            ? null
            : reader.days
                  .map((d) => d.on)
                  .reduce((a, b) => a.compareTo(b) > 0 ? a : b);
        final columns = newest == null
            ? const <String>[]
            : scorecardColumns(newest);
        return Align(
          alignment: Alignment.topCenter,
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: _maxWidth),
            child: LaidOutListView(
              padding: const EdgeInsets.symmetric(
                horizontal: grid.AppDesktop.groupGap,
                vertical: grid.AppDesktop.controlGap,
              ),
              children: [
                Row(
                  children: [
                    Text('Project', style: DesktopChrome.control()),
                    const SizedBox(width: grid.AppDesktop.controlGap),
                    AppSelectField<String?>(
                      key: const ValueKey('super-scorecard-project'),
                      semanticLabel: 'Project',
                      width: AppSelectField.fitWidth(
                        context,
                        labels: [for (final p in widget.projects) p.name],
                      ),
                      value: _project,
                      options: [
                        for (final p in widget.projects)
                          SelectOption(value: p.id, label: p.name),
                      ],
                      onChanged: _choose,
                    ),
                  ],
                ),
                const SizedBox(height: grid.AppDesktop.groupGap),
                if (reader.error case final error?)
                  Text(
                    error,
                    key: const ValueKey('super-scorecard-error'),
                    style: muted,
                  )
                else if (columns.isEmpty)
                  Text(
                    reader.loading ? '' : 'No scorecard yet. The first is computed after midnight in the project\'s time zone.',
                    key: const ValueKey('super-scorecard-empty'),
                    style: muted,
                  )
                else
                  SingleChildScrollView(
                    scrollDirection: Axis.horizontal,
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        _Line(
                          label: '',
                          cells: [for (final on in columns) on.substring(5)],
                          style: muted,
                        ),
                        for (final row in scorecardRows)
                          _Line(
                            key: ValueKey('scorecard-${row.key}'),
                            label: row.label,
                            cells: [
                              for (final on in columns) row.cell(byDay[on]),
                            ],
                            style: DesktopChrome.control(),
                            divider: true,
                          ),
                      ],
                    ),
                  ),
              ],
            ),
          ),
        );
      },
    );
  }
}

class _Line extends StatelessWidget {
  const _Line({
    super.key,
    required this.label,
    required this.cells,
    required this.style,
    this.divider = false,
  });

  final String label;
  final List<String> cells;
  final TextStyle style;
  final bool divider;

  @override
  Widget build(BuildContext context) => Container(
    height: _rowHeight,
    decoration: divider
        ? BoxDecoration(
            border: Border(top: BorderSide(color: grid.AppPalette.divider)),
          )
        : null,
    child: Row(
      children: [
        SizedBox(
          width: _labelWidth,
          child: Text(label, style: style, overflow: TextOverflow.ellipsis),
        ),
        for (final cell in cells)
          SizedBox(
            width: _cellWidth,
            child: Text(
              cell,
              style: style.copyWith(
                fontFeatures: const [FontFeature.tabularFigures()],
              ),
              textAlign: TextAlign.end,
            ),
          ),
      ],
    ),
  );
}
