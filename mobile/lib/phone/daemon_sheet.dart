import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'package:harness_mobile/daemons/card.dart';
import 'package:harness_mobile/daemons/daemon_face.dart';
import 'package:harness_mobile/daemons/daemon_lines.dart';
import 'package:harness_mobile/daemons/eggs.dart';
import 'package:harness_mobile/daemons/individual_art.dart';
import 'package:harness_mobile/daemons/plates.dart';
import 'package:harness_mobile/daemons/render.dart';
import 'package:harness_mobile/daemons/roster.dart';
import 'package:harness_mobile/daemons/zoo.dart';
import 'package:harness_mobile/daemons/zoo_client.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart' show AppFont;

import 'daemon_consent.dart';
import 'daemon_hatch.dart';
import 'daemon_plate.dart';
import 'daemon_scope.dart';
import 'daemon_style.dart';

/// Open the daemon's sheet: it looks back at you (one blink), and the zoo is
/// read again so a new egg from a computer is there when the sheet is. Eggs
/// that became xp are shown once: closing the sheet forgets them.
Future<void> showDaemonSheet(BuildContext context, DaemonHostState host) {
  host.face.look();
  unawaited(host.zoo.refresh());
  final navigator = Navigator.of(context, rootNavigator: true);
  return showModalBottomSheet<void>(
    context: context,
    useRootNavigator: true,
    isScrollControlled: true,
    backgroundColor: DaemonInk.ground,
    barrierColor: Colors.black.withValues(alpha: .55),
    constraints: BoxConstraints(
      maxHeight: MediaQuery.sizeOf(context).height * 0.88,
    ),
    builder: (sheetContext) => DaemonSheet(
      face: host.face,
      art: host.app.individualArt,
      facts: () => host.facts,
      onHatch: (egg) {
        Navigator.of(sheetContext).pop();
        unawaited(
          hatchEgg(navigator, host.face, egg, art: host.app.individualArt),
        );
      },
    ),
  ).whenComplete(host.zoo.seenXp);
}

/// The daemon's sheet: its portrait at its version and mood (in its shiny
/// colour when it is shiny; a filled daemon's portrait plate, looping), its
/// names and serial, the line it would say now, its lore and lineage, its bond, the eggs waiting, the zoo as shelves
/// (tap one to pair it), the habits still to bring an egg, whether it may
/// watch (and a way to give or withdraw that), the dial as the account has it
/// (read here, turned at a computer) and its card. Before any daemon: the
/// nest, and the habits that bring the first egg.
class DaemonSheet extends StatelessWidget {
  const DaemonSheet({
    super.key,
    required this.face,
    required this.facts,
    required this.onHatch,
    this.art,
  });

  final DaemonFace face;
  final DaemonFacts Function() facts;
  final void Function(ZooEgg egg) onHatch;
  final IndividualArt? art;

