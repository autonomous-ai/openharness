import Image from "next/image";
import {
  ArrowDown,
  ArrowRight,
  ArrowUpRight,
  Search,
  Plus,
  Check,
  CornerUpLeft,
  Mic,
  MoveHorizontal,
  Target,
  Repeat2,
} from "lucide-react";
import ExperienceDemo from "./ExperienceDemo";
import s from "./page.module.css";

const companions = [
  { id: "tim", name: "Tim", kind: "A little curiosity." },
  { id: "lynx", name: "Lynx", kind: "A watchful friend." },
  { id: "tux", name: "Tux", kind: "Quietly dependable." },
  { id: "gopher", name: "Gopher", kind: "Always exploring." },
];

export default function ProLanding() {
  return (
    <div className={s.page}>
      <a className={s.skipLink} href="#main-content">
        Skip to content
      </a>
      <header className={s.navShell}>
        <nav className={s.nav} aria-label="Primary navigation">
          <a className={s.brand} href="/" aria-label="Harness home">
            <Image
              unoptimized
              src="/pro/harness-mark.svg"
              alt=""
              width={26}
              height={26}
            />
            <span>
              harness<span className={s.brandDot}>.</span>
            </span>
            <span className={s.navProduct}>Pro</span>
          </a>
          <div className={s.navLinks}>
            <a href="#experience">Experience</a>
            <a href="#companions">Companions</a>
            <a href="#design">Design</a>
          </div>
          <a className={s.navCta} href="/desktop">
            Get Harness <ArrowUpRight size={14} />
          </a>
        </nav>
      </header>
      <main id="main-content">
        <section className={s.hero} aria-labelledby="hero-title">
          <p className={s.productName}>Harness Pro</p>
          <h1 id="hero-title">
            Your whole team.
            <br />
            <span>Within reach.</span>
          </h1>
          <p className={s.heroDescription}>
            A new touch for the work you direct.
          </p>
          <a className={s.heroExplore} href="#experience">
            Explore Pro <ArrowDown size={17} />
          </a>
          <div className={s.heroVisual}>
            <span className={s.heroHalo} aria-hidden="true" />
            <Image
              unoptimized
              className={s.heroDevice}
              src="/pro/harness-pro-hero.webp"
              alt="Harness Pro: a warm white square device with a quiet touch interface and Tim the octopus"
              width={1320}
              height={1020}
              fetchPriority="high"
              loading="eager"
            />
          </div>
          <p className={s.renderNote}>Final enclosure. Proposed interface.</p>
        </section>

        <section className={s.introduction} aria-labelledby="intro-title">
          <p className={s.eyebrow}>AN INPUT DEVICE FOR THE AGE OF AGENTS</p>
          <h2 id="intro-title">
            You set the direction.
            <br />
            <span>The work moves forward.</span>
          </h2>
          <p>
            Speak an idea. Find your place. Make the call that matters.
            <br className={s.desktopBreak} /> All from one small surface beside
            your computer.
          </p>
          <div
            className={s.engineNames}
            aria-label="Works with agents in Harness"
          >
            {[
              "Claude Code",
              "Codex",
              "Grok Build",
              "Pi",
              "Hermes",
              "OpenCode",
            ].map((name) => (
              <span key={name}>{name}</span>
            ))}
          </div>
        </section>

        <section
          id="experience"
          className={`${s.chapter} ${s.voiceChapter}`}
          aria-labelledby="voice-title"
        >
          <div className={s.chapterHeading}>
            <p className={s.eyebrow}>
              <Mic size={16} /> VOICE
            </p>
            <h2 id="voice-title">Say what’s next.</h2>
            <p>
              Tap. Speak. Send.
              <br />A little direction goes a long way.
            </p>
          </div>
          <div className={s.wideDemo}>
            <ExperienceDemo product />
          </div>
          <div className={s.chapterAside}>
            <span>01</span>
            <p>
              Your voice goes to the selected agent. Review your words whenever
              you want.
            </p>
          </div>
        </section>

        <section
          id="navigation"
          className={`${s.chapter} ${s.navigationChapter}`}
          aria-labelledby="navigation-title"
        >
          <div className={s.chapterHeading}>
            <p className={s.eyebrow}>
              <MoveHorizontal size={16} /> NAVIGATION
            </p>
            <h2 id="navigation-title">
              Know where you are.
              <br />
              <span>Go where you need.</span>
            </h2>
            <p>
              Your workspace, in the palm-sized view.
              <br />
              Move between agents. Swipe between workspaces. Scroll through the
              work.
            </p>
          </div>
          <div className={s.wideDemo}>
            <ExperienceDemo product scenario="map" />
          </div>
          <div className={s.utilityGrid}>
            <article>
              <Search size={24} strokeWidth={1.5} />
              <h3>Find the thought.</h3>
              <p>Find your work by voice. Pick up where you left off.</p>
              <div className={s.searchIllustration} aria-hidden="true">
                <Search size={17} />
                <span>“The checkout work”</span>
                <span>↵</span>
              </div>
            </article>
            <article>
              <Plus size={24} strokeWidth={1.5} />
              <h3>Start something new.</h3>
              <p>
                Choose an agent. Give it a direction. Make room for a new idea.
              </p>
              <div className={s.agentIllustration} aria-hidden="true">
                <span>✳ Claude</span>
                <span>⌘ Codex</span>
                <span>+ Your next idea</span>
              </div>
            </article>
          </div>
        </section>

        <section
          id="decisions"
          className={`${s.chapter} ${s.decisionChapter}`}
          aria-labelledby="decision-title"
        >
          <div className={s.splitChapter}>
            <div className={s.splitCopy}>
              <p className={s.eyebrow}>DECISIONS</p>
              <h2 id="decision-title">
                The important part
                <br />
                <span>is still you.</span>
              </h2>
              <p>
                Questions come to you in one place.
                <br />
                Make a choice. Let the right agent carry on.
              </p>
              <div className={s.quietProof}>
                <Check size={19} />
                <span>Keep your place on the monitor.</span>
              </div>
            </div>
            <div className={s.singleDemo}>
              <ExperienceDemo
                product
                scenario="attention"
                presentation="device"
              />
            </div>
          </div>
        </section>

        <section
          id="carry"
          className={`${s.chapter} ${s.carryChapter}`}
          aria-labelledby="carry-title"
        >
          <div className={s.chapterHeading}>
            <p className={s.eyebrow}>CARRY</p>
            <h2 id="carry-title">
              Good ideas
              <br />
              <span>travel well.</span>
            </h2>
            <p>
              Take the useful part from one agent.
              <br />
              Give it to the next, with the context that matters.
            </p>
          </div>
          <div className={s.carryTrail} aria-hidden="true">
            <span>Research</span>
            <span className={s.trailLine} />
            <span className={s.passage}>A useful thought.</span>
            <ArrowRight size={18} />
            <span>Build</span>
          </div>
          <div className={s.wideDemo}>
            <ExperienceDemo product scenario="carry" />
          </div>
          <div className={s.chapterAside}>
            <span>02</span>
            <p>
              The passage and your direction stay together. Check the recipient,
              review, then send.
            </p>
          </div>
        </section>

        <section
          id="return"
          className={`${s.chapter} ${s.returnChapter}`}
          aria-labelledby="return-title"
        >
          <div className={s.chapterHeading}>
            <p className={s.eyebrow}>
              <CornerUpLeft size={17} /> RETURN
            </p>
            <h2 id="return-title">
              Follow a thought.
              <br />
              <span>Find your way back.</span>
            </h2>
            <p>
              Open a result on the big screen.
              <br />
              One touch brings you back to your work and reading position.
            </p>
          </div>
          <div className={s.wideDemo}>
            <ExperienceDemo product scenario="return" />
          </div>
        </section>

        <section
          id="direction"
          className={`${s.chapter} ${s.directionChapter}`}
          aria-labelledby="direction-title"
        >
          <div className={s.chapterHeading}>
            <p className={s.eyebrow}>A LITTLE MORE AMBITION</p>
            <h2 id="direction-title">
              A task. A goal.
              <br />
              <span>A new routine.</span>
            </h2>
            <p>
              Give a quick instruction, describe an outcome,
              <br />
              or ask for work that repeats.
            </p>
          </div>
          <div className={s.directionGrid}>
            <article className={s.goalCard}>
              <div className={s.directionCopy}>
                <Target size={25} strokeWidth={1.5} />
                <h3>Give it a goal.</h3>
                <p>An outcome to work toward.</p>
              </div>
              <ExperienceDemo product scenario="goal" presentation="device" />
              <p className={s.compatibility}>
                Goal requests · Claude Code and Codex
              </p>
            </article>
            <article className={s.loopCard}>
              <div className={s.directionCopy}>
                <Repeat2 size={25} strokeWidth={1.5} />
                <h3>Make it a routine.</h3>
                <p>A task and an interval, in your words.</p>
              </div>
              <ExperienceDemo product scenario="loop" presentation="device" />
              <p className={s.compatibility}>Loop requests · Claude Code</p>
            </article>
          </div>
          <p className={s.sectionNote}>
            Review before sending. Requests are shown here; a confirmed schedule
            or completed goal is not.
          </p>
        </section>

        <section
          id="today"
          className={`${s.chapter} ${s.todayChapter}`}
          aria-labelledby="today-title"
        >
          <div className={s.splitChapter}>
            <div className={s.splitCopy}>
              <p className={s.eyebrow}>TODAY</p>
              <h2 id="today-title">
                A little perspective.
                <br />
                <span>On your day.</span>
              </h2>
              <p>
                A local usage estimate, when you want it.
                <br />
                The computer, the sources, and what’s included—clear at a
                glance.
              </p>
              <p className={s.smallPrint}>
                Uses your opted-in sources in Harness. Estimates can be partial.
              </p>
            </div>
            <div className={s.singleDemo}>
              <ExperienceDemo product scenario="usage" presentation="device" />
            </div>
          </div>
        </section>

        <section
          id="companions"
          className={`${s.chapter} ${s.companionChapter}`}
          aria-labelledby="companion-title"
        >
          <div className={s.chapterHeading}>
            <p className={s.eyebrow}>A LITTLE COMPANY</p>
            <h2 id="companion-title">
              A familiar face.
              <br />
              <span>A useful signal.</span>
            </h2>
            <p>
              A little personality beside your work.
              <br />
              Choose the companion that feels like yours.
            </p>
          </div>
          <div className={s.companionLineup}>
            {companions.map((c) => (
              <figure key={c.id}>
                <Image
                  unoptimized
                  src={`/pro/${c.id}_adult_idle_0.png`}
                  alt={`${c.name}, a Harness companion`}
                  width={332}
                  height={324}
                  loading="lazy"
                />
                <figcaption>
                  <strong>{c.name}</strong>
                  <span>{c.kind}</span>
                </figcaption>
              </figure>
            ))}
          </div>
          <div className={s.moodGrid}>
            {[
              ["work", "Working", "A gentle movement."],
              ["need", "Needs you", "A moment for your attention."],
              ["done", "Finished", "A little celebration."],
              ["nap", "Quiet", "Space to concentrate."],
            ].map(([id, name, copy]) => (
              <article key={id}>
                <Image
                  unoptimized
                  src={`/pro/tim_adult_${id}_0.png`}
                  alt={`Tim ${name.toLowerCase()}`}
                  width={160}
                  height={156}
                  loading="lazy"
                />
                <h3>{name}</h3>
                <p>{copy}</p>
              </article>
            ))}
          </div>
        </section>

        <section
          id="design"
          className={`${s.chapter} ${s.designChapter}`}
          aria-labelledby="design-title"
        >
          <div className={s.chapterHeading}>
            <p className={s.eyebrow}>THE DEVICE</p>
            <h2 id="design-title">
              Small,
              <br />
              <span>by design.</span>
            </h2>
            <p>
              A square touch display. A considered angle.
              <br />A quiet place on your desk.
            </p>
          </div>
          <div className={s.hardwareGallery}>
            <figure className={s.rearView}>
              <Image
                unoptimized
                src="/pro/harness-pro-rear.webp"
                alt="Rear view of the final Harness Pro enclosure, showing its grille and USB-C opening"
                width={1320}
                height={1020}
                loading="lazy"
              />
              <figcaption>One cable. Power and connection.</figcaption>
            </figure>
            <figure className={s.sideView}>
              <span className={s.angleNumber} aria-hidden="true">
                15°
              </span>
              <Image
                unoptimized
                src="/pro/harness-pro-side.webp"
                alt="The final Harness Pro enclosure’s 15-degree desk angle"
                width={1200}
                height={440}
                loading="lazy"
              />
              <figcaption>A different angle on your work.</figcaption>
            </figure>
          </div>
          <dl className={s.specs}>
            <div>
              <dt>Touch display</dt>
              <dd>720 × 720</dd>
            </div>
            <div>
              <dt>Footprint</dt>
              <dd>87 × 83 mm</dd>
            </div>
            <div>
              <dt>Height</dt>
              <dd>26 mm</dd>
            </div>
            <div>
              <dt>Power + connection</dt>
              <dd>USB-C</dd>
            </div>
          </dl>
          <p className={s.sectionNote}>
            Dimensions rounded from the final CAD. USB power required. Finish
            shown is illustrative.
          </p>
        </section>

        <section className={s.closing} aria-labelledby="closing-title">
          <Image
            unoptimized
            src="/pro/tim_adult_idle_0.png"
            alt=""
            width={132}
            height={129}
            loading="lazy"
          />
          <p className={s.eyebrow}>HARNESS PRO</p>
          <h2 id="closing-title">
            Less between you
            <br />
            <span>and what’s next.</span>
          </h2>
          <a className={s.primaryLink} href="/desktop">
            Start with Harness <ArrowUpRight size={17} />
          </a>
          <p>
            Pro is in development.
            <br />
            Harness Desktop is available today.
          </p>
        </section>

        <section className={s.essentials} aria-label="Good to know">
          <article>
            <h3>The preview</h3>
            <p>
              Every example uses sample voice and app data. No microphone is
              recorded and no real agent receives a command.
            </p>
          </article>
          <article>
            <h3>The connection</h3>
            <p>
              Pro connects over USB. Voice uses a backend speech service and
              needs a network connection.
            </p>
          </article>
          <article>
            <h3>What’s next</h3>
            <p>
              The experience is in development. Final integration and device
              trials are ongoing. Pricing and availability are not announced.
            </p>
          </article>
        </section>
      </main>
      <footer className={s.footer}>
        <a className={s.brand} href="/">
          harness<span className={s.brandDot}>.</span>
        </a>
        <span>By Autonomous</span>
        <div>
          <a
            href="https://github.com/autonomous-ai/openharness"
            target="_blank"
            rel="noreferrer"
          >
            Open source <ArrowUpRight size={12} />
          </a>
          <a href="/desktop">Get the app</a>
          <a href="#main-content">Back to top ↑</a>
        </div>
      </footer>
    </div>
  );
}
