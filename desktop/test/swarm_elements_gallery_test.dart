import 'dart:io';
import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/harness_activity.dart';
import 'package:harness/shared/theme/app_icons.dart';
import 'package:harness/shared/theme/app_type.dart';
import 'package:harness/shared/widgets/app_icon_button.dart';
import 'package:harness/state/harness_attachments.dart';
import 'package:harness/super_tabs/buddy_card.dart';
import 'package:harness/super_tabs/buddy_rows.dart';
import 'package:harness/super_tabs/chat/agent_chat_header.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/decisions.dart';
import 'package:harness/super_tabs/decisions_view.dart';
import 'package:harness/super_tabs/avatar_art.dart';
import 'package:harness/super_tabs/identity.dart';
import 'package:harness/super_tabs/message_row.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/super_tabs/reply_box.dart';
import 'package:harness/super_tabs/tasks/personal_task_card.dart';
import 'package:harness/super_tabs/tasks/personal_tasks.dart';
import 'package:harness/super_tabs/tasks/tasks_pane_header.dart';
import 'package:harness/super_tabs/tasks/personal_tasks_pane.dart';
import 'package:harness/terminal/terminal_typography.dart';

import 'super_tab_personal_tasks_pane_test.dart' show TasksFixture;
import 'support/buddy_engine_fixture.dart';
import 'support/super_tab_fixture.dart';

/// The Swarm elements gallery (desktop-design-system.md, Swarm elements): every
/// element drawn in light and dark against its checked-in image. A new or
/// changed element updates the doc and this gallery in the same pull request.
///
/// Each section is its own image per brightness, `test/goldens/swarm-elements/<section>-<light|dark>.png`. Update
/// them with `flutter test --no-pub --update-goldens test/swarm_elements_gallery_test.dart`
/// and look at them before committing.
void main() {
  late GoldenFileComparator previous;
  setUpAll(() async {
    // One font file on every host, so the images match on macOS, Linux and
    // Windows; text is set in the bundled Roboto Mono, icons in Lucide.
    final mono = rootBundle.load('assets/fonts/roboto-mono/RobotoMono.ttf');
    for (final family in {AppType.sansFamily, terminalFontFamily, 'Roboto'}) {
      await (FontLoader(family)..addFont(mono)).load();
    }
    // The activity marks' symbols (◌ ✓ ■ ⊘ and the spinner) come from the
    // host's symbol font, as in the app; they are a few dozen pixels, inside
    // the comparator's tolerance where hosts differ.
    for (final (family, paths) in [
      ('Apple Symbols', ['/System/Library/Fonts/Apple Symbols.ttf']),
      (
        'DejaVu Sans',
        [
          '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
          // macOS has no DejaVu; this face carries the same marks (✓).
          '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
        ],
      ),
    ]) {
      final file = paths.map(File.new).where((f) => f.existsSync()).firstOrNull;
      if (file == null) continue;
      final bytes = ByteData.sublistView(file.readAsBytesSync());
      await (FontLoader(family)..addFont(Future.value(bytes))).load();
    }
    await (FontLoader('packages/lucide_icons_flutter/Lucide400')..addFont(
          rootBundle.load(
            'packages/lucide_icons_flutter/assets/build_font/LucideVariable-w400.ttf',
          ),
        ))
        .load();
    previous = goldenFileComparator;
    goldenFileComparator = _NearlyComparator(
      (previous as LocalFileComparator).basedir.resolve(
        'swarm_elements_gallery_test.dart',
      ),
    );
  });
  tearDownAll(() => goldenFileComparator = previous);

  for (final brightness in Brightness.values) {
    testWidgets(
      'every Swarm element matches its own image in ${brightness.name}',
      (tester) async {
        final bars = await _show(tester, brightness);
        for (final id in _Gallery.sections.keys) {
          final section = find.byKey(_Gallery.section(id));
          (goldenFileComparator as _NearlyComparator).parts = _parts(
            tester,
            tester.getRect(section),
          );
          await expectLater(section, matchesGoldenFile(_image(id, brightness)));
        }
        await _close(tester, bars);
      },
    );
  }

  // Review of task #4461: a whole-image tolerance let a changed element pass. Ellis has Kai's colour with another
  // tilt: only its eyes and smile move.
  testWidgets('one changed face fails its section', (tester) async {
    final bars = await _show(
      tester,
      Brightness.light,
      faces: ['Ellis', ..._faces.skip(1)],
    );
    final section = find.byKey(_Gallery.section('faces'));
    final boundary = tester.renderObject<RenderRepaintBoundary>(section);
    final problem = await tester.runAsync(() async {
      final image = await boundary.toImage();
      final png = await image.toByteData(format: ui.ImageByteFormat.png);
      image.dispose();
      return galleryDifference(
        png!.buffer.asUint8List(),
        File('test/${_image('faces', Brightness.light)}').readAsBytesSync(),
        _parts(tester, tester.getRect(section)),
      );
    });
    expect(problem, contains('agent face Ellis'));
    await _close(tester, bars);
  });

  // The doc and the gallery change together (desktop-design-system.md, Swarm elements), as code: every element the
  // doc lists is drawn by a section, every section draws elements the doc lists, and the images are exactly each
  // section's two, so a stale or missing one fails here rather than in review.
  test('the doc\'s Swarm elements, the gallery\'s sections and their images are the same set', () {
    final doc = File('design/desktop-design-system.md').readAsStringSync();
    final from = doc.indexOf('\n## Swarm elements\n');
    final to = doc.indexOf('\n## ', from + 1);
    final listed = {
      for (final m in RegExp(
        r'^- \*\*([^*]+?)\.?\*\*',
        multiLine: true,
      ).allMatches(doc.substring(from, to)))
        m.group(1)!,
    }..remove('Adding or changing one');
    expect(_Gallery.sections.values.expand((e) => e).toSet(), listed);
    final images = Directory('test/goldens/swarm-elements')
        .listSync()
        .map((f) => f.uri.pathSegments.last)
        .toSet();
    expect(images, {
      for (final id in _Gallery.sections.keys)
        for (final brightness in Brightness.values)
          _image(id, brightness).split('/').last,
    });
  });
}

