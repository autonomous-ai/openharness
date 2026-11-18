// The demo's story, as devices/harness-max/firmware/main/demo/max_demo.c tells it: one computer, three apps, nine agents,
// the turns they play and when, and the app in front. What a person says to an agent is the mockup's (diego-1tap.html
// SAY), each line with the turn it starts. Plain data: demo_link.dart plays it.
import '../model/types.dart';

/// The computer the cable is on.
const String kComputer = 'MacBook Pro';

/// An app the agents run in, by hostDetect.ts's id and name, and what the bar may do with its agents (services/devices.ts):
/// s show, v talk to, f bring forward, a answer.
class DemoApp {
  const DemoApp(this.id, this.name, this.caps);
  final String id, name, caps;
}

/// In the order the daemon lists them.
const List<DemoApp> kApps = [
  DemoApp('orca', 'Orca', 'sv'),
  DemoApp('harness', 'Harness', 'svfa'),
  DemoApp('vscode', 'VS Code', 's'),
];
const int kOrca = 0, kHarness = 1, kVsCode = 2;

const List<String> kEngines = ['claude', 'codex'];

enum BeatKind { start, act, step, ask, done, fail }

/// One beat of a turn, played [wait] tenths of a second after the one before it.
class Beat {
  const Beat._(this.kind, this.wait,
      {this.text = '', this.sentence = '', this.timer = false, this.question, this.tier = SummaryTier.alert, this.recap = ''});

  /// The turn starts: its status line.
  const Beat.start(int wait, String status) : this._(BeatKind.start, wait, text: status);

  /// The spinner word, and the progress sentence when there is one.
  const Beat.act(int wait, String verb, [String sentence = '']) : this._(BeatKind.act, wait, text: verb, sentence: sentence);

  /// The spinner word with the turn's clock (the footer's timer).
  const Beat.timer(int wait, String verb) : this._(BeatKind.act, wait, text: verb, timer: true);

  /// One tool card: "Edit · session.ts".
  const Beat.step(int wait, String step) : this._(BeatKind.step, wait, text: step);

  /// The agent asks, and waits for the answer: the turn goes on with that answer's beats.
  const Beat.ask(int wait, Question question) : this._(BeatKind.ask, wait, question: question);

  /// The turn ends with its summary: [recap] the headline, [text] what it says.
  const Beat.done(int wait, SummaryTier tier, String recap, String text)
      : this._(BeatKind.done, wait, tier: tier, recap: recap, text: text);

  /// The turn fails: why.
  const Beat.fail(int wait, String message) : this._(BeatKind.fail, wait, text: message);

  final BeatKind kind;
  final int wait;
  final String text, sentence, recap;
  final bool timer;
  final Question? question;
  final SummaryTier tier;
}

/// A question with its options; each answer goes on with its own beats. A permission prompt is drawn as Allow / Deny.
/// An agent the bar may not answer asks it shown-only, and its app answers it with the first option.
class Question {
  const Question(this.q, this.options, this.next, {this.permission = false});
  final String q;
  final List<String> options;
  final List<List<Beat>> next;
  final bool permission;
}

// max_demo.c's turns. Its turn.stats beats have no input on the bar: their waits are folded into the beat after them.

/// Orca's auth-refactor: the session lookup out of the middleware, with spinner words and steps under them.
const List<Beat> authSplit = [
  Beat.start(0, 'Working…'),
  Beat.act(10, 'Planning', 'Splitting the auth middleware: the session lookup moves out of the request handler.'),
  Beat.step(10, 'Read · middleware.ts'),
  Beat.step(15, 'Read · session.ts'),
  Beat.act(20, 'Editing', 'Moving the session lookup into its own module, with the cache beside it.'),
  Beat.step(10, 'Edit · session.ts'),
  Beat.step(20, 'Edit · middleware.ts'),
  Beat.step(20, 'Bash · npm test -- auth'),
  Beat.timer(30, 'Running tests'),
  Beat.timer(30, 'Running tests'),
  Beat.done(20, SummaryTier.list, 'Session lookup split out of the auth middleware',
      'The session lookup lives in session.ts now and the middleware only calls it. 64/64 tests pass.'),
];

