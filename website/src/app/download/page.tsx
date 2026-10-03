"use client";

// The root is a separate Flutter app; workspace links need a full document navigation.

import { useEffect, useRef, useState } from "react";
import styles from "./page.module.css";
import {
  DESKTOP_DOWNLOAD_LINUX_ARM64_URL,
  DESKTOP_DOWNLOAD_LINUX_X64_URL,
  DESKTOP_DOWNLOAD_URL,
  INSTALL_COMMAND,
} from "@/lib/installCommand";

const commands = [
  { id: "install", label: "1. Install", value: INSTALL_COMMAND },
  { id: "login", label: "2. Sign in", value: "harness login" },
  { id: "start", label: "3. Start", value: "harness start" },
] as const;

const downloads = [
  { name: "macOS", detail: "Apple silicon + Intel", href: DESKTOP_DOWNLOAD_URL },
  { name: "Linux (x64)", detail: "AppImage", href: DESKTOP_DOWNLOAD_LINUX_X64_URL },
  { name: "Linux (ARM64)", detail: "AppImage", href: DESKTOP_DOWNLOAD_LINUX_ARM64_URL },
];

type CommandId = (typeof commands)[number]["id"];

/** Public /download page. The root route serves the shared Flutter workspace. */
export default function Page() {
  const [copied, setCopied] = useState<CommandId | null>(null);
  const [copyError, setCopyError] = useState(false);
  const reset = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (reset.current) clearTimeout(reset.current);
  }, []);

  const copy = async (id: CommandId, command: string) => {
    if (reset.current) clearTimeout(reset.current);
    setCopied(null);
    setCopyError(false);
    try {
      if (!navigator.clipboard) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(command);
      setCopied(id);
      reset.current = setTimeout(() => setCopied(null), 2000);
    } catch {
      setCopyError(true);
    }
  };

  return (
    <div className={styles.page}>
      <header className={styles.bar}>
        <nav className={styles.navigation} aria-label="Harness">
          <a className={styles.brand} href="/">Harness</a>
          <span className={styles.activeTab} aria-current="page">Downloads</span>
        </nav>
        <a className={styles.textAction} href="/">[ Open web app ]</a>
      </header>

      <main className={styles.main}>
        <div className={styles.intro}>
          <h1>Download Harness</h1>
          <p>Your agents, wherever you work.</p>
        </div>

        <div className={styles.workspace}>
          <section className={styles.section} aria-labelledby="desktop-heading">
            <header className={styles.sectionHeader}>
              <span className={styles.sectionNumber} aria-hidden="true">01</span>
              <h2 id="desktop-heading">Download the desktop app</h2>
            </header>
            <div className={styles.sectionBody}>
              <p className={styles.description}>One workspace for all your agents and machines.</p>
              <div className={styles.downloads}>
                {downloads.map(({ name, detail, href }) => (
                  <a className={styles.download} href={href} key={href}>
                    <span className={styles.platform}>{name}</span>
                    <span className={styles.platformDetail}>{detail}</span>
                    <span className={styles.downloadAction}>[ Download ]</span>
                  </a>
                ))}
              </div>
              <p className={styles.note}>
                Signed and notarized on macOS.<br />
                The app keeps itself up to date.
              </p>
            </div>
          </section>

          <section className={styles.section} aria-labelledby="cli-heading">
            <header className={styles.sectionHeader}>
              <span className={styles.sectionNumber} aria-hidden="true">02</span>
              <h2 id="cli-heading">Install the CLI</h2>
            </header>
            <div className={styles.sectionBody}>
              <p className={styles.description}>For your terminal. macOS and Linux.</p>
              <ol className={styles.commands}>
                {commands.map(({ id, label, value }) => (
                  <li className={styles.command} key={id}>
                    <div className={styles.commandHeader}>
                      <span>{label}</span>
                      <button
                        type="button"
                        className={styles.copy}
                        aria-label={`Copy ${label.toLowerCase()}`}
                        onClick={() => void copy(id, value)}
                      >
                        {copied === id ? "[ Copied ]" : "[ Copy ]"}
                      </button>
                    </div>
                    <code className={styles.commandValue} title={value}>{value}</code>
                  </li>
                ))}
              </ol>
              <p className={styles.note} role="status" aria-live="polite">
                {copyError
                  ? "Couldn't copy. Select the command and copy it manually."
                  : copied
                    ? "Command copied. Paste it into your terminal."
                    : "Sign-in opens your browser."}
              </p>
            </div>
          </section>
        </div>

        <footer className={styles.footer}>
          Same agents. Same workspace. Desktop, terminal, or web.
        </footer>
      </main>
    </div>
  );
}