/// A section's image in [brightness], relative to the test folder.
String _image(String id, Brightness brightness) =>
    'goldens/swarm-elements/$id-${brightness.name}.png';

Future<List<SuperTabController>> _show(
  WidgetTester tester,
  Brightness brightness, {
  List<String> faces = _faces,
}) async {
  final old = grid.AppTheme.brightness.value;
  grid.AppTheme.brightness.value = brightness;
  addTearDown(() => grid.AppTheme.brightness.value = old);
  // The top bars' chats: the reader's own Buddy, and a member agent of a project (task #4465).
  final buddy = buddyEngineSwarm().controller(account: 'peer');
  final member = TasksFixture().controller;
  // A Swarm with no tasks, for the empty Tasks pane (rule 7).
  final empty = (TasksFixture()..rows.clear()).controller;
  for (final c in [buddy, member, empty]) {
    addTearDown(c.dispose);
    await c.refresh();
  }
  await buddy.select('swarm-buddy-peer');
  await member.select('aeef');
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = const Size(760, 1820);
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: grid.buildAppTheme(brightness: brightness),
      // A still spinner, so the image holds one frame.
      home: MediaQuery(
        data: const MediaQueryData(disableAnimations: true),
        child: _Gallery(
          brightness,
          faces: faces,
          bars: [buddy, member],
          empty: empty,
          // The decision cards read their answers' state from a reader's Decisions.
          decisions: SuperTabDecisions.of(member),
        ),
      ),
    ),
  );
  await tester.pump();
  expect(tester.takeException(), isNull);
  return [buddy, member, empty];
}

/// Takes the gallery down and lets the bars' chats save, so no timer outlives the test.
Future<void> _close(WidgetTester tester, List<SuperTabController> bars) async {
  await tester.pumpWidget(const SizedBox());
  for (final c in bars) {
    await c.flush();
  }
}

/// One element's area in the gallery and the share of it that may differ.
typedef GalleryRegion = ({String name, Rect rect, double limit});

