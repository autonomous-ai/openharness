import 'package:flutter/painting.dart';
import 'package:xterm/xterm.dart';

/// One-line adaptations of shell prompts, using only known pane metadata.
enum StatusLineStyle {
  standard('Plain'),
  robbyrussell('Robbyrussell'),
  pure('Pure'),
  agnoster('Agnoster'),
  powerlevel10k('Powerlevel10k Lean'),
  spaceship('Spaceship');

  const StatusLineStyle(this.label);
  final String label;

  bool get segmented => this == agnoster;

  static StatusLineStyle fromId(Object? id) =>
      values.where((style) => style.name == id).firstOrNull ?? standard;
}

enum StatusLineTone {
  foreground,
  muted,
  black,
  white,
  blue,
  cyan,
  green,
  yellow,
  red,
  magenta,
}

enum StatusLineField { machine, project, branch }

class StatusLineSegment {
  const StatusLineSegment(
    this.text, {
    this.foreground = StatusLineTone.foreground,
    this.background,
    this.field,
  });
  final String text;
  final StatusLineTone foreground;
  final StatusLineTone? background;
  final StatusLineField? field;
}

class StatusLineParts {
  const StatusLineParts(this.style, this.segments);
  final StatusLineStyle style;
  final List<StatusLineSegment> segments;
  List<({StatusLineField? field, StatusLineParts parts, int offset})>
  get components {
    final result =
        <({StatusLineField? field, StatusLineParts parts, int offset})>[];
    for (var i = 0; i < segments.length;) {
      final start = i;
      final field = segments[i++].field;
      while (i < segments.length && segments[i].field == field) {
        i++;
      }
      result.add((
        field: field,
        parts: StatusLineParts(style, segments.sublist(start, i)),
        offset: start,
      ));
    }
    return result;
  }

  String get text =>
      segments.map((part) => part.text).join(style.segmented ? '  ' : '');
}

StatusLineParts statusLineParts({
  required String provider,
  required String machine,
  required String project,
  String? branch,
  StatusLineStyle style = StatusLineStyle.standard,
  bool separateMachine = false,
}) {
  final parts = <StatusLineSegment>[];
  void add(
    String text,
    StatusLineTone color, [
    StatusLineTone? background,
    StatusLineField? field,
  ]) {
    if (text.isNotEmpty) {
      parts.add(
        StatusLineSegment(
          text,
          foreground: color,
          background: background,
          field: field,
        ),
      );
    }
  }

  void gap([String separator = '  ']) {
    if (parts.isNotEmpty) add(separator, StatusLineTone.foreground);
  }

  final git = branch ?? '';
  if (style.segmented) {
    if (style == StatusLineStyle.agnoster) {
      add(
        [provider, machine].where((s) => s.isNotEmpty).join(' '),
        StatusLineTone.white,
        StatusLineTone.black,
        machine.isEmpty ? null : StatusLineField.machine,
      );
    } else {
      add(provider, StatusLineTone.black, StatusLineTone.white);
      add(
        machine,
        StatusLineTone.yellow,
        StatusLineTone.black,
        StatusLineField.machine,
      );
    }
    add(
      project,
      StatusLineTone.white,
      StatusLineTone.blue,
      StatusLineField.project,
    );
    add(
      git,
      StatusLineTone.black,
      StatusLineTone.green,
      StatusLineField.branch,
    );
  } else {
    add(provider, StatusLineTone.foreground);
    if (machine.isNotEmpty || project.isNotEmpty || git.isNotEmpty) gap();
    switch (style) {
      case StatusLineStyle.standard:
        add(machine, StatusLineTone.cyan, null, StatusLineField.machine);
        if (machine.isNotEmpty && project.isNotEmpty) {
          gap(separateMachine ? '  ' : ':');
        }
        add(project, StatusLineTone.cyan, null, StatusLineField.project);
        if (git.isNotEmpty) {
          if (machine.isNotEmpty || project.isNotEmpty) gap();
          add('($git)', StatusLineTone.green, null, StatusLineField.branch);
        }
      case StatusLineStyle.robbyrussell:
        if (machine.isNotEmpty) {
          add(
            machine,
            StatusLineTone.foreground,
            null,
            StatusLineField.machine,
          );
        }
        if (project.isNotEmpty) {
          if (machine.isNotEmpty) gap();
          add('➜ ', StatusLineTone.green, null, StatusLineField.project);
          add(project, StatusLineTone.cyan, null, StatusLineField.project);
        }
        if (git.isNotEmpty) {
          if (machine.isNotEmpty || project.isNotEmpty) gap(' ');
          add('git:(', StatusLineTone.blue, null, StatusLineField.branch);
          add(git, StatusLineTone.red, null, StatusLineField.branch);
          add(')', StatusLineTone.blue, null, StatusLineField.branch);
        }
      case StatusLineStyle.pure:
        add(machine, StatusLineTone.muted, null, StatusLineField.machine);
        if (project.isNotEmpty) {
          if (machine.isNotEmpty) gap();
          add(project, StatusLineTone.blue, null, StatusLineField.project);
        }
        if (git.isNotEmpty) {
          if (machine.isNotEmpty || project.isNotEmpty) gap(' ');
          add(git, StatusLineTone.muted, null, StatusLineField.branch);
        }
        if (machine.isNotEmpty || project.isNotEmpty || git.isNotEmpty) {
          add(
            ' ❯',
            StatusLineTone.magenta,
            null,
            git.isNotEmpty
                ? StatusLineField.branch
                : project.isNotEmpty
                ? StatusLineField.project
                : StatusLineField.machine,
          );
        }
      case StatusLineStyle.powerlevel10k:
        add(machine, StatusLineTone.yellow, null, StatusLineField.machine);
        if (project.isNotEmpty) {
          if (machine.isNotEmpty) gap();
          add(project, StatusLineTone.blue, null, StatusLineField.project);
        }
        if (git.isNotEmpty) {
          if (machine.isNotEmpty || project.isNotEmpty) gap();
          add(git, StatusLineTone.green, null, StatusLineField.branch);
        }
        if (machine.isNotEmpty || project.isNotEmpty || git.isNotEmpty) {
          add(
            ' >',
            StatusLineTone.green,
            null,
            git.isNotEmpty
                ? StatusLineField.branch
                : project.isNotEmpty
                ? StatusLineField.project
                : StatusLineField.machine,
          );
        }
      case StatusLineStyle.spaceship:
        add(machine, StatusLineTone.foreground, null, StatusLineField.machine);
        if (project.isNotEmpty) {
          if (machine.isNotEmpty) gap(' in ');
          add(project, StatusLineTone.cyan, null, StatusLineField.project);
        }
        if (git.isNotEmpty) {
          if (machine.isNotEmpty || project.isNotEmpty) gap(' on ');
          add(git, StatusLineTone.magenta, null, StatusLineField.branch);
        }
      case StatusLineStyle.agnoster:
        break;
    }
  }
  return StatusLineParts(style, parts);
}