/// ...and later, small work nobody needs to hear about.
const List<Beat> authFollow = [
  Beat.start(0, 'Working…'),
  Beat.act(10, 'Cleaning up', 'Removing the old session helpers nothing calls any more.'),
  Beat.step(10, 'Edit · legacySession.ts'),
  Beat.step(15, 'Bash · npm test -- auth'),
  Beat.timer(20, 'Running tests'),
  Beat.done(15, SummaryTier.silent, 'Removed the unused session helpers',
      'Three helpers nothing called are gone. 64/64 tests pass.'),
];

const List<Beat> _heroImage = [
  Beat.act(5, 'Editing', 'Swapping the hero video for the new image, with a blurred placeholder while it loads.'),
  Beat.step(10, 'Edit · Hero.tsx'),
  Beat.step(15, 'Bash · npm run build'),
  Beat.timer(20, 'Building'),
  Beat.done(15, SummaryTier.list, 'Hero uses the new image',
      'The landing hero shows the new image; the video is gone and the page is 2 MB lighter.'),
];

/// Orca's landing-hero asks what only Orca can answer: the bar shows it, and says where.
const List<Beat> heroAsk = [Beat.start(0, 'Working…'), ..._heroAskWork];
const List<Beat> _heroAskWork = [
  Beat.act(10, 'Reading', "Looking at the landing page's hero section."),
  Beat.step(10, 'Read · Hero.tsx'),
  Beat.step(15, 'Bash · ls public/hero'),
  Beat.act(15, 'Thinking', 'There is a new hero image in the design folder. Before I swap it in: image or video?'),
  Beat.ask(20, Question('Use the new image in the hero, or keep the video?', ['Use the image'], [_heroImage])),
];

/// Orca's flaky-e2e: a flake found and fixed, said out loud.
const List<Beat> e2eFix = [
  Beat.start(0, 'Working…'),
  Beat.act(10, 'Reproducing', 'Running the checkout test 20 times to catch the flake.'),
  Beat.step(10, 'Bash · npx playwright test checkout --repeat-each 20'),
  Beat.timer(30, 'Running tests'),
  Beat.timer(30, 'Running tests'),
  Beat.act(20, 'Thinking', "It fails when the cart request beats the page's hydration: the test clicks too early."),
  Beat.step(15, 'Edit · checkout.spec.ts'),
  Beat.step(15, 'Bash · npx playwright test checkout --repeat-each 50'),
  Beat.timer(30, 'Running tests'),
  Beat.done(30, SummaryTier.alert, 'Checkout e2e is stable: 50/50 runs pass',
      'The checkout test waited too little for the page. It now waits for the cart, and 50 runs in a row pass.'),
];

/// Orca's rate-limiter: a test run that fails, then the fix.
const List<Beat> rateLimit = [Beat.start(0, 'Working…'), ..._rateLimitWork];
const List<Beat> _rateLimitWork = [
  Beat.act(10, 'Reading', 'Adding a sliding-window limit to the public API.'),
  Beat.step(10, 'Read · limiter.ts'),
  Beat.step(15, 'Edit · limiter.ts'),
  Beat.step(15, 'Bash · npm test'),
  Beat.timer(25, 'Running tests'),
  Beat.fail(30, 'npm test failed: 3 rate-limit tests time out'),
];
const List<Beat> rateFix = [
  Beat.start(0, 'Working…'),
  Beat.act(10, 'Fixing', 'The tests wait on the real clock; moving them to fake timers.'),
  Beat.step(10, 'Edit · limiter.test.ts'),
  Beat.step(10, 'Bash · npm test'),
  Beat.timer(20, 'Running tests'),
  Beat.done(15, SummaryTier.list, 'Rate limiter in; its tests on fake timers',
      'The public API allows 60 requests a minute per token. The three slow tests use fake timers. 112/112 pass.'),
];

