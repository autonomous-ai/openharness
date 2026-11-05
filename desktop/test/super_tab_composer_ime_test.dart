import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/super_tab_fixture.dart';

/// What an input method shows while it composes: the box's whole text and the
/// marked range it still owns ([TextRange.empty] once committed).
typedef _Step = ({String text, TextRange composing});

_Step _marked(String text, int start) =>
    (text: text, composing: TextRange(start: start, end: text.length));
_Step _plain(String text) => (text: text, composing: TextRange.empty);

/// Typed right after `@F `, where Leo saw it (task #3245).
const _before = '@F ';
const _at = _before.length;

/// Each composition as the platform reports it, and the step after which a
/// controller update lands while the input method is still composing.
final _compositions = <String, ({List<_Step> steps, int updateAfter})>{
  // Telex: a, a makes â, then the sắc tone.
  'Telex â then a tone': (
    steps: [
      _marked('${_before}a', _at),
      _marked('$_beforeâ', _at),
      _marked('$_beforeấ', _at),
      _plain('$_beforeấ'),
    ],
    updateAfter: 1,
  ),
  // Telex: u, a backspace in the marked text, then ư.
  'Telex u, backspace, ư': (
    steps: [
      _marked('${_before}u', _at),
      _plain(_before),
      _marked('$_beforeư', _at),
      _plain('$_beforeư'),
    ],
    updateAfter: 0,
  ),
  // Japanese: kana typed, then converted to kanji.
  'Japanese kana to kanji': (
    steps: [
      _marked('$_beforeか', _at),
      _marked('$_beforeかん', _at),
      _marked('$_beforeかんじ', _at),
      _marked('$_before漢字', _at),
      _plain('$_before漢字'),
    ],
    updateAfter: 1,
  ),
  // Korean: jamo built into one syllable.
  'Korean jamo to syllable': (
    steps: [
      _marked('$_beforeㅎ', _at),
      _marked('$_before하', _at),
      _marked('$_before한', _at),
      _plain('$_before한'),
    ],
    updateAfter: 1,
  ),
};

