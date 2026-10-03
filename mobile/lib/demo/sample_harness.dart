import 'dart:async';
import 'dart:collection';

import 'sample_screen.dart';

/// One beat of a script: something the harness does, [delay] after the beat before it.
sealed class SampleStep {
  const SampleStep(this.delay);
  final Duration delay;
}

/// A transcript item appears.
class EmitStep extends SampleStep {
  const EmitStep(this.entry, super.delay);
  final SampleEntry entry;
}

/// The spinner changes its word.
class VerbStep extends SampleStep {
  const VerbStep(this.verb, super.delay);
  final String verb;
}

/// The turn ends, having said [reply].
class DoneStep extends SampleStep {
  const DoneStep(this.reply, super.delay);
  final String reply;
}

/// Work that never ends: the next stretch of it, asked for each time the last one runs out.
abstract interface class SampleLoop {
  List<SampleStep> next();
}

/// What a harness needs from the sample around it: a clock, and somewhere to report to.
///
/// Every timer comes from here, so the sample can cancel all of them at once when it is left —
/// a harness never owns a timer the host does not know about.
abstract interface class SampleHarnessHost {
  Timer schedule(Duration delay, void Function() run);
  Timer every(Duration period, void Function() run);

  /// The transcript grew by [entries].
  void appended(SampleHarness harness, List<SampleEntry> entries);

  /// The live region changed — typing, the spinner, a dialog opening or closing.
  void liveChanged(SampleHarness harness);

  void workingChanged(SampleHarness harness, bool working);
  void askChanged(SampleHarness harness, SampleAsk? ask);
  void turnEnded(SampleHarness harness, String? reply);

  /// What the harness answers when somebody asks it for [text].
  List<SampleStep> replyTo(SampleHarness harness, String text);
}

/// One sample harness: a CLI's screen, driven by a script instead of a model.
///
/// It keeps what a real one would have on screen — a transcript and a live region — and moves
/// them the way Claude Code or Codex would: a turn is a queue of [SampleStep]s played out on the
/// host's clock, the spinner turns while it works, a permission question stops the queue until it
/// is answered, and what is typed at it goes into its prompt box and comes back as a reply.
class SampleHarness {
  SampleHarness({
    required this.machineId,
    required this.agent,
    required this.host,
    List<SampleEntry> transcript = const [],
    this.loop,
  }) : transcript = [...transcript],
       look = SampleLook.of(agent['engine'] as String? ?? 'claude');

  final String machineId;

  /// The agent as a machine describes it — what `agents_list` answers with. Edited in place by a
  /// rename, a use, a turn.
  final Map<String, dynamic> agent;
  final SampleHarnessHost host;
  final SampleLook look;
  final List<SampleEntry> transcript;
  final LiveState live = LiveState();

  /// Endless work, for the harness that is always busy. Dropped by an interrupt.
  SampleLoop? loop;

  /// What the person asked lately and what the turns said, newest first — the machine's
  /// `agent_recent`, which Find quotes.
  final List<String> asks = [];
  final List<String> replies = [];

  String get agentId => agent['id'] as String;
  String get engine => look.engine;
  String get cwd => (agent['project'] as Map?)?['cwd'] as String? ?? '~/code';

  /// The oldest items drop off past this — the pane keeps them in its own scrollback, and a
  /// keyframe does not need a day of history to look like a session.
  static const maxEntries = 120;

  final Queue<SampleStep> _queue = Queue();
  Timer? _next;
  Timer? _spin;
  List<SampleStep> Function(int answer)? _onAnswer;
  final List<String> _waiting = [];
  bool _disposed = false;

  bool get working => live.mode == LiveMode.working;
  bool get asking => live.mode == LiveMode.asking;

  // ── turns ──────────────────────────────────────────────────────────────────────────────────

  /// Starts it where its script says it is: working through [steps], or asking [ask].
  void begin({
    List<SampleStep> steps = const [],
    String verb = 'Thinking',
    SampleAsk? ask,
    List<SampleStep> Function(int answer)? then,
  }) {
    if (ask != null) {
      live
        ..mode = LiveMode.asking
        ..ask = ask
        ..selected = 0;
      _onAnswer = then;
      host.askChanged(this, ask);
      return;
    }
    if (steps.isEmpty && loop == null) return;
    _queue.addAll(steps);
    _beginWork(verb);
    _pump();
  }

  /// Something to do: typed and returned, voiced, or sent as a message. It is echoed into the
  /// transcript and answered — straight away, or after the step already under way.
  void submit(String text) {
    final said = text.trim();
    if (said.isEmpty || _disposed) return;
    if (asking) {
      // A dialog is on screen, and a message is not an answer to it: it waits for the dialog.
      _waiting.add(said);
      return;
    }
    live.input = '';
    asks.insert(0, said);
    if (asks.length > 3) asks.removeLast();
    agent['title'] ??= said.length <= 60 ? said : '${said.substring(0, 59)}…';
    _append(UserEntry(said));
    final steps = host.replyTo(this, said);
    // Ahead of whatever the loop has queued: a person asking is what happens next.
    for (final step in steps.reversed) {
      _queue.addFirst(step);
    }
    _beginWork('Thinking');
    _pump();
  }

  /// A row of the open question, from 0.
  void answer(int index) {
    final ask = live.ask;
    if (!asking || ask == null || index < 0 || index >= ask.options.length) {
      return;
    }
    final then = _onAnswer;
    _onAnswer = null;
    live
      ..ask = null
      ..selected = 0
      ..mode = LiveMode.idle;
    host.askChanged(this, null);
    final steps = then?.call(index) ?? const <SampleStep>[];
    for (final step in steps.reversed) {
      _queue.addFirst(step);
    }
    _beginWork('Thinking');
    host.liveChanged(this);
    _pump();
  }