const List<Beat> _cliBump = [
  Beat.act(5, 'Editing', 'Bumping the cable protocol to 4 and gating the app list on it.'),
  Beat.step(10, 'Edit · cableSession.ts'),
  Beat.step(15, 'Bash · npm test -- cable'),
  Beat.timer(20, 'Running tests'),
  Beat.done(15, SummaryTier.alert, 'Cable protocol bumped to 4',
      'The daemon speaks proto 4 and sends the app list only to dials that say it. 412/412 tests pass.'),
];
const List<Beat> _cliKeep = [
  Beat.act(5, 'Editing', 'Keeping proto 3 and adding appFilter to the hello.'),
  Beat.step(10, 'Edit · cableSession.ts'),
  Beat.step(15, 'Bash · npm test -- cable'),
  Beat.timer(20, 'Running tests'),
  Beat.done(15, SummaryTier.alert, 'The app list rides on proto 3',
      'The protocol stays at 3: a dial that says appFilter gets the app list, others nothing new. 410/410 tests pass.'),
];

/// Harness's harness-cli asks what the bar answers.
const List<Beat> cliProto = [Beat.start(0, 'Working…'), ..._cliProtoWork];
const List<Beat> _cliProtoWork = [
  Beat.act(10, 'Reading', "Reading the cable session and the dial's hello for the new app list."),
  Beat.step(10, 'Read · cableSession.ts'),
  Beat.step(15, 'Read · cable.md'),
  Beat.act(15, 'Thinking', 'The app list is a new frame. Old dials ignore frames they do not know.'),
  Beat.ask(15,
      Question('Bump the cable protocol to 4, or keep 3 and add a field?', ['Bump to 4', 'Keep 3'], [_cliBump, _cliKeep])),
];

const List<Beat> _fwDone = [
  Beat.act(5, 'Flashing', 'Writing the new image to the Max.'),
  Beat.step(5, 'Bash · idf.py -p /dev/ttyACM0 flash'),
  Beat.timer(25, 'Flashing'),
  Beat.done(20, SummaryTier.alert, 'The Max is flashed with the app picker',
      'The new firmware is on the Max and it booted into the agents page. Hold a face to pick an app.'),
];
const List<Beat> _fwStop = [
  Beat.done(5, SummaryTier.list, 'Stopped before flashing',
      "You declined the flash, so the Max still runs yesterday's image. The build is ready."),
];

/// Harness's firmware-max needs a person's yes to flash the bar: the permission prompt.
const List<Beat> fwFlash = [Beat.start(0, 'Working…'), ..._fwFlashWork];
const List<Beat> _fwFlashWork = [
  Beat.act(10, 'Building', 'Building the Max firmware with the new app picker.'),
  Beat.step(10, 'Bash · idf.py build'),
  Beat.timer(25, 'Building'),
  Beat.timer(25, 'Building'),
  Beat.act(15, 'Ready to flash', 'Built. Flashing the Max needs your yes.'),
  Beat.ask(5,
      Question('Bash: idf.py -p /dev/ttyACM0 flash', ['Allow', 'Deny'], [_fwDone, _fwStop], permission: true)),
];

/// Harness's docs finishes quietly.
const List<Beat> docsPage = [
  Beat.start(0, 'Working…'),
  Beat.act(10, 'Writing', 'Documenting the apps frame and app.pick on the cable page.'),
  Beat.step(10, 'Edit · cable.md'),
  Beat.step(20, 'Edit · dial-app-filter.md'),
  Beat.timer(20, 'Writing'),
  Beat.done(15, SummaryTier.list, 'Cable docs cover apps and app.pick',
      "The cable page documents the apps frame, app.pick and the hello's appFilter."),
];

/// A New Harness agent's first turn.
const List<Beat> setUp = [
  Beat.start(0, 'Working…'),
  Beat.act(10, 'Reading the project', 'Reading the README and the scripts to get my bearings.'),
  Beat.step(10, 'Read · README.md'),
  Beat.step(15, 'Bash · npm install'),
  Beat.timer(20, 'Installing'),
  Beat.done(15, SummaryTier.list, 'Set up and ready',
      'Read the project and installed its dependencies. Tell me what to work on.'),
];

/// One of the agents the story is about, and what it did last (the history a ring restores).
class Cast {
  const Cast(this.id, this.name, this.engine, this.app, this.recap, this.text);
  final String id, name, engine, recap, text;
  final int app;
}