/// A chat box replaces nothing while an input method composes in it: a
/// controller update that lands mid-composition, with a saved draft a
/// keystroke behind the box, leaves every marked step as the platform sent it,
/// so the input method and the box agree on what is typed. Otherwise the next
/// diacritic lands on text the input method no longer sees and stacks.
void main() {
  final macOS = TargetPlatformVariant.only(TargetPlatform.macOS);
  final mainBox = find.byKey(const ValueKey('super-message-composer'));
  final threadBox = find.byKey(const ValueKey('super-thread-composer'));
  final line = find.byKey(const ValueKey('super-thread-line-message-1'));

  late SuperTabController shown;

  Future<ConversationServer> show(
    WidgetTester tester,
    ConversationServer server,
  ) async {
    await tester.binding.setSurfaceSize(const Size(1400, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final c = shown = server.controller();
    await c.refresh();
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        home: Scaffold(
          body: SuperTabView(
            controller: c,
            onInvite: () {},
            onAddAgent: (_) {},
            onOpenTerminal: (_) {},
            machineName: (_) => 'Team Mac',
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    return server;
  }

  /// A test that takes the view down and settles the draft save before it
  /// ends, as the chat's own tests do.
  void testBox(String description, Future<void> Function(WidgetTester) body) =>
      testWidgets(description, (tester) async {
        await body(tester);
        await tester.pumpWidget(const SizedBox());
        await shown.flush();
        shown.dispose();
      }, variant: macOS);

  TextEditingValue valueOf(WidgetTester tester, Finder box) =>
      tester.widget<TextField>(box).controller!.value;

  void send(WidgetTester tester, _Step step) =>
      tester.testTextInput.updateEditingValue(
        TextEditingValue(
          text: step.text,
          selection: TextSelection.collapsed(offset: step.text.length),
          composing: step.composing,
        ),
      );

  /// Replays [steps] into [box]; after step [updateAfter] the saved draft
  /// falls a keystroke behind ([lagDraft]) and the controller updates.
  Future<void> replay(
    WidgetTester tester,
    ConversationServer server,
    Finder box, {
    required List<_Step> steps,
    required int updateAfter,
    required void Function(String text) lagDraft,
    required String Function() draft,
  }) async {
    await tester.tap(box);
    await tester.pump();
    send(tester, _plain(_before));
    await tester.pump();
    var previous = _before;
    for (final (index, step) in steps.indexed) {
      send(tester, step);
      await tester.pump();
      expect(
        valueOf(tester, box),
        TextEditingValue(
          text: step.text,
          selection: TextSelection.collapsed(offset: step.text.length),
          composing: step.composing,
        ),
        reason: 'step ${index + 1} as the input method sent it',
      );
      if (index == updateAfter) {
        // The draft is a keystroke behind the box, and the controller
        // updates while the input method is still composing.
        lagDraft(previous);
        server.append('A reply while you type.');
        await shown.refresh();
        await tester.pump();
        expect(
          valueOf(tester, box),
          TextEditingValue(
            text: step.text,
            selection: TextSelection.collapsed(offset: step.text.length),
            composing: step.composing,
          ),
          reason: 'a controller update mid-composition replaces nothing',
        );
      }
      previous = step.text;
    }
    await tester.pump();
    final committed = steps.last.text;
    expect(valueOf(tester, box).text, committed);
    expect(
      valueOf(tester, box).selection,
      TextSelection.collapsed(offset: committed.length),
    );
    expect(draft(), committed, reason: 'the committed text is the draft');
  }

  group('main composer', () {
    for (final MapEntry(key: name, value: composition)
        in _compositions.entries) {
      testBox('$name survives a controller update', (tester) async {
        final server = await show(
          tester,
          ConversationServer()..append('Which build?'),
        );
        final id = shown.selectedId;
        await replay(
          tester,
          server,
          mainBox,
          steps: composition.steps,
          updateAfter: composition.updateAfter,
          lagDraft: (text) => shown.setDraft(id, text),
          draft: () => shown.draft(id),
        );
      });
    }

    testBox('a draft changed while nobody composes still shows at once', (
      tester,
    ) async {
      final server = await show(
        tester,
        ConversationServer()..append('Which build?'),
      );
      final id = shown.selectedId;
      await tester.tap(mainBox);
      await tester.pump();
      send(tester, _plain('xin chào'));
      await tester.pump();
      shown.setDraft(id, 'from elsewhere');
      server.append('A reply.');
      await shown.refresh();
      await tester.pump();
      expect(
        valueOf(tester, mainBox),
        const TextEditingValue(
          text: 'from elsewhere',
          selection: TextSelection.collapsed(offset: 14),
        ),
      );
    });

    testBox('a draft changed mid-composition shows once it ends, caret kept', (
      tester,
    ) async {
      final server = await show(
        tester,
        ConversationServer()..append('Which build?'),
      );
      final id = shown.selectedId;
      await tester.tap(mainBox);
      await tester.pump();
      send(tester, _marked('xin chào', 4));
      await tester.pump();
      shown.setDraft(id, 'xin chào bạn');
      server.append('A reply.');
      await shown.refresh();
      await tester.pump();
      expect(valueOf(tester, mainBox).text, 'xin chào');
      // Committed with no further edit: the draft the controller holds now
      // takes the box, and the caret stays where the person left it.
      send(tester, _plain('xin chào'));
      await tester.pump();
      expect(
        valueOf(tester, mainBox),
        const TextEditingValue(
          text: 'xin chào bạn',
          selection: TextSelection.collapsed(offset: 8),
        ),
      );
    });
  });

  group('thread reply box', () {
    ConversationServer threaded() {
      final server = ConversationServer()..threads = true;
      server.append('Should we do thread replies?');
      server.append('Yes, like Slack.');
      server.messages.last
        ..['thread'] = 'message-1'
        ..['replyTo'] = 'message-1';
      return server;
    }

    for (final MapEntry(key: name, value: composition)
        in _compositions.entries) {
      testBox('$name survives a controller update', (tester) async {
        final server = await show(tester, threaded());
        await tester.tap(line);
        await tester.pumpAndSettle();
        await replay(
          tester,
          server,
          threadBox,
          steps: composition.steps,
          updateAfter: composition.updateAfter,
          lagDraft: (text) => shown.setThreadDraft('message-1', text),
          draft: () => shown.threadDraft('message-1'),
        );
      });
    }
  });
}