/// Faces and the Lead ring are paths Skia draws the same on every host: almost
/// nothing of them may differ.
const _art = .01;

/// An icon or letter is a font glyph that each host smooths differently; a
/// different glyph changes far more than this.
const _glyph = .25;

/// Everything else but words (fills, pills, borders, where each element sits)
/// is drawn alike on every host: at most 38 pixels of a section's image may
/// differ, as the whole gallery's image allowed before it was split (task
/// #4717), under the smallest Lead ring's 80, so a lost element fails too.
/// Words are left out: macOS and Linux smooth their edges too differently to
/// compare by pixel (14,638 pixels on one image), and their copy is tested
/// where they are written.
const _rest = 38;

/// Every element the gallery draws inside [section], each held to its own area,
/// and its words, held to none, in the section image's coordinates.
({List<GalleryRegion> regions, List<Rect> words}) _parts(
  WidgetTester tester,
  Rect section,
) => (
  regions: [
    for (final r in _regions(tester))
      if (section.overlaps(r.rect))
        (name: r.name, rect: r.rect.shift(-section.topLeft), limit: r.limit),
  ],
  // A glyph's smoothed edge reaches a little past its box.
  words: [
    for (final text in find.byType(RichText).evaluate())
      if (tester.getRect(find.byElementPredicate((e) => e == text))
          case final rect when section.overlaps(rect))
        rect.inflate(2).shift(-section.topLeft),
  ],
);

List<GalleryRegion> _regions(WidgetTester tester) {
  final faces = find.byType(SuperTabAvatarFace);
  final avatars = find.byType(SuperTabAvatar);
  final marks = find.descendant(
    of: find.byType(SuperTabTaskStatusMark),
    matching: find.byType(Icon),
  );
  final agentMarks = find.byType(SuperTabAgentMark);
  return [
    for (var i = 0; i < faces.evaluate().length; i++)
      if (tester.widget<SuperTabAvatarFace>(faces.at(i)) case final face)
        face.face && face.picture == null
            ? (
                name: 'agent face ${face.name}',
                rect: tester.getRect(faces.at(i)),
                limit: _art,
              )
            : (
                name: 'avatar ${face.name}',
                rect: tester.getRect(faces.at(i)),
                limit: _glyph,
              ),
    for (var i = 0; i < avatars.evaluate().length; i++)
      if (tester.widget<SuperTabAvatar>(avatars.at(i)) case final avatar
          when avatar.lead)
        (
          name: 'Lead ring ${avatar.name}',
          // The ring, 12% of the face outside its box, and its smoothed edge.
          rect: tester.getRect(avatars.at(i)).inflate(avatar.size * .12 + 1),
          limit: _art,
        ),
    for (var i = 0; i < marks.evaluate().length; i++)
      (
        name: 'status mark ${tester.widget<Icon>(marks.at(i)).semanticLabel}',
        rect: tester.getRect(marks.at(i)),
        limit: _glyph,
      ),
    for (var i = 0; i < agentMarks.evaluate().length; i++)
      (
        name:
            'agent mark ${tester.widget<SuperTabAgentMark>(agentMarks.at(i)).activity.name}',
        rect: tester.getRect(agentMarks.at(i)),
        limit: _glyph,
      ),
  ];
}