  ZooClient get zoo => face.zoo;
  DaemonRoster get roster => face.roster;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: Listenable.merge([face, zoo, ?art]),
    builder: (context, _) {
      final def = face.def;
      return SafeArea(
        top: false,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const _Handle(),
            Flexible(
              child: ListView(
                key: const ValueKey('daemon-sheet'),
                shrinkWrap: true,
                padding: const EdgeInsets.fromLTRB(16, 4, 16, 20),
                children: def == null ? _nest(context) : _daemon(context, def),
              ),
            ),
          ],
        ),
      );
    },
  );

  // ── with a daemon ──────────────────────────────────────────────────────────

  List<Widget> _daemon(BuildContext context, DaemonDef def) {
    final daemon = face.daemon!;
    final mood = face.mood;
    final line = daemonLine(roster, def, mood, facts());
    final colour = def.colorFor(shiny: daemon.shiny);
    final traits = daemon.traits(roster);
    final rarity =
        '${daemon.shiny ? 'SHINY ' : ''}${def.rarity.toUpperCase()}'
        '  ${cardNumber(roster, def)}';
    // Only the server mints: a guest's daemon has no serial.
    final serial = daemon.origin == 'local' ? null : daemon.serial;
    return [
      _Panel(
        key: const ValueKey('daemon-portrait'),
        pitch: def.darkOnly,
        semantics:
            '${def.id} ${daemon.version}${daemon.shiny ? ', shiny' : ''}, '
            '${DaemonFace.moodWords[mood]}',
        child: def.plate
            ? DaemonPlateView(
                roster: roster,
                def: def,
                size: PlateSize.portrait,
                version: daemon.version,
                mood: mood,
                shiny: daemon.shiny,
                traits: traits,
                art: art?.frames(
                  daemon,
                  PlateSize.portrait,
                  daemon.version,
                  mood: mood,
                ),
                ground: def.darkOnly ? DaemonInk.pitch : DaemonInk.deep,
                animate: face.motionEnabled,
              )
            : _Art(face.portrait, colour: colour, size: 14),
      ),
      const SizedBox(height: 14),
      Wrap(
        crossAxisAlignment: WrapCrossAlignment.end,
        spacing: 10,
        runSpacing: 4,
        children: [
          Text(
            daemon.title,
            key: const ValueKey('daemon-name'),
            style: DaemonInk.sans(
              size: 24,
              color: DaemonInk.bright,
              weight: FontWeight.w700,
              height: 1.1,
            ),
          ),
          Text(
            '${daemon.version}${serial == null ? '' : '  ${serialLabel(serial)}'}',
            key: const ValueKey('daemon-version'),
            style: DaemonInk.mono(size: 14, color: colour),
          ),
        ],
      ),
      const SizedBox(height: 4),
      Text(
        rarity,
        style: DaemonInk.mono(size: 12, color: DaemonInk.rarity(def.rarity)),
      ),
      if (traits != null) ...[
        const SizedBox(height: 8),
        Text(
          individualFlags(roster, def.id, traits),
          style: DaemonInk.mono(size: 12),
        ),
        Text(
          oneInText(oneIn(roster, def.id, traits)),
          style: DaemonInk.mono(size: 12, color: DaemonInk.dim),
        ),
      ],
      const SizedBox(height: 12),
      _Said(
        key: const ValueKey('daemon-line'),
        text: '${face.name}: $line',
        alert: _Said.alerts(mood),
      ),
      const SizedBox(height: 14),
      Text(def.lore, style: DaemonInk.sans(size: 14.5)),
      const SizedBox(height: 10),
      Text(def.familyLine, style: DaemonInk.mono(size: 13)),
      if (def.familyYears.isNotEmpty)
        Text(
          def.familyYears,
          style: DaemonInk.mono(size: 12, color: DaemonInk.faint),
        ),
      const SizedBox(height: 8),
      Text(
        _bondLine(daemon),
        style: DaemonInk.mono(size: 12, color: DaemonInk.dim),
      ),
      // Eggs earned past a full queue of held ones: xp, never an egg.
      for (final grant in zoo.xpGrants)
        Text(
          '+${grant.xp} xp · a ${grant.kind} egg, with no room to hold it',
          key: const ValueKey('daemon-xp-grant'),
          style: DaemonInk.mono(size: 12, color: DaemonInk.green),
        ),
      if (zoo.zoo.eggs.isNotEmpty) ...[const _Caption('EGGS'), ..._eggRows()],
      ..._earningRows(),
      const _Caption('ZOO'),
      _Shelves(
        zoo: zoo,
        roster: roster,
        now: face.now(),
        art: art,
        animate: face.motionEnabled,
      ),
      if (_habitsLeft) ...[
        const _Caption('HABITS'),
        _habitIntro(),
        const SizedBox(height: 8),
        ..._habitRows(),
      ],
      const _Caption('WATCHING'),
      _Watching(
        name: face.name,
        consent: zoo.zoo.consent,
        onGive: () => unawaited(
          showDaemonConsent(Navigator.of(context, rootNavigator: true), face),
        ),
        onWithdraw: () {
          HapticFeedback.selectionClick();
          zoo.consent(watching: false);
        },
      ),
      const _Caption('AUTONOMY'),
      _Autonomy(name: face.name, level: zoo.zoo.autonomy),
      const _Caption('CARD'),
      _ShareCard(
        roster: roster,
        def: def,
        lines: ownedCardLines(
          roster,
          def,
          daemon,
          plate: art
              ?.frames(daemon, PlateSize.portrait, daemon.version)
              ?.first
              .rows,
        ),
        version: daemon.version,
        shiny: daemon.shiny,
        serial: serial,
        traits: traits,
        art: art?.frames(daemon, PlateSize.portrait, daemon.version)?.first,
      ),
    ];
  }

  // ── habits ─────────────────────────────────────────────────────────────────

  /// An egg the habits bring is still to come: the first, or the setup egg.
  bool get _habitsLeft {
    final z = zoo.zoo;
    return !z.firstEgg || (!z.setupEgg && zoo.setupHabitsNeeded != null);
  }

  /// What the habits bring, from the roster's rules: the first egg after
  /// `firstEgg.need` of them, the required ones among them, and the setup egg
  /// at `setupEgg.need`.
  Widget _habitIntro() {
    final z = zoo.zoo;
    final done = z.habits.length;
    final required = roster.rules.firstEggRequire.length;
    final setup = zoo.setupHabitsNeeded;
    final String text;
    if (!z.firstEgg) {
      text =
          'The first egg arrives after any ${zoo.habitsNeeded} of these, '
          '${required == 0
              ? 'in any order'
              : required == 1
              ? 'the required one included'
              : 'the required ones included'}.'
          '${setup == null ? '' : ' The setup egg follows at $setup.'}'
          ' $done done.';
    } else if (setup != null) {
      text = 'The setup egg arrives after any $setup of these. $done done.';
    } else {
      text = '$done done.';
    }
    return Text(
      text,
      key: const ValueKey('daemon-habits-intro'),
      style: DaemonInk.sans(size: 14.5, color: DaemonInk.dim),
    );
  }

  List<Widget> _habitRows() {
    final done = zoo.zoo.habits.toSet();
    final required = zoo.zoo.firstEgg
        ? const <String>{}
        : roster.rules.firstEggRequire.toSet();
    return [
      for (final habit in roster.rules.habits)
        _Habit(
          label: habit.label,
          done: done.contains(habit.key),
          required: required.contains(habit.key),
        ),
    ];
  }

  String _bondLine(ZooDaemon daemon) {
    final rules = roster.rules;
    final last = rules.bondLevels.length - 1;
    final next = rules.versions
        .where((v) => (rules.bondForVersion[v] ?? 0) > daemon.bond)
        .firstOrNull;
    return 'bond ${daemon.bond}/$last  ${daemon.xp} xp'
        '${next == null ? '' : '  $next at bond ${rules.bondForVersion[next]}'}';
  }

  // ── before any daemon: the nest ────────────────────────────────────────────

  List<Widget> _nest(BuildContext context) {
    final ready = zoo.readyEgg != null;
    final many = zoo.zoo.eggs.length > 1;
    final done = zoo.zoo.habits.toSet();
    final nearest = face.nearest;
    return [
      _Panel(
        key: const ValueKey('daemon-nest'),
        semantics: ready
            ? 'An egg, ready to hatch'
            : 'A nest: ${done.length} of ${zoo.habitsNeeded} habits',
        child: EggPlateView(
          roster: roster,
          kind: nearest?.kind ?? 'first',
          stage: nearest?.stage ?? 'p0',
          animate: face.motionEnabled,
        ),
      ),
      const SizedBox(height: 14),
      Text(
        ready
            ? (many ? 'Your eggs are ready' : 'Your egg is ready')
            : 'A daemon is incubating',
        style: DaemonInk.sans(
          size: 22,
          color: DaemonInk.bright,
          weight: FontWeight.w700,
          height: 1.15,
        ),
      ),
      const SizedBox(height: 6),
      if (ready)
        Text(
          'Open ${many ? 'one' : 'it'} to meet the daemon that pairs with you '
          'on every device.',
          style: DaemonInk.sans(size: 14.5, color: DaemonInk.dim),
        )
      else
        _habitIntro(),
      if (!ready) ...[const SizedBox(height: 12), ..._habitRows()],
      if (zoo.zoo.eggs.isNotEmpty) ...[const _Caption('EGGS'), ..._eggRows()],
      ..._earningRows(),
    ];
  }

  List<Widget> _eggRows() => [
    for (final egg in zoo.zoo.eggs)
      _EggRow(
        roster: roster,
        animate: face.motionEnabled,
        kind: egg.kind,
        date: egg.date,
        busy: zoo.hatchingEgg != null,
        onHatch: () => onHatch(egg),
      ),
  ];

  List<Widget> _earningRows() => [
    if (earningEggs(roster, zoo.zoo, face.now()).isNotEmpty)
      const _Caption('EARNING'),
    for (final egg in earningEggs(roster, zoo.zoo, face.now()))
      Row(
        key: ValueKey('daemon-earning-${egg.kind}'),
        children: [
          SizedBox(
            width: 100,
            child: EggPlateView(
              roster: roster,
              kind: egg.kind,
              stage: egg.stage,
              fontSize: 7,
              animate: face.motionEnabled,
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Text(
              '${egg.kind} egg  ${egg.done}/${egg.need}',
              style: DaemonInk.mono(size: 12),
            ),
          ),
        ],
      ),
  ];
}