  /// Esc: a dialog is declined, a turn is stopped.
  void interrupt() {
    if (asking) {
      answer((live.ask?.options.length ?? 1) - 1);
      return;
    }
    if (!working) return;
    _next?.cancel();
    _next = null;
    _queue.clear();
    loop = null;
    _append(
      NoteEntry(
        engine == 'codex'
            ? 'Conversation interrupted - tell the model what to do differently'
            : 'Interrupted by user',
      ),
    );
    _finish(null);
  }

  /// Everything still to do goes, the endless work included — for a reply that stops it.
  void dropQueuedWork() {
    _next?.cancel();
    _next = null;
    _queue.clear();
    loop = null;
  }

  /// A restart: the engine comes back up in the same pane, as a fresh process would.
  void restart() {
    _next?.cancel();
    _next = null;
    _queue.clear();
    if (working) _finish(null);
    _append(BannerEntry(cwd));
  }

  // ── keys ───────────────────────────────────────────────────────────────────────────────────

  /// Keystrokes from the pane, as a terminal would deliver them.
  void keys(String data) {
    if (_disposed) return;
    var i = 0;
    var typed = false;
    while (i < data.length) {
      final char = data[i];
      if (data.startsWith('\x1b[200~', i)) {
        // A bracketed paste: everything up to its close is text.
        final end = data.indexOf('\x1b[201~', i + 6);
        final text = data.substring(i + 6, end < 0 ? data.length : end);
        if (!asking) {
          live.input += text.replaceAll(RegExp(r'[\r\n]+'), ' ');
          typed = true;
        }
        i = end < 0 ? data.length : end + 6;
        continue;
      }
      if (char == '\x1b') {
        final sequence = RegExp(r'^\x1b(\[[0-9;?]*[@-~]|O[@-~])')
            .matchAsPrefix(data, i);
        if (sequence == null) {
          interrupt();
          i++;
          continue;
        }
        final code = sequence.group(1)!;
        final key = code.substring(code.length - 1);
        if (asking && (key == 'A' || key == 'B')) {
          final count = live.ask!.options.length;
          live.selected =
              (live.selected + (key == 'A' ? -1 : 1) + count) % count;
          host.liveChanged(this);
        }
        i += sequence.group(0)!.length;
        continue;
      }
      if (char == '\r' || char == '\n') {
        if (asking) {
          answer(live.selected);
        } else {
          final text = live.input;
          live.input = '';
          if (text.trim().isEmpty) {
            typed = true;
          } else {
            submit(text);
          }
        }
        i++;
        continue;
      }
      if (asking) {
        final number = int.tryParse(char);
        if (number != null) answer(number - 1);
        i++;
        continue;
      }
      switch (char) {
        case '\x7f' || '\x08':
          if (live.input.isNotEmpty) {
            final runes = live.input.runes.toList()..removeLast();
            live.input = String.fromCharCodes(runes);
            typed = true;
          }
        case '\x15' || '\x03':
          // Ctrl+U, and Ctrl+C on a prompt: the line goes.
          if (live.input.isNotEmpty) {
            live.input = '';
            typed = true;
          }
        case '\t' || '\x05' || '\x01':
          break;
        default:
          if (char.codeUnitAt(0) >= 0x20) {
            live.input += char;
            typed = true;
          }
      }
      i++;
    }
    if (typed) host.liveChanged(this);
  }

  // ── the queue ──────────────────────────────────────────────────────────────────────────────

  void _pump() {
    if (_disposed || _next != null || asking) return;
    if (_queue.isEmpty) {
      final more = loop?.next();
      if (more == null || more.isEmpty) {
        if (working) _finish(null);
        return;
      }
      _queue.addAll(more);
    }
    final step = _queue.removeFirst();
    _next = host.schedule(step.delay, () {
      _next = null;
      _run(step);
      _pump();
    });
  }

  void _run(SampleStep step) {
    switch (step) {
      case EmitStep(:final entry):
        live.tokens += 180 + transcript.length * 7 % 240;
        _append(entry);
      case VerbStep(:final verb):
        live.verb = verb;
        host.liveChanged(this);
      case DoneStep(:final reply):
        replies.insert(0, reply);
        if (replies.length > 3) replies.removeLast();
        // A harness that is always busy keeps going; a turn that is done is done.
        if (loop == null) _finish(reply);
    }
  }

  void _append(SampleEntry entry) {
    transcript.add(entry);
    if (transcript.length > maxEntries) {
      transcript.removeRange(0, transcript.length - maxEntries);
    }
    host.appended(this, [entry]);
  }

  void _beginWork(String verb) {
    live.verb = verb;
    if (working) {
      host.liveChanged(this);
      return;
    }
    live
      ..mode = LiveMode.working
      ..ticks = 0
      ..tokens = 0;
    _spin ??= host.every(sampleSpinnerTick, () {
      live
        ..ticks += 1
        ..tokens += 37;
      host.liveChanged(this);
    });
    host.workingChanged(this, true);
    host.liveChanged(this);
  }

  void _finish(String? reply) {
    _stopSpin();
    if (!working) return;
    live.mode = LiveMode.idle;
    agent['updatedAt'] = DateTime.now().toUtc().toIso8601String();
    host.workingChanged(this, false);
    host.turnEnded(this, reply);
    host.liveChanged(this);
    // What was said while a dialog was up, now that it is gone.
    if (_waiting.isNotEmpty) submit(_waiting.removeAt(0));
  }

  void _stopSpin() {
    _spin?.cancel();
    _spin = null;
  }

  void dispose() {
    _disposed = true;
    _next?.cancel();
    _next = null;
    _stopSpin();
    _queue.clear();
  }
}