/// Why [actual] does not match [expected], or null when it does. A pixel
/// differs when a channel moves by more than a quarter; each region may hold
/// its share of such pixels, and the image outside the words [_rest].
Future<String?> galleryDifference(
  Uint8List actual,
  Uint8List expected,
  ({List<GalleryRegion> regions, List<Rect> words}) parts,
) async {
  final (a, b) = (await _pixels(actual), await _pixels(expected));
  if (a.width != b.width || a.height != b.height) {
    return 'size ${a.width}x${a.height}, expected ${b.width}x${b.height}';
  }
  bool off(int x, int y) {
    final i = (y * a.width + x) * 4;
    for (var c = 0; c < 4; c++) {
      if ((a.bytes[i + c] - b.bytes[i + c]).abs() > 64) return true;
    }
    return false;
  }

  int count(Rect rect, {List<Rect> skip = const []}) {
    final r = rect.intersect(
      Rect.fromLTWH(0, 0, a.width.toDouble(), a.height.toDouble()),
    );
    var n = 0;
    for (var y = r.top.floor(); y < r.bottom.ceil(); y++) {
      for (var x = r.left.floor(); x < r.right.ceil(); x++) {
        final at = Offset(x + .5, y + .5);
        if (off(x, y) && !skip.any((w) => w.contains(at))) n++;
      }
    }
    return n;
  }

  for (final region in parts.regions) {
    final n = count(region.rect);
    final limit = math.max(
      2,
      region.rect.width * region.rect.height * region.limit,
    );
    if (n > limit) {
      return '${region.name}: $n pixels differ (limit ${limit.floor()})';
    }
  }
  final n = count(
    Rect.fromLTWH(0, 0, a.width.toDouble(), a.height.toDouble()),
    skip: parts.words,
  );
  const limit = _rest;
  return n > limit
      ? 'the image outside its words: $n pixels differ (limit ${limit.floor()})'
      : null;
}

Future<({int width, int height, Uint8List bytes})> _pixels(
  Uint8List png,
) async {
  final codec = await ui.instantiateImageCodec(png);
  final image = (await codec.getNextFrame()).image;
  final data = await image.toByteData();
  final pixels = (
    width: image.width,
    height: image.height,
    bytes: data!.buffer.asUint8List(),
  );
  image.dispose();
  codec.dispose();
  return pixels;
}

/// Agent names that pick each of the face's eight colours, in palette order.
const _faces = [
  'Kai',
  'River',
  'Quinn',
  'Buddy',
  'Atlas',
  'Ivy',
  'Milo',
  'Nova',
];

const _statuses = [
  'proposal',
  'planned',
  'working',
  'needs_human',
  'review',
  'blocked',
  'done',
  'stopped',
  'lost',
  'rejected',
];

SuperTabAgent _agent(String name, {String? kind}) => SuperTabAgent.fromJson({
  'id': 'id-$name',
  'name': name,
  'machineId': 'm',
  'harnessId': 'h',
  'contributorId': 'p',
  'configuration': {'engine': 'claude'},
  'kind': ?kind,
});

final _person = SuperTabPerson.fromJson({
  'id': 'p1',
  'email': 'dee@example.com',
  'role': 'owner',
});

/// A person's own Buddy's question, and a line it waits to post as them
/// (task #4525), as the backend lists them.
SuperTabDecision _decision(
  String id,
  String question,
  List<String> options,
  String unblocks, {
  bool send = false,
}) => SuperTabDecision.fromJson({
  'id': id,
  'conversationId': 'buddy',
  'askerName': 'Buddy',
  'question': question,
  'options': options,
  'recommended': send ? 0 : 1,
  'unblocks': unblocks,
  'fromBuddy': true,
  'send': send,
});

/// A Tasks pane card as the pane draws it: the project's capsule, the mark, the title and two 18 faces.
Widget _card(
  String title,
  String status, {
  bool waiting = false,
  bool selected = false,
}) => SuperTabPersonalTaskCard(
  task: SuperTabPersonalTask({
    'id': title,
    'version': 1,
    'at': 0,
    'projectId': 'harness',
    'projectName': 'harness',
    'title': title,
    'status': status,
  }),
  project: 'harness',
  selected: selected,
  onOpen: () {},
  requester: SuperTabAvatar.person(_person, size: 18),
  agent: SuperTabAvatar.agent(_agent('Quinn'), size: 18, engineBadge: false),
  waiting: waiting,
  onApprove: waiting ? () {} : null,
  onReject: waiting ? () {} : null,
);

class _Gallery extends StatelessWidget {
  const _Gallery(
    this.brightness, {
    required this.faces,
    required this.bars,
    required this.empty,
    required this.decisions,
  });
  final Brightness brightness;
  final List<String> faces;

  /// Chats whose top bars the gallery draws: the reader's Buddy, then a member agent.
  final List<SuperTabController> bars;