/// Whether it may watch, as the account says: since when, or that it watches
/// nothing; and the one thing to do about it. Giving opens the consent screen
/// first, so a yes is always a yes to what it reads; withdrawing is one tap.
class _Watching extends StatelessWidget {
  const _Watching({
    required this.name,
    required this.consent,
    required this.onGive,
    required this.onWithdraw,
  });

  final String name;
  final ZooConsent? consent;
  final VoidCallback onGive, onWithdraw;

  @override
  Widget build(BuildContext context) {
    final answer = consent, day = answer?.day;
    final watching = answer?.watching == true;
    final String state;
    if (watching) {
      state =
          '$name watches the coding agents on your computers'
          '${day == null ? '.' : ', since $day.'}';
    } else if (answer != null) {
      state =
          '$name watches nothing: you said no'
          '${day == null ? '.' : ' on $day.'}';
    } else {
      state = '$name watches nothing until you say yes.';
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          state,
          key: const ValueKey('daemon-watching'),
          style: DaemonInk.sans(
            size: 14.5,
            color: watching ? DaemonInk.ink : DaemonInk.dim,
          ),
        ),
        const SizedBox(height: 8),
        if (watching)
          DaemonButton(
            'Stop watching',
            onWithdraw,
            key: const ValueKey('daemon-consent-stop'),
            hint: 'It senses nothing until you say yes again',
          )
        else
          DaemonButton(
            'Let $name watch',
            onGive,
            key: const ValueKey('daemon-consent-give'),
            hint: 'Shows what it sees before you say yes',
            filled: true,
          ),
      ],
    );
  }
}

