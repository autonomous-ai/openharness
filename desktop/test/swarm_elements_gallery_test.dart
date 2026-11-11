import 'dart:io';
import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/browser/browser_panel.dart';
import 'package:harness/browser/browser_settings.dart';
import 'package:harness/browser/browser_settings_page.dart';
import 'package:harness/browser/browser_setup_dialog.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shared/theme/app_icons.dart';
import 'package:harness/super_tabs/chat/chat_card.dart';
import 'package:harness/super_tabs/chat/chat_time.dart';
import 'package:harness/super_tabs/chat/composer_pill.dart';
import 'package:harness/super_tabs/chat/send_button.dart';
import 'package:harness/super_tabs/swarm_type.dart';
import 'package:harness/widgets/desktop_chrome.dart';
import 'package:harness/shared/theme/app_type.dart';
import 'package:harness/state/harness_attachments.dart';
import 'package:harness/super_tabs/channel_talk.dart';
import 'package:harness/super_tabs/quiet_rows.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/github_row.dart';
import 'package:harness/super_tabs/task_board.dart';
import 'package:harness/super_tabs/agent_instructions.dart';
import 'package:harness/super_tabs/avatar_art.dart';
import 'package:harness/super_tabs/agent_info.dart';
import 'package:harness/super_tabs/back_to_chat.dart';
import 'package:harness/super_tabs/identity.dart';
import 'package:harness/super_tabs/instructions_link.dart';
import 'package:harness/super_tabs/machines.dart';
import 'package:harness/super_tabs/message_receipt.dart';
import 'package:harness/super_tabs/message_row.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/super_tabs/personal_agents.dart';
import 'package:harness/super_tabs/project_sidebar.dart'
    show SuperTabFoldRow, SwarmStartRow;
import 'package:harness/super_tabs/reply_box.dart';
import 'package:harness/terminal/terminal_typography.dart';

import 'support/swarm_v4_data.dart';
import 'support/super_tab_fixture.dart';

/// The Swarm elements gallery (desktop-design-system.md, Swarm elements): every
/// element drawn in light and dark, each section against its own checked-in
/// image, `test/goldens/swarm-elements/<section>-<light|dark>.png`, so a pull
/// request that changes one element changes only its section's two images. A
/// new or changed element updates the doc and this gallery in the same pull
/// request.
///
/// Update the images with
/// `flutter test --no-pub --update-goldens test/swarm_elements_gallery_test.dart`
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
      'every Swarm element matches its section\'s image in ${brightness.name}',
      (tester) async {
        final bars = await _show(tester, brightness);
        final sections = _sections();
        expect(sections, isNotEmpty);
        final parts = _parts(tester);
        // Every section is compared, so one run names every image that moved.
        final problems = <String>[];
        for (final id in sections) {
          final section = find.byKey(_Gallery.section(id));
          (goldenFileComparator as _NearlyComparator).parts = _within(
            parts,
            tester.getRect(section),
          );
          try {
            await expectLater(
              section,
              matchesGoldenFile(_image(id, brightness)),
            );
          } on TestFailure catch (e) {
            problems.add(e.message ?? id);
          }
        }
        await _close(tester, bars);
        expect(problems, isEmpty);
      },
    );
  }

  // A renamed or removed section would leave its old images behind, compared by nothing.
  testWidgets('the images are exactly the sections\' images', (tester) async {
    final bars = await _show(tester, Brightness.light);
    final images = {
      for (final f in Directory('test/goldens/swarm-elements').listSync())
        if (f.path.endsWith('.png'))
          'goldens/swarm-elements/${f.uri.pathSegments.last}',
    };
    expect(images, {
      for (final id in _sections())
        for (final brightness in Brightness.values) _image(id, brightness),
    });
    await _close(tester, bars);
  });

  // Task #4645 (anh Dee 22:25): every row's right-side detail ends at one edge, in every section of the left pane, and
  // the + on a heading ends there too.
  testWidgets('the left pane\'s details end at one edge', (tester) async {
    final bars = await _show(tester, Brightness.light);
    final details = find.descendant(
      of: find.byKey(_Gallery.leftPane),
      matching: find.byWidgetPredicate(
        (w) => w is Text && w.textAlign == TextAlign.right,
      ),
    );
    final rights = {
      for (final e in details.evaluate())
        tester.getRect(find.byWidget(e.widget)).right,
    };
    expect(details.evaluate(), isNotEmpty);
    expect(rights, hasLength(1), reason: '$rights');
    // The headings' +, Your Team's and Projects': each glyph's box ends on the same edge.
    final plus = find.descendant(
      of: find.byKey(_Gallery.leftPane),
      matching: find.byIcon(AppIcons.plus),
    );
    expect(plus, findsNWidgets(2));
    for (final e in plus.evaluate()) {
      expect(
        tester.getRect(find.byWidget(e.widget)).right,
        moreOrLessEquals(rights.single),
      );
    }
    await _close(tester, bars);
  });

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
        _within(_parts(tester), tester.getRect(section)),
      );
    });
    expect(problem, contains('agent face Ellis'));
    await _close(tester, bars);
  });
}