  /// A Swarm with no tasks: the Tasks pane empty.
  final SuperTabController empty;

  /// Whose answers the decision cards read.
  final SuperTabDecisions decisions;

  /// The gallery's sections, in order, each its own image per brightness, and the doc's elements each draws
  /// (desktop-design-system.md, Swarm elements).
  static const sections = {
    'faces': ['Agent face'],
    'avatars': ['Agent face', 'Lead ring', 'Person avatar'],
    'status-marks': ['Task status marks'],
    'left-pane-rows': ['Left pane row'],
    'tasks-pane': ['Tasks pane header', 'Tasks pane card'],
    'chat': ['Chat message', 'Chat composer'],
    'top-bar': ['Top bar'],
    'empty': ['One surface', 'Left pane row', 'Tasks pane card'],
    'decision-card': ['Decision card'],
  };
  static ValueKey<String> section(String id) => ValueKey('swarm-elements-$id');

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    Widget title(String text) => Padding(
      padding: const EdgeInsets.only(top: 14, bottom: 8),
      child: Text(text, style: Theme.of(context).textTheme.labelLarge),
    );
    Widget gap() => const SizedBox(width: 16);
    // Each section is its own image, light and dark (task #4717): a pull request that changes one element changes only
    // its two images, so two that change different elements never touch the same file.
    Widget section(String id, List<Widget> children) => RepaintBoundary(
      key: _Gallery.section(id),
      child: Container(
        width: 720,
        // Room below for what an element draws outside its box (a Lead ring, 12% of its face), so it stays in this
        // section's image.
        padding: const EdgeInsets.only(bottom: 8),
        color: Theme.of(context).colorScheme.surface,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: children,
        ),
      ),
    );
    return Material(
      color: Theme.of(context).colorScheme.surface,
      child: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'Swarm elements / ${brightness.name}',
              style: Theme.of(context).textTheme.titleMedium,
            ),
            section('faces', [
              title('Agent face: eight colours'),
              Row(
                children: [
                  for (final name in faces) ...[
                    SuperTabAvatar.agent(
                      _agent(name),
                      size: 40,
                      engineBadge: false,
                    ),
                    gap(),
                  ],
                ],
              ),
            ]),
            section('avatars', [
              title('Agent face, Lead ring and person at 20, 24, 30'),
              Row(
                children: [
                  for (final size in [20.0, 24.0, 30.0]) ...[
                    SuperTabAvatar.agent(
                      _agent('Kai'),
                      size: size,
                      engineBadge: false,
                    ),
                    gap(),
                    SuperTabAvatar.agent(
                      _agent('River'),
                      size: size,
                      engineBadge: false,
                      lead: true,
                    ),
                    gap(),
                    SuperTabAvatar.person(_person, size: size),
                    gap(),
                    gap(),
                  ],
                ],
              ),
            ]),
            section('status-marks', [
              title('Task status marks'),
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  for (final status in _statuses)
                    SizedBox(
                      width: 72,
                      child: Column(
                        children: [
                          SuperTabTaskStatusMark(status),
                          const SizedBox(height: 4),
                          Text(
                            superTabTaskStatusLabel(status),
                            textAlign: TextAlign.center,
                            maxLines: 2,
                            style: Theme.of(context).textTheme.labelSmall,
                          ),
                        ],
                      ),
                    ),
                ],
              ),
            ]),
            section('left-pane-rows', [
              title('Left pane rows'),
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  SizedBox(
                    width: 280,
                    child: Column(
                      children: [
                        // The Desktop left pane (task #4466).
                        SuperTabQuietHeading.org('autonomous.ai', onTap: () {}),
                        SuperTabQuietRow(
                          leading: const Icon(
                            AppIcons.inbox,
                            size: AppIcons.inlineSize,
                          ),
                          name: 'Decisions',
                          detail: '3',
                          unread: true,
                          onTap: () {},
                        ),
                        SuperTabQuietHeading(
                          'My agents',
                          collapsed: false,
                          onTap: () {},
                        ),
                        for (final (name, lead, detail, mark, selected) in [
                          ('River', true, 'harness', null, false),
                          ('Quinn', false, null, null, true),
                          ('Kai', false, null, HarnessActivity.working, false),
                          (
                            'Sage',
                            false,
                            'offline',
                            HarnessActivity.needsInput,
                            false,
                          ),
                          ('Lark', false, null, HarnessActivity.failed, false),
                        ])
                          SuperTabQuietRow(
                            leading: SuperTabAvatar.agent(
                              _agent(name, kind: lead ? 'pm' : null),
                              size: SuperTabQuietRow.faceSize,
                              engineBadge: false,
                              lead: lead,
                            ),
                            name: name,
                            detail: detail,
                            selected: selected,
                            mark: mark == null ? null : SuperTabAgentMark(mark),
                            markColumn: true,
                            onTap: () {},
                          ),
                        SuperTabQuietHeading('Humans', onTap: () {}),
                        SuperTabQuietRow(
                          leading: SuperTabAvatar.person(
                            _person,
                            size: SuperTabQuietRow.faceSize,
                          ),
                          name: 'dee',
                          detail: '120',
                          onTap: () {},
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ]),
            section('tasks-pane', [
              title(
                'Tasks pane: header, a waiting, a working and a selected card',
              ),
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  SizedBox(
                    width: 340,
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        SuperTabTasksPaneHeader(
                          mode: 'autoApprove',
                          onChanged: (_) {},
                        ),
                        _card(
                          'Friendly agent faces and a gold Lead ring',
                          'proposal',
                          waiting: true,
                        ),
                      ],
                    ),
                  ),
                  gap(),
                  SizedBox(
                    width: 340,
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        _card('Quiet cards in the Tasks pane', 'working'),
                        const SizedBox(height: 8),
                        _card(
                          'Round faces in the chat',
                          'done',
                          selected: true,
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ]),
            section('chat', [
              title('Chat: message rows, and the composer empty and typed'),
              SizedBox(
                width: 440,
                child: Column(
                  children: [
                    _message(
                      'River',
                      'New Project is in the sidebar now.',
                      agent: _agent('River'),
                    ),
                    _message('dee', 'Found it, thanks!', person: _person),
                  ],
                ),
              ),
              const SizedBox(height: 8),
              const Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  SizedBox(width: 340, child: _Composer('empty', '')),
                  SizedBox(width: 16),
                  SizedBox(width: 340, child: _Composer('typed', 'Ship it')),
                ],
              ),
            ]),
            section('top-bar', [
              title('Top bar: your Buddy, a member agent'),
              for (final c in bars)
                SizedBox(
                  width: 720,
                  child: SuperTabAgentChatHeader(
                    controller: c,
                    group: c.selected!,
                    menu: AppIconButton(
                      icon: AppIcons.ellipsis,
                      tooltip: 'Chat options',
                      onPressed: () {},
                    ),
                    title: c.selected!.isBuddyChat
                        ? (name) => BuddyCardButton(
                            controller: c,
                            projectId: c.selected!.projectId,
                            label: name,
                          )
                        : null,
                  ),
                ),
              // Empty means empty (anh Dee's rule 7): each element with nothing optional, and no words for what
              // is not there.
            ]),
            section('empty', [
              title('Empty: a row, a task card and the Tasks pane'),
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  SizedBox(
                    width: 280,
                    child: SuperTabQuietRow(
                      leading: SuperTabAvatar.agent(
                        _agent('Ivy'),
                        size: SuperTabQuietRow.faceSize,
                        engineBadge: false,
                      ),
                      name: 'Ivy',
                      onTap: () {},
                    ),
                  ),
                  gap(),
                  SizedBox(
                    width: 340,
                    child: SuperTabPersonalTaskCard(
                      task: SuperTabPersonalTask({
                        'id': 't2',
                        'version': 1,
                        'at': 0,
                        'projectId': 'harness',
                        'projectName': 'harness',
                        'title': 'A task nobody has taken',
                        'status': 'planned',
                      }),
                      project: 'harness',
                      selected: false,
                      onOpen: () {},
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 8),
              SizedBox(
                width: 340,
                height: 120,
                child: SuperTabPersonalTasksPane(
                  controller: empty,
                  onOpenTask: (_) {},
                ),
              ),
            ]),
            section('decision-card', [
              title('Decision card: a Buddy question and a send line'),
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  SizedBox(
                    width: 340,
                    child: SuperTabDecisionCard(
                      decisions: decisions,
                      decision: _decision('d1', 'Keep the old flag a week?', [
                        'Keep it',
                        'Drop it',
                      ], 'The cleanup'),
                      onNotNow: () {},
                    ),
                  ),
                  SizedBox(
                    width: 340,
                    child: SuperTabDecisionCard(
                      decisions: decisions,
                      decision: _decision(
                        'd2',
                        'Drop the old --legacy-sync flag from the CLI.',
                        ['Send', 'Not now'],
                        'Posts this in the harness chat as you.',
                        send: true,
                      ),
                      onNotNow: () {},
                    ),
                  ),
                ],
              ),
            ]),
          ],
        ),
      ),
    );
  }
}