/// The account's dial, read only: the level and what it allows, the floor
/// that holds at every level, and where it is changed.
class _Autonomy extends StatelessWidget {
  const _Autonomy({required this.name, required this.level});

  final String name;
  final String level;

  /// What each level allows (daemons/BRAIN.md, "Autonomy dial").
  static const meaning = {
    'watch': 'It reads and tells you. Nothing else.',
    'suggest': 'It recommends; every action waits for your key.',
    'act-on-key':
        'It may drive harnesses it started; anything else waits for your key.',
    'act-within-rules':
        'As act-on-key, and it runs your pair.jsonc rules, then reports.',
  };

  @override
  Widget build(BuildContext context) {
    final at = Zoo.autonomyLevels.indexOf(level) + 1;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Semantics(
          container: true,
          label:
              'Autonomy: $level, $at of ${Zoo.autonomyLevels.length}. '
              '${meaning[level] ?? ''}',
          excludeSemantics: true,
          child: Text.rich(
            TextSpan(
              children: [
                TextSpan(
                  text: level,
                  style: DaemonInk.mono(
                    size: 14,
                    color: DaemonInk.bright,
                    weight: FontWeight.w600,
                  ),
                ),
                TextSpan(
                  text: '  $at/${Zoo.autonomyLevels.length}  ',
                  style: DaemonInk.mono(size: 12, color: DaemonInk.faint),
                ),
                TextSpan(text: meaning[level] ?? ''),
              ],
            ),
            key: const ValueKey('daemon-autonomy'),
            style: DaemonInk.sans(size: 14.5),
          ),
        ),
        const SizedBox(height: 6),
        Text(
          'At every level $name never pushes, deletes, force-pushes or '
          'bypasses permissions.',
          key: const ValueKey('daemon-autonomy-floor'),
          style: DaemonInk.sans(size: 14.5),
        ),
        const SizedBox(height: 6),
        Text(
          'Change it at a computer, where each step up waits for your yes.',
          key: const ValueKey('daemon-autonomy-where'),
          style: DaemonInk.sans(size: 13.5, color: DaemonInk.dim),
        ),
      ],
    );
  }
}

class _Handle extends StatelessWidget {
  const _Handle();

  @override
  Widget build(BuildContext context) => Center(
    child: Container(
      margin: const EdgeInsets.only(top: 10, bottom: 10),
      width: 36,
      height: 4,
      decoration: BoxDecoration(
        color: DaemonInk.line,
        borderRadius: BorderRadius.circular(2),
      ),
    ),
  );
}

