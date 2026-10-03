import { Download, Terminal } from "lucide-react";
import styles from "./page.module.css";
import { DESKTOP_DOWNLOAD_URL, DESKTOP_INSTALL_COMMAND } from "@/lib/installCommand";

export default function DesktopPage() {
  return (
    <main className={styles.wrap}>
      <section className={styles.card}>
        <div className={styles.badge}>
          <Download size={21} strokeWidth={2} />
        </div>
        <p className={styles.eyebrow}>Harness for macOS and Linux</p>
        <h1 className={styles.title}>Install the Harness desktop app</h1>
        <p className={styles.description}>
          Download the app for macOS, then drag Harness into your Applications folder.
        </p>
        <a className={styles.download} href={DESKTOP_DOWNLOAD_URL}>
          <Download size={18} aria-hidden="true" />
          Download for macOS
        </a>
        <p className={styles.note}>
          Signed and notarized by Apple, so it opens without a security warning. Requires macOS 12 or later.
        </p>
        <p className={styles.description}>
          On Linux, or installing from a terminal? Run this instead — it reads the same release manifest, verifies the download, installs it, and opens Harness.
        </p>
        <div className={styles.command}>
          <Terminal size={18} aria-hidden="true" />
          <code>{DESKTOP_INSTALL_COMMAND}</code>
        </div>
        <p className={styles.note}>
          macOS and Linux (Ubuntu). On macOS, both methods install Harness into Applications; on Linux,
          the script installs under your home folder. Harness keeps itself up to date, and neither method
          replaces a copy that is still running.
        </p>
        <a className={styles.link} href="/desktop/install.sh">
          View installer script
        </a>
      </section>
    </main>
  );
}