/// The gallery's sections on screen, in order.
List<String> _sections() => [
  for (final e in find.byType(RepaintBoundary).evaluate())
    if (e.widget.key case ValueKey<String>(:final value)
        when value.startsWith(_Gallery.sectionPrefix))
      value.substring(_Gallery.sectionPrefix.length),
];

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
  // Faye's pane reads her own file and, under it, the project's AGENTS.md and CLAUDE.md, as her computer sends them.
  final computer =
      SwarmV4Computer(
          files: {'h/Faye': 'Answer in Vietnamese.\nNever push to main.'},
        )
        ..shared = [
          {
            'name': 'AGENTS.md',
            'text': '# lampOS\n\nShip small.\nKeep the answer short, and say\nwhat you checked.',
            'truncated': true,
          },
          {
            'name': 'CLAUDE.md',
            'text': 'Read AGENTS.md first.',
            'truncated': false,
          },
        ]
        ..skipped = [
          {'name': 'CLAUDE.local.md', 'why': 'link'},
        ];
  // The task cards read the lampOS review Swarm's channel.
  final c = swarmV4Server().controller(account: 'owner');
  addTearDown(c.dispose);
  await c.refresh();
  // Faye's Browser settings, as her computer keeps them.
  final browserApp = _BrowserSettingsApp();
  addTearDown(browserApp.dispose);
  tester.view.devicePixelRatio = 1;
  // Taller than the gallery needs: each section is its own image, so the page's height is in none of them, and a
  // section that grows needs no new height.
  tester.view.physicalSize = const Size(760, 6000);
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: grid.buildAppTheme(brightness: brightness),
      // A still spinner, so the image holds one frame.
      home: MediaQuery(
        data: const MediaQueryData(disableAnimations: true),
        child: _Gallery(
          faces: faces,
          // The task board reads its project from a Swarm.
          swarm: c,
          instructions: computer.link,
          browserApp: browserApp,
        ),
      ),
    ),
  );
  // The pane's read answers after the first frame, and shows on the next.
  await tester.pump();
  await tester.pump();
  // Its folder's files start folded; AGENTS.md is opened, as a person clicks it, and CLAUDE.md stays folded.
  await tester.tap(find.byKey(const ValueKey('swarm-shared-row-0')));
  await tester.pump();
  expect(tester.takeException(), isNull);
  return [c];
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
/// differ, under the smallest Lead ring's 80, so a lost element fails too.
/// Words are left out: macOS and Linux smooth their edges too differently to
/// compare by pixel (14,638 pixels on one image), and their copy is tested
/// where they are written.
const _rest = 38;

typedef _Parts = ({List<GalleryRegion> regions, List<Rect> words});