/// A box of night for art: deep, or pitch black for a daemon that only shows
/// in the dark.
class _Panel extends StatelessWidget {
  const _Panel({
    super.key,
    required this.child,
    required this.semantics,
    this.pitch = false,
  });

  final Widget child;
  final String semantics;
  final bool pitch;

  @override
  Widget build(BuildContext context) => Semantics(
    label: semantics,
    image: true,
    excludeSemantics: true,
    child: Container(
      padding: const EdgeInsets.symmetric(vertical: 16, horizontal: 12),
      decoration: BoxDecoration(
        color: pitch ? DaemonInk.pitch : DaemonInk.deep,
        border: Border.all(color: DaemonInk.line),
        borderRadius: BorderRadius.circular(8),
      ),
      child: child,
    ),
  );
}

/// Lines of ASCII art, kept in their columns and scaled down to fit a narrow
/// screen rather than wrapped. Text size does not grow art: it would only be
/// scaled back down to fit.
class _Art extends StatelessWidget {
  const _Art(this.lines, {required this.colour, this.size = 13});

  final List<String> lines;
  final Color colour;
  final double size;

  @override
  Widget build(BuildContext context) => Center(
    child: FittedBox(
      fit: BoxFit.scaleDown,
      child: Text(
        lines.join('\n'),
        softWrap: false,
        textScaler: TextScaler.noScaling,
        style: DaemonInk.mono(size: size, color: colour, height: 1.2),
      ),
    ),
  );
}

/// The line it would say now. Only what needs you takes tmux's yellow message
/// line: a harness waiting on you, and a failure. Anything else — content,
/// working, a boop — is dim text, the way the status line stays quiet
/// (`daemons/README.md`, Voice).
class _Said extends StatelessWidget {
  const _Said({super.key, required this.text, required this.alert});

  final String text;
  final bool alert;

  static bool alerts(DaemonMood mood) =>
      mood == DaemonMood.need || mood == DaemonMood.fail;

  @override
  Widget build(BuildContext context) {
    if (!alert) {
      return Text(
        text,
        style: DaemonInk.mono(size: 13, color: DaemonInk.dim, height: 1.35),
      );
    }
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
      decoration: BoxDecoration(
        color: DaemonInk.yellow,
        borderRadius: BorderRadius.circular(3),
      ),
      child: Text(
        text,
        style: DaemonInk.mono(size: 13, color: DaemonInk.pitch, height: 1.35),
      ),
    );
  }
}

class _Caption extends StatelessWidget {
  const _Caption(this.text);

  final String text;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(top: 22, bottom: 8),
    child: Semantics(
      header: true,
      child: Text(
        text,
        style: DaemonInk.mono(
          size: 12,
          color: DaemonInk.faint,
          weight: FontWeight.w600,
        ).copyWith(letterSpacing: 1.6),
      ),
    ),
  );
}

class _Habit extends StatelessWidget {
  const _Habit({
    required this.label,
    required this.done,
    this.required = false,
  });

  final String label;
  final bool done;

  /// The first egg cannot come without it.
  final bool required;

  @override
  Widget build(BuildContext context) => Semantics(
    label:
        '$label${required ? ', required' : ''}, ${done ? 'done' : 'not yet'}',
    excludeSemantics: true,
    child: Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            done ? '[x]' : '[ ]',
            style: DaemonInk.mono(
              size: 13.5,
              color: done ? DaemonInk.green : DaemonInk.faint,
              height: 1.4,
            ),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Text.rich(
              TextSpan(
                text: label,
                children: [
                  if (required)
                    TextSpan(
                      text: '  required',
                      style: DaemonInk.mono(
                        size: 12,
                        color: done ? DaemonInk.faint : DaemonInk.yellow,
                      ),
                    ),
                ],
              ),
              style: DaemonInk.sans(
                size: 14.5,
                color: done ? DaemonInk.ink : DaemonInk.dim,
              ),
            ),
          ),
        ],
      ),
    ),
  );
}

class _EggRow extends StatelessWidget {
  const _EggRow({
    required this.roster,
    required this.animate,
    required this.kind,
    required this.date,
    required this.busy,
    required this.onHatch,
  });