/// A chat message row, as the chat draws one. Its time is words, which the
/// comparison leaves out, so the image holds in every time zone.
Widget _message(
  String author,
  String text, {
  SuperTabAgent? agent,
  SuperTabPerson? person,
}) => SuperTabMessageRow(
  message: SuperTabMessage.fromJson({
    'id': 'm-$author',
    'conversationId': 'lead',
    'text': text,
    'sequence': 1,
    'createdAt': '2026-11-07T09:12:00Z',
    'author': agent != null
        ? {'kind': 'agent', 'id': agent.id, 'name': author}
        : {'kind': 'person', 'id': person!.id, 'name': 'dee@example.com'},
  }),
  author: author,
  agent: agent,
  person: person,
  receipts: const [],
  onReturnToComposer: () {},
  readerId: 'p1',
);

/// A chat composer ([SuperTabReplyBox], the box both composers draw) holding
/// [typed]: the round send grey while empty, blue once there is text.
class _Composer extends StatefulWidget {
  const _Composer(this.name, this.typed);
  final String name, typed;

  @override
  State<_Composer> createState() => _ComposerState();
}

class _ComposerState extends State<_Composer> {
  final SuperTabController controller = ConversationServer().controller();
  late final text = TextEditingController(text: widget.typed);
  final focus = FocusNode();
  final files = HarnessAttachments();

