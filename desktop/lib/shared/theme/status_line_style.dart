import 'package:flutter/painting.dart';
import 'package:xterm/xterm.dart';

/// One-line adaptations of shell prompts, using only known pane metadata.
enum StatusLineStyle {
  standard('Plain'),
  robbyrussell('Robbyrussell'),
  pure('Pure'),
  powerlevel10k('Powerlevel10k Lean'),
  spaceship('Spaceship'),
  starship('Starship'),
  agnoster('Agnoster'),
  powerlevel10kRainbow('Powerlevel10k Rainbow'),
  pastelPowerline('Pastel Powerline'),
  catppuccinPowerline('Catppuccin Powerline'),
  tokyoNight('Tokyo Night'),
  gruvboxRainbow('Gruvbox Rainbow');

  const StatusLineStyle(this.label);
  final String label;

  bool get segmented => switch (this) {
    agnoster ||
    powerlevel10kRainbow ||
    pastelPowerline ||
    catppuccinPowerline ||
    tokyoNight ||
    gruvboxRainbow => true,
    _ => false,
  };

  bool get branchSymbol =>
      segmented ||
      this == starship ||
      this == powerlevel10k ||
      this == spaceship;
  bool get roundedSeparators => this == tokyoNight;
  bool get roundedStart => _presetColors.containsKey(this);
  bool get roundedEnd => roundedStart && this != pastelPowerline;

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
  orange,
}

enum StatusLineField { machine, project, branch }

class StatusLineSegment {
  const StatusLineSegment(
    this.text, {
    this.foreground = StatusLineTone.foreground,
    this.background,
    this.field,
    this.branchSymbol = false,
  });
  final String text;
  final StatusLineTone foreground;
  final StatusLineTone? background;
  final StatusLineField? field;

  /// Drawn as a vector so SF Mono and unpatched Linux fonts work identically.
  final bool branchSymbol;
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
          branchSymbol:
              field == StatusLineField.branch &&
              style.branchSymbol &&
              text == branch,
        ),
      );
    }
  }

  void gap([String separator = '  ']) {
    if (parts.isNotEmpty) add(separator, StatusLineTone.foreground);
  }

  final git = branch ?? '';
  if (style.segmented) {
    final (
      machineInk,
      machineFill,
      projectInk,
      projectFill,
      branchInk,
      branchFill,
    ) = switch (style) {
      StatusLineStyle.powerlevel10kRainbow => (
        StatusLineTone.black,
        StatusLineTone.white,
        StatusLineTone.white,
        StatusLineTone.blue,
        StatusLineTone.black,
        StatusLineTone.green,
      ),
      StatusLineStyle.pastelPowerline => (
        StatusLineTone.white,
        StatusLineTone.magenta,
        StatusLineTone.black,
        StatusLineTone.red,
        StatusLineTone.black,
        StatusLineTone.orange,
      ),
      StatusLineStyle.catppuccinPowerline => (
        StatusLineTone.black,
        StatusLineTone.red,
        StatusLineTone.black,
        StatusLineTone.orange,
        StatusLineTone.black,
        StatusLineTone.yellow,
      ),
      StatusLineStyle.tokyoNight => (
        StatusLineTone.black,
        StatusLineTone.white,
        StatusLineTone.black,
        StatusLineTone.blue,
        StatusLineTone.blue,
        StatusLineTone.muted,
      ),
      StatusLineStyle.gruvboxRainbow => (
        StatusLineTone.black,
        StatusLineTone.orange,
        StatusLineTone.black,
        StatusLineTone.yellow,
        StatusLineTone.black,
        StatusLineTone.cyan,
      ),
      _ => (
        StatusLineTone.white,
        StatusLineTone.black,
        StatusLineTone.white,
        StatusLineTone.blue,
        StatusLineTone.black,
        StatusLineTone.green,
      ),
    };
    add(
      [provider, machine].where((s) => s.isNotEmpty).join(' '),
      machineInk,
      machineFill,
      machine.isEmpty ? null : StatusLineField.machine,
    );
    add(project, projectInk, projectFill, StatusLineField.project);
    add(git, branchInk, branchFill, StatusLineField.branch);
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
      case StatusLineStyle.starship:
        add(machine, StatusLineTone.muted, null, StatusLineField.machine);
        if (project.isNotEmpty) {
          if (machine.isNotEmpty) gap(' ');
          add(project, StatusLineTone.cyan, null, StatusLineField.project);
        }
        if (git.isNotEmpty) {
          if (machine.isNotEmpty || project.isNotEmpty) gap(' on ');
          add(git, StatusLineTone.magenta, null, StatusLineField.branch);
        }
        if (machine.isNotEmpty || project.isNotEmpty || git.isNotEmpty) {
          // The prompt mark belongs to the final real field's click target.
          parts.add(
            StatusLineSegment(
              ' ❯',
              foreground: StatusLineTone.green,
              field: parts.last.field,
            ),
          );
        }
      case StatusLineStyle.agnoster ||
          StatusLineStyle.powerlevel10kRainbow ||
          StatusLineStyle.pastelPowerline ||
          StatusLineStyle.catppuccinPowerline ||
          StatusLineStyle.tokyoNight ||
          StatusLineStyle.gruvboxRainbow:
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
  const StatusLinePaintSegment(
    this.text,
    this.foreground,
    this.background, {
    this.branchSymbol = false,
  });
  final String text;
  final Color foreground;
  final Color? background;
  final bool branchSymbol;

  Map<String, Object> toJson() => {
    'text': text,
    'foreground': foreground.toARGB32(),
    if (background != null) 'background': background!.toARGB32(),
    if (branchSymbol) 'branchSymbol': true,
  };
}