/// Every element the gallery draws, each held to its own area, and its words,
/// held to none.
_Parts _parts(WidgetTester tester) => (
  regions: _regions(tester),
  // A glyph's smoothed edge reaches a little past its box.
  // Selectable text (the Instructions pane's files) draws its words through an editable, not a RichText.
  words: [
    for (final text in [
      ...find.byType(RichText).evaluate(),
      ...find.byType(EditableText).evaluate(),
    ])
      tester.getRect(find.byElementPredicate((e) => e == text)).inflate(2),
  ],
);

/// The [parts] inside [section], in its image's coordinates.
_Parts _within(_Parts parts, Rect section) => (
  regions: [
    for (final r in parts.regions)
      if (section.overlaps(r.rect))
        (name: r.name, rect: r.rect.shift(-section.topLeft), limit: r.limit),
  ],
  words: [
    for (final w in parts.words)
      if (section.overlaps(w)) w.shift(-section.topLeft),
  ],
);

List<GalleryRegion> _regions(WidgetTester tester) {
  final faces = find.byType(SuperTabAvatarFace);
  final avatars = find.byType(SuperTabAvatar);
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
  return n > _rest
      ? 'the image outside its words: $n pixels differ (limit $_rest)'
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

SuperTabAgent _agent(String name, {String? kind, bool offline = false}) =>
    SuperTabAgent.fromJson({
      'id': 'id-$name',
      'name': name,
      'machineId': 'm',
      'harnessId': 'h',
      'contributorId': 'p',
      'configuration': {'engine': 'claude'},
      'kind': ?kind,
      if (offline) 'downSince': '2026-11-09T05:00:00Z',
    });

final _person = SuperTabPerson.fromJson({
  'id': 'p1',
  'email': 'dee@example.com',
  'role': 'owner',
});

class _Gallery extends StatelessWidget {
  const _Gallery({
    required this.faces,
    required this.swarm,
    required this.instructions,
    required this.browserApp,
  });

  /// Where Browser settings reads Faye's.
  final AppNotifier browserApp;
  final List<String> faces;

  static const leftPane = ValueKey('gallery-left-pane');

  /// The lampOS review Swarm, whose channel the task cards read.
  final SuperTabController swarm;

  /// How the Instructions pane asks Faye's computer.
  final SwarmInstructionsLink instructions;

  /// Each section's boundary is keyed this prefix and its id, the name of its images.
  static const sectionPrefix = 'swarm-elements/';
  static ValueKey<String> section(String id) => ValueKey('$sectionPrefix$id');

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    Widget title(String text) => Padding(
      padding: const EdgeInsets.only(top: 14, bottom: 8),
      child: Text(text, style: Theme.of(context).textTheme.labelLarge),
    );
    Widget gap() => const SizedBox(width: 16);
    // Each section is its own image, with its own ground, so a pull request that changes one element changes only
    // its section's images.
    Widget section(String id, String text, List<Widget> children) =>
        RepaintBoundary(
          key: _Gallery.section(id),
          child: ColoredBox(
            color: Theme.of(context).colorScheme.surface,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(20, 0, 20, 6),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [title(text), ...children],
              ),
            ),
          ),
        );
    return Material(
      color: Theme.of(context).colorScheme.surface,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          section('faces', 'Agent face: eight colours', [
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
          section(
            'avatar-sizes',
            'Agent face, Lead ring and person at 20, 24, 30',
            [
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
            ],
          ),
          section('left-pane', 'Left pane rows', [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                SizedBox(
                  key: _Gallery.leftPane,
                  width: 280,
                  child: Column(
                    children: [
                      // The v4 left pane (anh Dee 2026-11-08): your team by face and name, then projects.
                      SuperTabQuietHeading.org('autonomous.ai', onTap: () {}),
                      SuperTabQuietHeading(
                        'Your Team',
                        collapsed: false,
                        onTap: () {},
                        onAdd: () {},
                        addTooltip: 'New agent',
                      ),
                      // A New agent going on after its form closed: first, greyed, until it runs; one that failed opens
                      // its form again.
                      const SwarmStartRow(name: 'Faye', project: false),
                      SwarmStartRow(
                        name: 'Ivy',
                        project: false,
                        failed: true,
                        onOpen: () {},
                      ),
                      for (final (name, lead, unread, selected, state) in [
                        ('River', true, false, false, null),
                        ('Quinn', false, false, true, 'on #12'),
                        ('Kai', false, true, false, 'free'),
                        ('Wren', false, false, false, 'offline'),
                        ('Moss', false, false, false, 'starting'),
                        ('Ash', false, false, false, 'working'),
                        ('Juno', false, false, false, 'needs you'),
                        ('Pip', false, false, false, 'limited until 15:40'),
                      ])
                        SuperTabQuietRow(
                          leading: SuperTabAvatar.agent(
                            _agent(
                              name,
                              kind: lead ? 'pm' : null,
                              offline: state == 'offline',
                            ),
                            size: SuperTabQuietRow.faceSize,
                            engineBadge: false,
                            lead: lead,
                          ),
                          name: name,
                          detail: state,
                          selected: selected,
                          unread: unread,
                          onTap: () {},
                        ),
                      // Your Personal Swarm only: a pane you run that is not in the Swarm yet, with its computer.
                      SuperTabQuietRow(
                        leading: SuperTabAvatar(
                          identity: 'agent:${swarmAgentId('m', 'docs')}',
                          name: 'Docs bot',
                          size: SuperTabQuietRow.faceSize,
                          face: true,
                        ),
                        name: 'Docs bot',
                        detail: 'Mac Studio',
                        onTap: () {},
                      ),
                      // While a click joins it: it waits.
                      SuperTabQuietRow(
                        leading: SuperTabAvatar(
                          identity: 'agent:${swarmAgentId('m', 'billing')}',
                          name: 'Billing fix',
                          size: SuperTabQuietRow.faceSize,
                          face: true,
                        ),
                        name: 'Billing fix',
                        detail: 'joining',
                        onTap: null,
                      ),
                      // Past the first eight: the rest, a click away.
                      SuperTabFoldRow(hidden: 32, onTap: () {}),
                      SuperTabQuietHeading(
                        'Projects',
                        collapsed: false,
                        onTap: () {},
                        onAdd: () {},
                        addTooltip: 'New project',
                      ),
                      // A New project going on after its form closed, in place of its own row.
                      const SwarmStartRow(name: 'docs-home', project: true),
                      // Open by itself: a computer is off.
                      SuperTabQuietHeading(
                        'Your Machines',
                        collapsed: false,
                        onTap: () {},
                      ),
                      SuperTabQuietRow(
                        leading: Icon(
                          AppIcons.monitorOff,
                          size: AppIcons.inlineSize,
                          color: grid.SidebarInk.inkMuted,
                        ),
                        name: 'Old Rig',
                        detail: 'offline',
                        onTap: () {},
                      ),
                      SuperTabQuietHeading(
                        'Top Teams',
                        collapsed: false,
                        onTap: () {},
                      ),
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
          section(
            'tasks',
            'Tasks: a board of the project\'s GitHub issues, read with gh; a card opens one',
            [
              SizedBox(
                width: 760,
                height: 330,
                child: SwarmTaskBoard(
                  controller: swarm,
                  conversationId: 'lead',
                  github: swarmV4GitHub(),
                  refreshEvery: null,
                  now: () => DateTime.utc(2026, 11, 9, 9),
                  onOpen: (_, _) {},
                  onClose: () {},
                ),
              ),
            ],
          ),
          // Its pull requests, what ⑂ opens (anh Dee 2026-11-10): three columns by who acts next, as lampOS's train bot sorts them.
          section(
            'pull-requests',
            'Pull requests: To read, To fix, Merging; a card opens its chat',
            [
              SizedBox(
                width: 760,
                height: 360,
                child: SwarmTaskBoard(
                  controller: swarm,
                  conversationId: 'lead',
                  github: swarmV4GitHub(),
                  pulls: true,
                  refreshEvery: null,
                  now: () => DateTime.utc(2026, 11, 9, 9),
                  onOpen: (_, _) {},
                  onClose: () {},
                ),
              ),
            ],
          ),
          // Manage › Machines (Swarm v4, 2026-11-11): the counts a person acts on, search, Add machine, quiet groups.
          section(
            'machines',
            'Machines: counts, search, Add machine, a row per computer',
            [
              SizedBox(
                width: 760,
                height: 380,
                child: SuperTabMachines(
                  controller: swarm,
                  onAddAgent: (_) {},
                  ticks: false,
                  now: () => DateTime.utc(2026, 11, 9, 9),
                ),
              ),
            ],
          ),
          section('chat', 'Chat: bubbles, a time after a pause, cards', [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                SizedBox(
                  width: 400,
                  child: Column(
                    children: [
                      _message(
                        'River',
                        'New Project is in the sidebar now.',
                        agent: _agent('River'),
                        joinsBelow: true,
                      ),
                      _message(
                        'River',
                        'Press it and name the project.',
                        agent: _agent('River'),
                        id: 'm-River-2',
                        grouped: true,
                      ),
                      SwarmChatTime(DateTime.utc(2026, 11, 7, 9, 12)),
                      _message('dee', 'Found it, thanks!', person: _person),
                      // A post to a teammate reads "Quinn to Kai", and says when the one asked is off.
                      _message(
                        'Quinn',
                        '@Kai can you read #12?',
                        agent: _agent('Quinn'),
                        id: 'm-Quinn-to',
                        to: ['Kai'],
                        note: 'Kai is offline',
                      ),
                    ],
                  ),
                ),
                gap(),
                SizedBox(
                  width: 300,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      // What GitHub said to your agent (github_row.dart).
                      const SwarmChatCard(
                        icon: AppIcons.gitPullRequest,
                        label: 'PR #4 · deehw',
                        title: 'Juno, 14:20, to Pip: READ-OK f6edb44',
                        action: 'Read',
                        details: SizedBox.shrink(),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ]),
          section(
            'message-states',
            'Message states: Sent, Typed, and why one is not typed yet',
            [
              SizedBox(
                width: 460,
                child: Column(
                  children: [
                    _ownWithState(swarm, 'Fix the login bug.', 'sent', {
                      'status': 'queued',
                    }, sentAgo: const Duration(minutes: 1)),
                    _ownWithState(swarm, 'Ship it once it is green.', 'typed', {
                      'status': 'delivered',
                    }),
                    _ownWithState(swarm, 'hi', 'working', {
                      'status': 'claimed',
                      'holdReason': 'team_waiting_idle',
                    }, sentAgo: const Duration(minutes: 3)),
                    _ownWithState(swarm, 'Which branch?', 'asks', {
                      'status': 'claimed',
                      'holdReason': 'team_waiting_user',
                    }, sentAgo: const Duration(minutes: 3)),
                  ],
                ),
              ),
            ],
          ),
          section(
            'composer',
            'Chat composer: the pill empty and typed, a thread box',
            [
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  SizedBox(width: 210, child: _pill(context, typed: false)),
                  gap(),
                  SizedBox(width: 210, child: _pill(context, typed: true)),
                  gap(),
                  const SizedBox(
                    width: 250,
                    child: _Composer('typed', 'Ship it'),
                  ),
                ],
              ),
            ],
          ),
          section(
            'back-to-chat',
            'Back to chat: where a pane took the chat\'s place',
            [SizedBox(width: 280, child: SwarmBackToChat(onBack: () {}))],
          ),
          section(
            'info',
            'Info: what the app knows of an agent, beside its chat',
            [
              SizedBox(
                width: 380,
                height: 300,
                child: SwarmAgentInfo(
                  controller: swarm,
                  agent: swarm.snapshot!.agent('first builder')!,
                  machineName: 'Mac Studio',
                  github: swarmV4GitHub(),
                  onClose: () {},
                ),
              ),
            ],
          ),
          section('browser-setup', 'Set up Browser', [
            const SizedBox(
              width: 500,
              child: BrowserSetupPrompt(ownMachine: false),
            ),
          ]),
          section(
            'browser-settings',
            'Browser settings: a proxy with a saved password',
            [
              SizedBox(
                width: 420,
                height: 420,
                child: BrowserSettingsPage(
                  app: browserApp,
                  machineId: 'm',
                  agentId: 'faye',
                  onBack: () {},
                ),
              ),
            ],
          ),
          section(
            'browser-bar',
            'Browser in an agent\'s bar, closed and open; its panel setting up, and failed',
            [
              Row(
                children: [
                  SizedBox(child: BrowserButton(open: false, onPressed: () {})),
                  gap(),
                  SizedBox(child: BrowserButton(open: true, onPressed: () {})),
                ],
              ),
              const SizedBox(height: 8),
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  for (final agent in ['faye-setup', 'faye-failed']) ...[
                    SizedBox(
                      width: 340,
                      height: 230,
                      child: BrowserPanel(
                        app: browserApp,
                        machineId: 'm',
                        agentId: agent,
                        thisComputer: true,
                        onClose: () {},
                      ),
                    ),
                    gap(),
                  ],
                ],
              ),
            ],
          ),
          // Empty means empty (anh Dee's rule 7): each element with nothing optional, and no words for what
          // is not there.
          section('empty-row', 'Empty: a row', [
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
              ],
            ),
          ]),
          section(
            'instructions',
            'Instructions: the agent\'s own file, then its folder\'s files, read only and folded',
            [
              SizedBox(
                width: 380,
                height: 500,
                child: SwarmAgentInstructions(
                  agent: _agent('Faye'),
                  machineName: 'Mac Studio',
                  onClose: () {},
                  link: instructions,
                ),
              ),
            ],
          ),
          // The one empty pane that says why (anh Dee 2026-11-09): a blank channel read as broken.
          section('empty-channel', 'Empty: a project\'s channel', [
            const SizedBox(
              width: 400,
              height: 60,
              child: SuperTabEmptyWords(superTabEmptyChannel),
            ),
          ]),
          // What GitHub said to a person's agent, in their chat with it (anh Dee 2026-11-09): a card on the left, not a bubble.
          section(
            'github-card',
            'GitHub card: what GitHub said to your agent',
            [
              SizedBox(
                width: 560,
                child: _githubCard(
                  3879,
                  'Juno, 14:20, to Pip: HOLD d0bf35b. Add the far-field test.',
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

/// Faye's computer as Browser settings and her Browser panels ask it: a SOCKS5 proxy whose password it keeps.
class _BrowserSettingsApp extends AppNotifier {
  _BrowserSettingsApp()
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
      ) {
    // Her computer, with one browser building and one whose Podman is down.
    const machine = Machine(
      machineId: 'm',
      authMode: MachineAuthMode.remote,
      name: 'Ken Mac',
    );
    machines = [machine];
    machineStates['m'] = MachineState(machine)
      ..nodeOnline = true
      ..connectionStatus = ConnectionStatus.connected
      ..agentLoadStatus = AgentLoadStatus.loaded
      ..agents = const [
        Agent(
          id: 'faye-setup',
          name: 'Faye',
          engine: 'claude',
          browser: AgentBrowser(state: 'setup', step: 'building'),
        ),
        Agent(
          id: 'faye-failed',
          name: 'Faye',
          engine: 'claude',
          browser: AgentBrowser(state: 'failed', error: 'podman_down'),
        ),
      ];
  }

  @override
  Future<BrowserSettings> agentBrowserSettings(
    String machineId,
    String agentId,
  ) async => const BrowserSettings(
    proxy: BrowserProxy(
      scheme: 'socks5',
      host: 'proxy.example',
      port: 1080,
      username: 'faye',
      passwordSet: true,
    ),
    languages: 'vi-VN, en-US',
  );
}

/// What GitHub said to a person's agent on pull request [number], as their chat with it draws it ([SuperTabGitHubRow]): its
/// words [text], relayed by their Harness.
Widget _githubCard(int number, String text) => SuperTabGitHubRow(
  message: SuperTabMessage.fromJson({
    'id': 'gh-$number',
    'conversationId': 'agent-chat-pip',
    'sequence': 0,
    'text':
        'On GitHub, deehw wrote on pull request autonomous-ai/lampOS#$number:\n$text\nhttps://github.com/autonomous-ai/lampOS/pull/$number',
    'createdAt': '2026-11-09T07:05:00Z',
    'author': {'kind': 'person', 'id': 'owner', 'name': 'Dee'},
    'source': {
      'kind': 'github',
      'event': 'comment',
      'on': 'pull',
      'repository': 'autonomous-ai/lampOS',
      'number': number,
      'url': 'https://github.com/autonomous-ai/lampOS/pull/$number',
      'login': 'deehw',
    },
  }),
);

/// A chat message row, as the chat draws one. Its time is words, which the
/// comparison leaves out, so the image holds in every time zone.
Widget _message(
  String author,
  String text, {
  SuperTabAgent? agent,
  SuperTabPerson? person,
  String? id,
  bool grouped = false,
  bool joinsBelow = false,
  List<String> to = const [],
  String? note,
}) => SuperTabMessageRow(
  grouped: grouped,
  joinsBelow: joinsBelow,
  to: to,
  message: SuperTabMessage.fromJson({
    'id': id ?? 'm-$author',
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
  receipts: [if (note != null) SuperTabPostNote(note)],
  onReturnToComposer: () {},
  readerId: 'p1',
);

/// When the gallery's message states are read.
final _statesNow = DateTime.utc(2026, 11, 11, 9, 20);

/// Your own message to `second` with the line the chat draws under its newest
/// one (message_receipt.dart): its delivery [state], sent [sentAgo] before the
/// gallery's clock.
Widget _ownWithState(
  SuperTabController swarm,
  String text,
  String id,
  Map<String, dynamic> state, {
  Duration sentAgo = Duration.zero,
}) {
  final message = SuperTabMessage.fromJson({
    'id': 'm-$id',
    'conversationId': 'lead',
    'text': text,
    'sequence': 1,
    'createdAt': _statesNow.subtract(sentAgo).toIso8601String(),
    'author': {'kind': 'person', 'id': _person.id, 'name': 'dee@example.com'},
    'deliveries': [
      {'id': 'd-$id', 'agentId': 'second', ...state},
    ],
  });
  return SuperTabMessageRow(
    message: message,
    author: 'dee',
    person: _person,
    readerId: 'p1',
    onReturnToComposer: () {},
    receipts: [
      SuperTabMessageReceipt(
        message: message,
        controller: swarm,
        onResolve: (_, _) {},
        onAddLead: () {},
        machineName: (_) => 'Mac Studio',
        now: () => _statesNow,
      ),
    ],
  );
}

/// The chat's composer as it draws itself: the pill around the paperclip and
/// the text, the mic beside it while empty, send once [typed].
Widget _pill(BuildContext context, {required bool typed}) => Row(
  crossAxisAlignment: CrossAxisAlignment.end,
  children: [
    Expanded(
      child: SwarmComposerPill(
        child: SizedBox(
          height: grid.AppControl.heightFieldScaled,
          child: Row(
            children: [
              const SizedBox(width: 10),
              Icon(AppIcons.paperclip, size: 16, color: DesktopChrome.muted),
              const SizedBox(width: 10),
              Text(
                typed ? 'Ship it' : 'Message #Pilot',
                style: SwarmType.composer(
                  context,
                  color: typed ? null : DesktopChrome.hint,
                ),
              ),
            ],
          ),
        ),
      ),
    ),
    const SizedBox(width: 8),
    SizedBox(
      height: grid.AppControl.heightFieldScaled,
      child: Center(
        child: typed
            ? SwarmSendButton(tooltip: 'Send', onPressed: () {})
            : Icon(AppIcons.mic, size: 16, color: DesktopChrome.muted),
      ),
    ),
  ],
);

/// A thread's reply box ([SuperTabReplyBox]) holding
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