  @override
  void dispose() {
    text.dispose();
    focus.dispose();
    files.dispose();
    controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => SuperTabReplyBox(
    controller: controller,
    text: text,
    focus: focus,
    files: files,
    enabled: true,
    writable: true,
    busy: false,
    error: null,
    onEdited: (_) {},
    onSend: () {},
    onMic: () {},
    hint: 'Message #Pilot',
    surfaceKey: ValueKey('gallery-composer-${widget.name}'),
    fieldKey: ValueKey('gallery-composer-field-${widget.name}'),
    sendKey: ValueKey('gallery-composer-send-${widget.name}'),
    micKey: ValueKey('gallery-composer-mic-${widget.name}'),
  );
}

/// Matches when [galleryDifference] finds none. A mismatch fails with what
/// differs and saves the image it drew to the system temp folder, never into
/// the source tree, where CI's runner would count it as a changed source.
class _NearlyComparator extends LocalFileComparator {
  _NearlyComparator(super.testFile);

  /// The elements and words of the image being compared.
  ({List<GalleryRegion> regions, List<Rect> words}) parts = (
    regions: const [],
    words: const [],
  );

  @override
  Future<bool> compare(Uint8List imageBytes, Uri golden) async {
    final file = File.fromUri(basedir.resolveUri(golden));
    final problem = file.existsSync()
        ? await galleryDifference(imageBytes, file.readAsBytesSync(), parts)
        : 'no image yet; make it with --update-goldens';
    if (problem == null) return true;
    final drawn = File(
      '${Directory.systemTemp.createTempSync('swarm-gallery-').path}/'
      '${golden.pathSegments.last}',
    )..writeAsBytesSync(imageBytes);
    throw FlutterError('$golden: $problem. What it drew: ${drawn.path}');
  }
}