  final DaemonRoster roster;
  final bool animate;
  final String kind;
  final String? date;
  final bool busy;
  final VoidCallback onHatch;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 2),
    child: Row(
      children: [
        SizedBox(
          width: 100,
          child: EggPlateView(
            roster: roster,
            kind: kind,
            stage: 'p4',
            fontSize: 7,
            animate: animate,
          ),
        ),
        const SizedBox(width: 8),
        Expanded(
          child: Text(
            '$kind egg${date == null ? '' : ', $date'}',
            style: DaemonInk.sans(size: 14.5),
          ),
        ),
        TextButton(
          key: ValueKey('daemon-hatch-$kind'),
          onPressed: busy
              ? null
              : () {
                  HapticFeedback.selectionClick();
                  onHatch();
                },
          style: TextButton.styleFrom(
            foregroundColor: DaemonInk.yellow,
            disabledForegroundColor: DaemonInk.faint,
            minimumSize: const Size(64, 44),
          ),
          child: Text(
            'Hatch',
            style: TextStyle(
              fontFamily: AppFont.sans,
              fontSize: 15,
              fontWeight: FontWeight.w600,
            ),
          ),
        ),
      ],
    ),
  );
}

/// The zoo as box backs, one shelf per drop that shows at [now]: owned
/// sprites in their colours (shiny ones in their shiny colour, marked `*`),
/// `x2` beside one with a duplicate merged in, `[ ? ]` for a numbered slot
/// still empty, `[ ! ]` for a secret. A drop announced but not released
/// shows its regulars as `#` silhouettes and its release date; one not yet
/// announced shows nothing. Laid out to the screen (card.mjs's five to a row
/// is fifty columns, wider than a phone), and a tap on a daemon you own
/// pairs it.
class _Shelves extends StatelessWidget {
  const _Shelves({
    required this.zoo,
    required this.roster,
    required this.now,
    this.art,
    required this.animate,
  });

  final ZooClient zoo;
  final DaemonRoster roster;
  final DateTime now;
  final IndividualArt? art;
  final bool animate;

  @override
  Widget build(BuildContext context) {
    final owned = shelfEntriesOf(zoo.zoo.daemons);
    final drops = shelfDrops(roster, now);
    // Only what a shelf shows can be tapped: a daemon of a drop on hold (a
    // zoo from before may hold one) has no shelf, and is counted nowhere.
    final shown = {
      for (final drop in drops)
        if (drop.stateAt(now) == DropState.released)
          for (final d in roster.daemons)
            if (d.drop == drop.id) d.id,
    };
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (final (i, drop) in drops.indexed) ...[
          if (i > 0) const SizedBox(height: 16),
          _Shelf(zoo: zoo, roster: roster, drop: drop, owned: owned, now: now),
          if (drop.stateAt(now) == DropState.released)
            for (final def in roster.daemons.where((d) => d.drop == drop.id))
              if (zoo.zoo.daemons.any((d) => d.id == def.id))
                _Individuals(
                  zoo: zoo,
                  roster: roster,
                  def: def,
                  art: art,
                  animate: animate,
                ),
        ],
        if (owned.where((o) => shown.contains(o.id)).length > 1) ...[
          const SizedBox(height: 10),
          Text(
            'Tap a daemon to pair it. The pair is the same on every device.',
            style: DaemonInk.sans(size: 13, color: DaemonInk.faint),
          ),
        ],
      ],
    );
  }
}

class _Shelf extends StatelessWidget {
  const _Shelf({
    required this.zoo,
    required this.roster,
    required this.drop,
    required this.owned,
    required this.now,
  });

  final ZooClient zoo;
  final DaemonRoster roster;
  final DaemonDrop drop;
  final List<ShelfEntry> owned;
  final DateTime now;

