import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { fetchDeviceRelease } from "@/lib/deviceRelease";
import { DeviceDownload } from "./DeviceDownload";
import { DeviceFiles } from "./DeviceFiles";
import styles from "./page.module.css";

const geist = Geist({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-geist" });
const geistMono = Geist_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-geist-mono" });

export const metadata: Metadata = { title: "Harness Device", description: "Set up and use your Harness Device." };

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#111111" },
  ],
};

const PRODUCT_PAGE = "https://www.autonomous.ai/harness-device";
const SUPPORT = "human@autonomous.ai";

function Dial({ className }: { className?: string }) {
  return (
    <>
      <img className={[className, styles.lt].filter(Boolean).join(" ")} src="/device/dial.png" alt="" width={540} height={335} />
      <img className={[className, styles.dk].filter(Boolean).join(" ")} src="/device/dial-dark.png" alt="" width={540} height={335} />
    </>
  );
}

function Face() {
  return (
    <div className={styles.face}>
      <img src="/device/face.webp" alt="" width={12720} height={202} />
    </div>
  );
}

const APPS = [
  { icon: "claude", name: "Claude", what: "Claude Code" },
  { icon: "chatgpt", name: "ChatGPT", what: "Codex" },
  { icon: "vscode", name: "VS Code", what: "Terminal, Claude Code panel" },
  { icon: "cursor", name: "Cursor", what: "Terminal, Claude Code panel, Cursor agent" },
];

const TERMINALS_WITH_ICON = [
  { icon: "orca", name: "Orca" },
  { icon: "herdr", name: "herdr" },
  { icon: "terminal", name: "Terminal" },
];

const TERMINALS = ["Ghostty", "iTerm2", "tmux", "cmux", "Warp", "WezTerm", "OpenCode"];

