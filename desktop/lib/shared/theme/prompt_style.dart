import 'package:flutter/foundation.dart';

import 'status_line_style.dart';

const kHarnessPromptMarker = '>_';

enum PromptStyle {
  plain('Plain', 'ASCII markers, quiet and compact'),
  symbols('Symbols', 'Harness, machine, folder and branch marks'),
  powerline('Powerline', 'Joined segments with angled separators');

  const PromptStyle(this.label, this.description);
  final String label, description;

  static PromptStyle fromId(String? id) =>
      values.where((style) => style.name == id).firstOrNull ?? symbols;
}

@immutable
class PromptPrefs {
  const PromptPrefs({
    this.style = PromptStyle.symbols,
    this.color = true,
    this.machine = true,
    this.project = true,
    this.branch = true,
    this.statusStyle = StatusLineStyle.standard,
  });

  final PromptStyle style;
  final StatusLineStyle statusStyle;
  final bool color, machine, project, branch;

  PromptPrefs copyWith({
    PromptStyle? style,
    bool? color,
    bool? machine,
    bool? project,
    bool? branch,
    StatusLineStyle? statusStyle,
  }) => PromptPrefs(
    style: style ?? this.style,
    color: color ?? this.color,
    machine: machine ?? this.machine,
    project: project ?? this.project,
    branch: branch ?? this.branch,
    statusStyle: statusStyle ?? this.statusStyle,
  );

  Map<String, Object> toJson() => {
    'style': style.name,
    'color': color,
    'machine': machine,
    'project': project,
    'branch': branch,
    'statusStyle': statusStyle.name,
  };

  factory PromptPrefs.fromJson(Object? json) {
    if (json is! Map) return const PromptPrefs();
    bool flag(String key) => json[key] is bool ? json[key] as bool : true;
    return PromptPrefs(
      style: PromptStyle.fromId(json['style'] is String ? json['style'] : null),
      color: flag('color'),
      machine: flag('machine'),
      project: flag('project'),
      branch: flag('branch'),
      statusStyle: StatusLineStyle.fromId(json['statusStyle']),
    );
  }

  @override
  bool operator ==(Object other) =>
      other is PromptPrefs &&
      other.style == style &&
      other.statusStyle == statusStyle &&
      other.color == color &&
      other.machine == machine &&
      other.project == project &&
      other.branch == branch;

  @override
  int get hashCode =>
      Object.hash(style, statusStyle, color, machine, project, branch);
}

/// Identity supplied by the catalog, never inferred by parsing display text.
@immutable
class PromptContext {
  const PromptContext({
    this.harness,
    this.machine,
    this.project,
    this.branch,
    this.leading,
  });
  final String? harness, machine, project, branch, leading;
}
