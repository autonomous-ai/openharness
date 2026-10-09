import { Download, Terminal } from "lucide-react";
import styles from "./page.module.css";
import { DesktopDownload } from "./DesktopDownload";
import { DESKTOP_INSTALL_COMMAND, INSTALL_COMMAND } from "@/lib/installCommand";

export default function DesktopPage() {
  return (
    <main className={styles.wrap}>
      <section className={styles.card}>
        <div className={styles.badge}>
          <Download size={21} strokeWidth={2} />
        </div>
        <p className={styles.eyebrow}>Harness for macOS and Linux</p>
        <h1 className={styles.title}>Install the Harness desktop app</h1>
        <DesktopDownload />
        <p className={styles.description}>
          Installing from a terminal? Run this instead — it downloads the latest release for this computer, verifies it, installs it, and opens Harness.
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
        {/* The phone's "Send to my computer" lands here for every computer, a server with no desktop included. */}
        <hr className={styles.divider} />
        <p className={styles.description}>
          Only need the command line, on a server or a computer with no desktop? Install Harness for your terminal:
        </p>
        <div className={styles.command}>
          <Terminal size={18} aria-hidden="true" />
          <code>{INSTALL_COMMAND}</code>
        </div>
        <p className={styles.note}>
          macOS and Linux. Then sign in with <code>harness login</code> and start it with <code>harness start</code>.
        </p>
      </section>
    </main>
  );
}
