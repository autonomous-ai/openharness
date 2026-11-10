import 'dart:io';
import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
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
import 'package:harness/super_tabs/buddy_rows.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/task_board.dart';
import 'package:harness/super_tabs/avatar_art.dart';
import 'package:harness/super_tabs/identity.dart';
import 'package:harness/super_tabs/message_row.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/super_tabs/personal_agents.dart';
import 'package:harness/super_tabs/reply_box.dart';
import 'package:harness/terminal/terminal_typography.dart';

import 'support/swarm_v4_data.dart';
import 'support/super_tab_fixture.dart';

/// The Swarm elements gallery (desktop-design-system.md, Swarm elements): every
/// element drawn in light and dark against its checked-in image. A new or
/// changed element updates the doc and this gallery in the same pull request.
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
    testWidgets('every Swarm element matches its image in ${brightness.name}', (
      tester,
    ) async {
      final bars = await _show(tester, brightness);
      (goldenFileComparator as _NearlyComparator).parts = _parts(tester);
      await expectLater(
        find.byKey(_Gallery.boundary),
        matchesGoldenFile('goldens/swarm-elements-${brightness.name}.png'),
      );
      await _close(tester, bars);
    });
  }

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
    // The heading's +: its glyph's box ends on the same edge.
    final plus = find.descendant(
      of: find.byKey(_Gallery.leftPane),
      matching: find.byIcon(AppIcons.plus),
    );
    expect(plus, findsOneWidget);
    expect(tester.getRect(plus).right, moreOrLessEquals(rights.single));
    await _close(tester, bars);
  });

  // Review of task #4461: a whole-image tolerance let a changed element pass. Ellis has Kai's colour with another
  // tilt: only its eyes and smile move.
  testWidgets('one changed face fails the gallery', (tester) async {
    final bars = await _show(
      tester,
      Brightness.light,
      faces: ['Ellis', ..._faces.skip(1)],
    );
    final boundary = tester.renderObject<RenderRepaintBoundary>(
      find.byKey(_Gallery.boundary),
    );
    final problem = await tester.runAsync(() async {
      final image = await boundary.toImage();
      final png = await image.toByteData(format: ui.ImageByteFormat.png);
      image.dispose();
      return galleryDifference(
        png!.buffer.asUint8List(),
        File('test/goldens/swarm-elements-light.png').readAsBytesSync(),
        _parts(tester),
      );
    });
    expect(problem, contains('agent face Ellis'));
    await _close(tester, bars);
  });
}

Future<List<SuperTabController>> _show(
  WidgetTester tester,
  Brightness brightness, {
  List<String> faces = _faces,
}) async {
  final old = grid.AppTheme.brightness.value;
  grid.AppTheme.brightness.value = brightness;
  addTearDown(() => grid.AppTheme.brightness.value = old);
  // The task cards read the lampOS review Swarm's channel.
  final c = swarmV4Server().controller(account: 'owner');
  addTearDown(c.dispose);
  await c.refresh();
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = const Size(760, 1950);
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
          // The decision cards read their answers' state from a reader's Decisions.
          swarm: c,
        ),
      ),
    ),
  );
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
/// is drawn alike on every host: at most 0.01% of the image (38 pixels) may
/// differ, under the smallest Lead ring's 80, so a lost element fails too. Words
/// are left out: macOS and Linux smooth their edges too differently to compare
/// by pixel (14,638 pixels on one image), and their copy is tested where they
/// are written.
const _rest = .0001;

/// Every element the gallery draws, each held to its own area, and its words,
/// held to none.
({List<GalleryRegion> regions, List<Rect> words}) _parts(WidgetTester tester) =>
    (
      regions: _regions(tester),
      // A glyph's smoothed edge reaches a little past its box.
      words: [
        for (final text in find.byType(RichText).evaluate())
          tester.getRect(find.byElementPredicate((e) => e == text)).inflate(2),
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
  final limit = a.width * a.height * _rest;
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
  const _Gallery(this.brightness, {required this.faces, required this.swarm});
  final Brightness brightness;
  final List<String> faces;

  static const leftPane = ValueKey('gallery-left-pane');

  /// The lampOS review Swarm, whose channel the task cards read.
  final SuperTabController swarm;
  static const boundary = ValueKey('swarm-elements-gallery');

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    Widget title(String text) => Padding(
      padding: const EdgeInsets.only(top: 14, bottom: 8),
      child: Text(text, style: Theme.of(context).textTheme.labelLarge),
    );
    Widget gap() => const SizedBox(width: 16);
    return RepaintBoundary(
      key: boundary,
      child: Material(
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
              title('Left pane rows'),
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
                        for (final (name, lead, unread, selected, state) in [
                          ('River', true, false, false, null),
                          ('Quinn', false, false, true, 'on #12'),
                          ('Kai', false, true, false, 'free'),
                          ('Wren', false, false, false, 'offline'),
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
              title(
                'Tasks: a board of the project\'s GitHub issues, read with gh; a card opens one',
              ),
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
              title('Chat: bubbles, a time after a pause, cards'),
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
                      ],
                    ),
                  ),
                  gap(),
                  SizedBox(
                    width: 300,
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const SwarmChatCard(
                          icon: AppIcons.send,
                          label: 'Sent to River',
                          title: 'Every task opens as a thread',
                          action: 'View brief',
                          details: SizedBox.shrink(),
                        ),
                        const SizedBox(height: 8),
                        const SwarmChatCard(
                          icon: AppIcons.circleCheck,
                          label: 'Shipped',
                          title: 'Wake fix: the mic closes after 1 second',
                          action: 'What changed',
                          details: SizedBox.shrink(),
                        ),
                        const SizedBox(height: 8),
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
              title('Chat composer: the pill empty and typed, a thread box'),
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
              // Empty means empty (anh Dee's rule 7): each element with nothing optional, and no words for what
              // is not there.
              title('Empty: a row'),
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
            ],
          ),
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
  String? id,
  bool grouped = false,
  bool joinsBelow = false,
}) => SuperTabMessageRow(
  grouped: grouped,
  joinsBelow: joinsBelow,
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
  receipts: const [],
  onReturnToComposer: () {},
  readerId: 'p1',
);

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