/// In the daemon's list order.
const List<Cast> kCast = [
  Cast('ag-auth', 'auth-refactor', 'claude', kOrca, 'Sign-in posts to the new auth API',
      'The sign-in form posts to /v2/auth and keeps the session in a cookie. 61/61 tests pass.'),
  Cast('ag-hero', 'landing-hero', 'codex', kOrca, 'Landing copy matches the new pricing',
      "The landing page's headline and plan cards say the new prices."),
  Cast('ag-e2e', 'flaky-e2e', 'claude', kOrca, 'Two flaky e2e tests found',
      'Search and checkout fail about one run in ten. Both are on the list to fix.'),
  Cast('ag-rate', 'rate-limiter', 'codex', kOrca, "Read the API's request path",
      'Every public route goes through one handler, so a limit there covers them all.'),
  Cast('ag-sweep', 'docs-sweep', 'muse', kOrca, 'Fixed 12 broken links in the docs',
      'Twelve links pointed at pages that moved; they point at the new ones.'),
  Cast('ag-fw', 'firmware-max', 'claude', kHarness, 'The Max boots to the agents page',
      'The Max skips the splash and opens on the agents page in 2.1 s.'),
  Cast('ag-cli', 'harness-cli', 'claude', kHarness, "harness status names each agent's app",
      'harness status shows which app each agent runs in, from the host detection.'),
  Cast('ag-docs', 'docs', 'muse', kHarness, 'Getting started covers the Max',
      'The getting-started guide has a page for the Max: plugging it in and what it shows.'),
  Cast('ag-api', 'api-client', 'claude', kVsCode, 'API client regenerated from the spec',
      'The typed client matches the OpenAPI spec again, with the two new billing routes.'),
];
const int _auth = 0, _hero = 1, _e2e = 2, _rate = 3, _fw = 5, _cli = 6, _docs = 7;

/// When each turn starts, in story milliseconds, and whose it is (an index into [kCast]).
const List<({int at, int agent, List<Beat> turn})> kStory = [
  (at: 1000, agent: _auth, turn: authSplit),
  (at: 3000, agent: _hero, turn: heroAsk),
  (at: 6000, agent: _e2e, turn: e2eFix),
  (at: 24000, agent: _rate, turn: rateLimit),
  (at: 48000, agent: _rate, turn: rateFix),
  (at: 72000, agent: _cli, turn: cliProto),
  (at: 75000, agent: _fw, turn: fwFlash),
  (at: 80000, agent: _docs, turn: docsPage),
  (at: 135000, agent: _auth, turn: authFollow),
];

/// The app in front on the computer: the person works in Orca, moves to Harness for the protocol and the flash, and
/// comes back.
const List<({int at, int app})> kFront = [(at: 0, app: kOrca), (at: 70000, app: kHarness), (at: 130000, app: kOrca)];

/// One telling of the story.
const int kCycleMs = 160000;

/// What a person says to an agent, and what the agent then does with it. When the agent's open question takes words,
/// the line answers it instead, with [option].
class Spoken {
  const Spoken(this.said, this.work, {this.option = 0});
  final String said;
  final List<Beat> work;
  final int option;

  /// The turn the words start: the line is its status.
  List<Beat> get turn => [Beat.start(0, said), ...work];
}