List<StatusLinePaintSegment> statusLinePaintSegments(
  StatusLineParts parts,
  TerminalTheme theme, {
  bool color = true,
  int segmentOffset = 0,
}) {
  color = color && parts.style != StatusLineStyle.standard;
  Color resolve(StatusLineTone tone) =>
      _presetColors[parts.style]?[tone] ??
      switch (tone) {
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
        StatusLineTone.orange => theme.yellow,
      };
  Color ink(StatusLineSegment part) {
    if (!color) return theme.foreground;
    final foreground = resolve(part.foreground);
    if (part.background == null || !_presetColors.containsKey(parts.style)) {
      return foreground;
    }
    final background = resolve(part.background!).computeLuminance();
    double contrast(Color ink) {
      final light = ink.computeLuminance();
      return light > background
          ? (light + .05) / (background + .05)
          : (background + .05) / (light + .05);
    }

    if (contrast(foreground) >= 4.5) return foreground;
    final dark = resolve(StatusLineTone.black);
    final light = resolve(StatusLineTone.white);
    final best = contrast(dark) > contrast(light) ? dark : light;
    if (contrast(best) >= 4.5) return best;
    // Some muted upstream ramps cannot meet small-text contrast with either
    // palette ink. Only the text changes; preserve the named background color.
    const black = Color(0xff000000), white = Color(0xffffffff);
    return contrast(black) > contrast(white) ? black : white;
  }

  return [
    for (var i = 0; i < parts.segments.length; i++)
      StatusLinePaintSegment(
        parts.segments[i].text,
        ink(parts.segments[i]),
        parts.segments[i].background == null
            ? null
            : color
            ? resolve(parts.segments[i].background!)
            : Color.lerp(
                theme.background,
                theme.foreground,
                (i + segmentOffset).isEven ? .12 : .22,
              ),
        branchSymbol: parts.segments[i].branchSymbol,
      ),
  ];
}

/// The four named Starship presets include a status-only palette, as their
/// upstream TOML presets do. Other styles follow the user's terminal ANSI
/// colors. These tokens are resolved here for both Flutter and AppKit, and
/// Color off bypasses them. See design/workspace-status-bar.md for sources.
const _presetColors = <StatusLineStyle, Map<StatusLineTone, Color>>{
  StatusLineStyle.pastelPowerline: {
    StatusLineTone.black: Color(0xff211c2c),
    StatusLineTone.white: Color(0xfffff0f5),
    StatusLineTone.magenta: Color(0xff9a348e),
    StatusLineTone.red: Color(0xffda627d),
    StatusLineTone.orange: Color(0xfffca17d),
    StatusLineTone.green: Color(0xff94c7a2),
    StatusLineTone.muted: Color(0xffa89bb8),
  },
  StatusLineStyle.catppuccinPowerline: {
    StatusLineTone.black: Color(0xff11111b),
    StatusLineTone.white: Color(0xffcdd6f4),
    StatusLineTone.red: Color(0xfff38ba8),
    StatusLineTone.orange: Color(0xfffab387),
    StatusLineTone.yellow: Color(0xfff9e2af),
    StatusLineTone.green: Color(0xffa6e3a1),
    StatusLineTone.magenta: Color(0xffcba6f7),
    StatusLineTone.muted: Color(0xff9399b2),
  },
  StatusLineStyle.tokyoNight: {
    StatusLineTone.black: Color(0xff1d2230),
    StatusLineTone.white: Color(0xffa3aed2),
    StatusLineTone.blue: Color(0xff769ff0),
    StatusLineTone.muted: Color(0xff394260),
    StatusLineTone.green: Color(0xff9ece6a),
    StatusLineTone.magenta: Color(0xffbb9af7),
    StatusLineTone.red: Color(0xfff7768e),
  },
  StatusLineStyle.gruvboxRainbow: {
    StatusLineTone.black: Color(0xff1d2021),
    StatusLineTone.white: Color(0xfffbf1c7),
    StatusLineTone.orange: Color(0xffd65d0e),
    StatusLineTone.yellow: Color(0xffd79921),
    StatusLineTone.cyan: Color(0xff689d6a),
    StatusLineTone.green: Color(0xff98971a),
    StatusLineTone.magenta: Color(0xffb16286),
    StatusLineTone.red: Color(0xffcc241d),
    StatusLineTone.muted: Color(0xffa89984),
  },
};