/** harness.autonomous.ai/device: the Harness Device guide. Its downloads and notes come from the live release manifest. */
export default async function DevicePage() {
  const release = await fetchDeviceRelease();

  return (
    <div className={[styles.page, geist.variable, geistMono.variable].join(" ")}>
      <header className={styles.top}>
        <div className={styles.wrap}>
          <a className={styles.brand} href="/device">
            <img src="/device/icon.png" alt="" width={32} height={32} />
            Harness Device
          </a>
          <nav>
            <a className={styles.hideSm} href="#setup">Set up</a>
            <a className={styles.hideSm} href="#use">Use it</a>
            <a className={styles.hideSm} href="#help">Help</a>
            <a href={PRODUCT_PAGE}>Product page ↗</a>
          </nav>
        </div>
      </header>

      <main>
        <section className={styles.hero}>
          <div className={styles.wrap}>
            <div>
              <p className={styles.eyebrow}>Quick start</p>
              <h1>
                Plug it in.<span>Start talking.</span>
              </h1>
              <p className={styles.lead}>Three steps. The app sets up the rest.</p>
              <DeviceDownload builds={release?.builds ?? []} version={release?.version ?? null} />
            </div>
            <div className={styles.dial} aria-hidden="true">
              <Dial />
              <Face />
            </div>
          </div>
        </section>

        <section className={styles.block} id="setup">
          <div className={styles.wrap}>
            <div className={styles.head}>
              <h2>Set up.</h2>
              <p>About two minutes, once per computer.</p>
            </div>
            <ol className={styles.steps}>
              <li className={styles.step}>
                <div className={styles.vis} aria-hidden="true">
                  <div className={styles.mbar}>
                    <span>Fri 9:41</span>
                    <span className={styles.tray}>
                      <img src="/device/menubar.svg" alt="" width={36} height={36} />
                    </span>
                  </div>
                  <div className={styles.menu}>
                    <div className={styles.dim}>Plug in your device</div>
                    <div className={styles.hi}>Sign in…</div>
                    <hr />
                    <div>Export logs</div>
                    <div>About</div>
                    <div>Quit</div>
                  </div>
                </div>
                <div className={styles.body}>
                  <div className={styles.n}>01</div>
                  <h3>Get the app.</h3>
                  <p>Download Harness Device, drag it to Applications and open it. It runs in your menu bar.</p>
                  <p>
                    Choose <b>Sign in…</b> once.
                  </p>
                </div>
              </li>
              <li className={styles.step}>
                <div className={styles.vis} aria-hidden="true">
                  <div className={styles.plug}>
                    <span className={styles.cable} />
                    <span className={styles.usb}>USB-C</span>
                    <span className={styles.led} />
                    <Dial className={styles.d} />
                  </div>
                  <div className={styles.badge}>
                    <span className={styles.dot} />
                    Device ready
                  </div>
                </div>
                <div className={styles.body}>
                  <div className={styles.n}>02</div>
                  <h3>Plug in.</h3>
                  <p>
                    Connect the device to your computer with the USB-C cable. The menu says <b>Device ready</b>.
                  </p>
                </div>
              </li>
              <li className={styles.step}>
                <div className={styles.vis} aria-hidden="true">
                  <div className={styles.mini}>
                    <Dial />
                    <Face />
                  </div>
                  <div className={styles.agents}>
                    <span className={styles.pill}>
                      <i style={{ background: "#c96a2e" }} />
                      Claude Code
                    </span>
                    <span className={styles.pill}>
                      <i style={{ background: "#3d63dd" }} />
                      Codex
                    </span>
                  </div>
                </div>
                <div className={styles.body}>
                  <div className={styles.n}>03</div>
                  <h3>Open your agents.</h3>
                  <p>Claude Code and Codex appear on the device. Nothing to set up.</p>
                </div>
              </li>
            </ol>
          </div>
        </section>

        <section className={styles.block} id="use">
          <div className={styles.wrap}>
            <div className={styles.head}>
              <h2>Use it.</h2>
              <p>The whole face is the button.</p>
            </div>
            <div className={styles.moves}>
              <div className={styles.move}>
                <svg viewBox="0 0 36 36" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                  <circle cx="18" cy="21" r="4" />
                  <circle cx="18" cy="21" r="9" strokeDasharray="2 4" />
                  <path d="M18 3v4M7 7l3 3M29 7l-3 3" />
                </svg>
                <h3>Tap. Talk.</h3>
                <p>
                  Say the next task.<span className={styles.q}>“Why is the login test failing?”</span>
                </p>
              </div>
              <div className={styles.move}>
                <svg viewBox="0 0 36 36" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true">
                  <path d="M31 5 4 16l11 4 4 11L31 5z" />
                  <path d="m15 20 7-7" />
                </svg>
                <h3>Send.</h3>
                <p>Tap again.</p>
              </div>
              <div className={styles.move}>
                <svg viewBox="0 0 36 36" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M4 18h28M10 12l-6 6 6 6M26 12l6 6-6 6" />
                </svg>
                <h3>Swipe.</h3>
                <p>Next agent. On your Mac too.</p>
              </div>
              <div className={styles.move}>
                <svg viewBox="0 0 36 36" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M18 4v28M12 10l6-6 6 6M12 26l6 6 6-6" />
                </svg>
                <h3>Scroll.</h3>
                <p>Drag up or down to read back.</p>
              </div>
              <div className={styles.move}>
                <svg viewBox="0 0 36 36" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <circle cx="18" cy="18" r="5" fill="currentColor" />
                  <circle cx="18" cy="18" r="10" />
                  <circle cx="18" cy="18" r="15" strokeDasharray="3 4" />
                </svg>
                <h3>Hold.</h3>
                <p>Switch apps.</p>
              </div>
            </div>
          </div>
        </section>

        <section className={styles.block} id="apps">
          <div className={styles.wrap}>
            <div className={styles.head}>
              <h2>Works with.</h2>
              <p>Claude Code and Codex, in the apps you already use.</p>
            </div>
            <div className={styles.apps}>
              {APPS.map((app) => (
                <div className={styles.app} key={app.icon}>
                  <img src={`/device/apps/${app.icon}.png`} alt="" width={44} height={44} />
                  <div className={styles.n}>{app.name}</div>
                  <div className={styles.m}>{app.what}</div>
                </div>
              ))}
            </div>
            <div className={styles.term}>
              <p className={styles.label}>Terminals</p>
              <div className={styles.chips}>
                {TERMINALS_WITH_ICON.map((term) => (
                  <span className={styles.chip} key={term.icon}>
                    <img src={`/device/apps/${term.icon}.png`} alt="" width={20} height={20} />
                    {term.name}
                  </span>
                ))}
                {TERMINALS.map((name) => (
                  <span className={styles.chip} key={name}>
                    {name}
                  </span>
                ))}
                <span className={[styles.chip, styles.more].join(" ")}>More joining</span>
              </div>
            </div>
            <p className={styles.auto}>
              The app adds the <b>Claude Code plugin</b>, the <b>VS Code and Cursor extension</b> and the <b>Orca plugin</b> for
              you. Agents run as you already set them up.
            </p>
          </div>
        </section>

        <section className={styles.block} id="new">
          <div className={styles.wrap}>
            <div className={styles.head}>
              <h2>What&apos;s new.</h2>
              <p>The app and the device update themselves.</p>
            </div>
            <div className={release ? styles.news : [styles.news, styles.single].join(" ")}>
              {release && (
                <div className={styles.panel}>
                  <h3>Version {release.version}</h3>
                  <p className={styles.sub}>{release.date}</p>
                  {release.notes.length > 0 && (
                    <ul>
                      {/* By position: two notes can read the same once their pull request numbers are gone. */}
                      {release.notes.map((note, i) => (
                        <li key={i}>{note}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              <div className={styles.panel}>
                <h3>Downloads</h3>
                <p className={styles.sub}>{release ? `Version ${release.version}` : ""}</p>
                <DeviceFiles builds={release?.builds ?? []} />
              </div>
            </div>
          </div>
        </section>

        <section className={styles.block} id="help">
          <div className={styles.wrap}>
            <div className={styles.head}>
              <h2>Need help?</h2>
              <p>Most answers are in the menu-bar icon.</p>
            </div>
            <div className={styles.faq}>
              <details open>
                <summary>The menu says “Plug in your device”.</summary>
                <div className={styles.a}>
                  <p>
                    Use the cable that came in the box, or another USB-C cable that carries data. Plug it straight into your
                    computer, not a charger or hub.
                  </p>
                </div>
              </details>
              <details>
                <summary>An agent is missing on the device.</summary>
                <div className={styles.a}>
                  <p>Start Claude Code or Codex in one of the apps above. It shows up on its own.</p>
                  <p>Hold the face to switch to the app it runs in.</p>
                </div>
              </details>
              <details>
                <summary>More than one computer?</summary>
                <div className={styles.a}>
                  <p>Install the app and sign in on each one. The device shows the agents of every computer you sign in on.</p>
                </div>
              </details>
              <details>
                <summary>Something else is wrong.</summary>
                <div className={styles.a}>
                  <p>
                    Click the menu-bar icon, choose <span className={styles.kbd}>Export logs</span>, and send the file to{" "}
                    <a href={`mailto:${SUPPORT}`}>{SUPPORT}</a>.
                  </p>
                </div>
              </details>
            </div>
          </div>
        </section>
      </main>

      <footer>
        <div className={styles.wrap}>
          <span>© Autonomous</span>
          <span>
            <a href={PRODUCT_PAGE}>Product page</a> · <a href={`mailto:${SUPPORT}`}>{SUPPORT}</a>
          </span>
        </div>
      </footer>
    </div>
  );
}