  @override
  Widget build(BuildContext context) {
    final pair = zoo.paired?.id;
    final cells = shelfCells(roster, owned, drop: drop.id, now: now);
    final announced = drop.stateAt(now) == DropState.announced;
    return Column(
      key: ValueKey('daemon-shelf-drop-${drop.id}'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          shelfTitle(roster, owned, drop: drop.id, now: now),
          style: DaemonInk.mono(
            size: 12.5,
            color: announced ? DaemonInk.faint : DaemonInk.dim,
          ),
        ),
        const SizedBox(height: 10),
        // An even grid, as many slots to a row as fit: a box back, whatever
        // the width of the phone.
        LayoutBuilder(
          builder: (context, constraints) {
            const gap = 8.0, least = 84.0;
            final columns = ((constraints.maxWidth + gap) / (least + gap))
                .floor()
                .clamp(1, 5);
            final width =
                (constraints.maxWidth - gap * (columns - 1)) / columns;
            return Wrap(
              spacing: gap,
              runSpacing: gap,
              children: [
                for (final cell in cells)
                  SizedBox(
                    width: width,
                    child: _ShelfCell(
                      cell: cell,
                      drop: drop,
                      announced: announced,
                      paired: cell.daemon?.id == pair,
                      onPair:
                          cell.daemon == null ||
                              cell.daemon!.id == pair ||
                              zoo.zoo.daemons
                                      .where((d) => d.id == cell.daemon!.id)
                                      .length !=
                                  1
                          ? null
                          : () {
                              HapticFeedback.selectionClick();
                              zoo.pair(
                                zoo.zoo.daemons
                                    .firstWhere((d) => d.id == cell.daemon!.id)
                                    .uid,
                              );
                            },
                    ),
                  ),
              ],
            );
          },
        ),
      ],
    );
  }
}

class _ShelfCell extends StatelessWidget {
  const _ShelfCell({
    required this.cell,
    required this.drop,
    required this.announced,
    required this.paired,
    this.onPair,
  });

  final ShelfCell cell;
  final DaemonDrop drop;

  /// Its drop is announced, not released: a silhouette or a secret to come.
  final bool announced;
  final bool paired;
  final VoidCallback? onPair;

  @override
  Widget build(BuildContext context) {
    final d = cell.daemon;
    final number = cell.label == 'secret'
        ? 'A secret'
        : 'Number ${cell.label.substring(1)}';
    final String label;
    if (d != null) {
      label =
          '${d.id}${cell.shiny ? ', shiny' : ''}'
          '${cell.count > 1 ? ', ${cell.count} of it' : ''}'
          '${paired ? ', paired' : ''}';
    } else if (announced) {
      label = '$number of drop ${drop.n} ${drop.name}, out ${drop.release}';
    } else {
      label = cell.label == 'secret'
          ? 'A secret, not found yet'
          : '$number, not hatched yet';
    }
    // The pair is `> tim`, fzf's pointer; `*` is a shiny one, as on the chip.
    final name = d == null
        ? cell.label
        : '${paired ? '> ' : ''}${d.id}${cell.shiny ? '*' : ''}'
              '${cell.count > 1 ? ' x${cell.count}' : ''}';
    final colour = d?.colorFor(shiny: cell.shiny);
    return Semantics(
      key: ValueKey('daemon-shelf-${d?.id ?? '${drop.id}-${cell.label}'}'),
      button: onPair != null,
      selected: paired,
      label: label,
      hint: onPair == null ? null : 'Pairs it',
      excludeSemantics: true,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: onPair,
        child: Container(
          constraints: const BoxConstraints(minHeight: 48),
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
          decoration: BoxDecoration(
            color: DaemonInk.deep,
            borderRadius: BorderRadius.circular(6),
            border: Border.all(
              color: paired ? colour! : DaemonInk.line,
              width: paired ? 1.5 : 1,
            ),
          ),
          child: FittedBox(
            fit: BoxFit.scaleDown,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  cell.top,
                  softWrap: false,
                  textScaler: TextScaler.noScaling,
                  style: DaemonInk.mono(
                    size: 13,
                    color: colour ?? DaemonInk.faint,
                    weight: FontWeight.w600,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  name,
                  softWrap: false,
                  textScaler: TextScaler.noScaling,
                  style: DaemonInk.mono(
                    size: 11,
                    color: d == null ? DaemonInk.faint : DaemonInk.dim,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// Every hatch stays selectable, including two individuals of the same species.
class _Individuals extends StatelessWidget {
  const _Individuals({
    required this.zoo,
    required this.roster,
    required this.def,
    this.art,
    required this.animate,
  });

  final ZooClient zoo;
  final DaemonRoster roster;
  final DaemonDef def;
  final IndividualArt? art;
  final bool animate;

  @override
  Widget build(BuildContext context) {
    final individuals = zoo.zoo.daemons.where((d) => d.id == def.id).toList();
    final catalog = def.traits;
    final rolled = [
      for (final d in individuals)
        if (d.traits(roster) != null) d.traits(roster)!,
    ];
    final colours = {for (final t in rolled) t.colour};
    final marks = {
      for (final t in rolled)
        if (t.marks != null) t.marks!,
    };
    final extras = {
      for (final t in rolled)
        if (t.extra != null) t.extra!,
    };
    String seen(String kind, Set<String> values, int total) =>
        '$kind ${values.length}/$total: ${values.isEmpty ? "none yet" : values.join(", ")}';
    return Column(
      key: ValueKey('daemon-individuals-${def.id}'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const SizedBox(height: 16),
        Text(
          '${def.id}  ${individuals.length}',
          style: DaemonInk.mono(size: 14, color: DaemonInk.bright),
        ),
        if (catalog != null)
          Text(
            [
              seen('colours', colours, catalog.colours.length),
              seen(
                'markings',
                marks,
                catalog.marks.where((m) => m.$1 != null).length,
              ),
              seen(
                'extras',
                extras,
                catalog.extras.where((e) => e.name != null).length,
              ),
            ].join('\n'),
            key: ValueKey('daemon-traits-${def.id}'),
            style: DaemonInk.mono(size: 11, color: DaemonInk.dim),
          ),
        for (final d in individuals)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 8),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                if (def.plate)
                  SizedBox(
                    width: 100,
                    child: DaemonPlateView(
                      roster: roster,
                      def: def,
                      size: PlateSize.portrait,
                      version: d.version,
                      shiny: d.shiny,
                      traits: d.traits(roster),
                      art: art?.frames(d, PlateSize.portrait, d.version),
                      fontSize: 7,
                      animate: animate,
                    ),
                  ),
                const SizedBox(width: 8),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      TextButton(
                        key: ValueKey('daemon-pair-${d.uid}'),
                        onPressed: zoo.paired?.uid == d.uid
                            ? null
                            : () => zoo.pair(d.uid),
                        child: Text(
                          '${zoo.paired?.uid == d.uid ? "> " : ""}${d.title}${d.shiny ? " *" : ""}',
                          style: DaemonInk.mono(
                            size: 12,
                            color: zoo.paired?.uid == d.uid
                                ? DaemonInk.green
                                : DaemonInk.bright,
                          ),
                        ),
                      ),
                      if (d.traits(roster) case final traits?) ...[
                        Text(
                          individualFlags(roster, def.id, traits),
                          style: DaemonInk.mono(size: 11),
                        ),
                        Text(
                          oneInText(oneIn(roster, def.id, traits)),
                          style: DaemonInk.mono(size: 11, color: DaemonInk.dim),
                        ),
                      ],
                    ],
                  ),
                ),
              ],
            ),
          ),
      ],
    );
  }
}