/// The mockup's SAY lines for the cast, by agent name.
const Map<String, Spoken> kSay = {
  'auth-refactor': Spoken('Also cover the expired token case with a test', [
    Beat.act(10, 'Reading', 'Looking at what session.ts does with a token that has expired.'),
    Beat.step(10, 'Read · session.test.ts'),
    Beat.act(15, 'Editing', 'Adding a test where the token expires mid-request.'),
    Beat.step(10, 'Edit · session.test.ts'),
    Beat.step(15, 'Bash · npm test -- auth'),
    Beat.timer(20, 'Running tests'),
    Beat.done(15, SummaryTier.alert, 'Expired tokens are covered by a test',
        'A new test lets the token expire mid-request: the session refreshes once and the request goes through. '
            '65/65 tests pass.'),
  ]),
  'flaky-e2e': Spoken('Great, now run it fifty more times on CI', [
    Beat.act(10, 'Pushing', 'Starting 50 runs of the checkout test on CI.'),
    Beat.step(10, 'Bash · gh workflow run e2e.yml -f repeat=50'),
    Beat.timer(30, 'Waiting for CI'),
    Beat.timer(30, 'Waiting for CI'),
    Beat.done(15, SummaryTier.alert, 'Checkout passes 50 more runs on CI',
        'CI ran the checkout test 50 more times and every run passed. The flake is gone.'),
  ]),
  'rate-limiter': Spoken('Start with the login route only', [
    Beat.act(10, 'Editing', 'Limiting POST /login first; the other routes wait.'),
    Beat.step(10, 'Edit · limiter.ts'),
    Beat.step(15, 'Edit · routes/login.ts'),
    Beat.step(10, 'Bash · npm test -- limiter'),
    Beat.timer(20, 'Running tests'),
    Beat.done(15, SummaryTier.alert, 'Only the login route is limited',
        'POST /login allows 10 tries a minute per address; the other routes are not limited yet. 112/112 tests pass.'),
  ]),
  'docs-sweep': Spoken('Sweep the setup docs for dead links', [
    Beat.act(10, 'Checking links', 'Following every link in the setup docs.'),
    Beat.step(10, 'Bash · npx check-links docs/setup'),
    Beat.timer(20, 'Checking links'),
    Beat.step(15, 'Edit · docs/setup/install.md'),
    Beat.done(15, SummaryTier.alert, 'The setup docs have no dead links',
        'Three links in the setup docs pointed at pages that moved; they point at the new ones.'),
  ]),
  'firmware-max': Spoken('Flash it when the build is green', [
    Beat.act(10, 'Building', 'Building the Max firmware before flashing it.'),
    Beat.step(10, 'Bash · idf.py build'),
    Beat.timer(25, 'Building'),
    Beat.step(10, 'Bash · idf.py -p /dev/ttyACM0 flash'),
    Beat.timer(25, 'Flashing'),
    Beat.done(15, SummaryTier.alert, 'Built green and flashed',
        'The build passed, so the new firmware is on the Max, and it booted into the agents page.'),
  ]),
  // Said while harness-cli asks its protocol question, it is the answer: Keep 3.
  'harness-cli': Spoken('Keep three and add the field', _cliKeep, option: 1),
  'docs': Spoken('Add a picture of the menu-bar app', [
    Beat.act(10, 'Capturing', 'Taking a picture of the menu-bar app with its Devices menu open.'),
    Beat.step(10, 'Bash · screencapture -o menu-bar.png'),
    Beat.step(15, 'Edit · getting-started/max.md'),
    Beat.timer(15, 'Writing'),
    Beat.done(15, SummaryTier.alert, 'The Max page shows the menu-bar app',
        'The getting-started page for the Max has a picture of the menu-bar app, with its Devices menu open.'),
  ]),
};

/// The mockup's line for an agent with none of its own.
const Spoken kSayElse = Spoken('Run the suite again before you push', [
  Beat.act(10, 'Testing', 'Running the whole suite before anything is pushed.'),
  Beat.step(10, 'Bash · npm test'),
  Beat.timer(30, 'Running tests'),
  Beat.timer(30, 'Running tests'),
  Beat.done(15, SummaryTier.alert, 'The whole suite passes',
      'Ran the whole suite again and every test passes. Nothing is pushed yet: say when.'),
]);

/// The demo a person drives (DemoLink.manual): the agents whose words, every other time, start their case instead of
/// their [kSay] line (first the case, then the line, then the case again), so each case can be played again.
const Map<String, Spoken> kCase = {
  // A test run that fails: Attention in the failure's red.
  'rate-limiter': Spoken('Add a sliding-window limit to the public API', _rateLimitWork),
  // A question only Orca can answer: the bar shows it, and says where.
  'landing-hero': Spoken('Freshen up the landing hero', _heroAskWork),
  // The permission prompt: Allow / Deny.
  'firmware-max': Spoken('Build the firmware with the app picker', _fwFlashWork),
  // A question the bar answers, by a tap or by words.
  'harness-cli': Spoken('Put the app list on the cable', _cliProtoWork),
};

/// New Harness: the projects a new agent is started on, in turn (max_demo.c PROJECTS). Its agents run in Harness.
const List<String> kProjects = ['harness-web', 'harness-cli', 'infra'];