StatusLineParts pullRequestStatusLineParts({
  required int number,
  required String state,
  StatusLineStyle style = StatusLineStyle.standard,
}) {
  final tone = switch (state) {
    'Open' => StatusLineTone.green,
    'Merged' => StatusLineTone.magenta,
    'Closed' => StatusLineTone.red,
    _ => StatusLineTone.muted,
  };
  if (style.segmented) {
    return StatusLineParts(style, [
      StatusLineSegment(
        '#$number $state',
        foreground: state == 'Open' || state == 'Draft'
            ? StatusLineTone.black
            : StatusLineTone.white,
        background: tone,
      ),
    ]);
  }
  return StatusLineParts(style, [
    StatusLineSegment(
      '#$number ',
      foreground: switch (style) {
        StatusLineStyle.robbyrussell => StatusLineTone.blue,
        StatusLineStyle.pure => StatusLineTone.muted,
        _ => tone,
      },
    ),
    StatusLineSegment(state, foreground: tone),
  ]);
}

/// Resolved once in Dart so the Flutter preview and native bar use identical
/// ANSI colors. Backgrounds are static theme styling, not Git clean/dirty state.
class StatusLinePaintSegment {
  const StatusLinePaintSegment(this.text, this.foreground, this.background);
  final String text;
  final Color foreground;
  final Color? background;

  Map<String, Object> toJson() => {
    'text': text,
    'foreground': foreground.toARGB32(),
    if (background != null) 'background': background!.toARGB32(),
  };
}

List<StatusLinePaintSegment> statusLinePaintSegments(
  StatusLineParts parts,
  TerminalTheme theme, {
  bool color = true,
  int segmentOffset = 0,
}) {
  color = color && parts.style != StatusLineStyle.standard;
  Color resolve(StatusLineTone tone) => switch (tone) {
    StatusLineTone.foreground => theme.foreground,
    StatusLineTone.muted => Color.lerp(
      theme.background,
      theme.foreground,
      .55,
    )!,
    StatusLineTone.black => theme.black,
    StatusLineTone.white => theme.white,
    StatusLineTone.blue => theme.blue,
    StatusLineTone.cyan => theme.cyan,
    StatusLineTone.green => theme.green,
    StatusLineTone.yellow => theme.yellow,
    StatusLineTone.red => theme.red,
    StatusLineTone.magenta => theme.magenta,
  };
  return [
    for (var i = 0; i < parts.segments.length; i++)
      StatusLinePaintSegment(
        parts.segments[i].text,
        color ? resolve(parts.segments[i].foreground) : theme.foreground,
        parts.segments[i].background == null
            ? null
            : color
            ? resolve(parts.segments[i].background!)
            : Color.lerp(
                theme.background,
                theme.foreground,
                (i + segmentOffset).isEven ? .12 : .22,
              ),
      ),
  ];
}