/// The card people share, and a button that copies it as a fenced code block.
class _ShareCard extends StatefulWidget {
  const _ShareCard({
    required this.roster,
    required this.def,
    required this.lines,
    required this.version,
    required this.shiny,
    this.serial,
    this.traits,
    this.art,
  });

  final DaemonRoster roster;
  final DaemonDef def;
  final List<String> lines;
  final String version;
  final bool shiny;
  final int? serial;
  final DaemonTraits? traits;
  final PlateFrame? art;

  @override
  State<_ShareCard> createState() => _ShareCardState();
}

class _ShareCardState extends State<_ShareCard> {
  String? _note;

  Future<void> _copy() async {
    try {
      await Clipboard.setData(ClipboardData(text: fencedCard(widget.lines)));
      if (mounted) setState(() => _note = 'Copied as a code block.');
    } catch (_) {
      if (mounted) setState(() => _note = 'Could not copy the card.');
    }
  }

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      DaemonCardView(
        key: const ValueKey('daemon-card'),
        roster: widget.roster,
        def: widget.def,
        lines: widget.lines,
        version: widget.version,
        shiny: widget.shiny,
        serial: widget.serial,
        traits: widget.traits,
        art: widget.art,
        ground: DaemonInk.deep,
      ),
      const SizedBox(height: 8),
      Row(
        children: [
          Semantics(
            hint: 'Copies the card as a code block',
            child: TextButton(
              key: const ValueKey('daemon-card-share'),
              onPressed: _copy,
              style: TextButton.styleFrom(
                foregroundColor: DaemonInk.yellow,
                minimumSize: const Size(64, 44),
              ),
              child: Text(
                'Share card',
                style: TextStyle(
                  fontFamily: AppFont.sans,
                  fontSize: 15,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Semantics(
              liveRegion: true,
              child: Text(
                _note ?? '',
                style: DaemonInk.sans(size: 13, color: DaemonInk.dim),
              ),
            ),
          ),
        ],
      ),
    ],
  );
}
