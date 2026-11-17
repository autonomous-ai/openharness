import { Download } from "lucide-react";
import styles from "@/app/desktop/page.module.css";

export default function DevicePage() {
  return (
    <main className={styles.wrap}>
      <section className={styles.card}>
        <div className={styles.badge}>
          <Download size={21} strokeWidth={2} />
        </div>
        <h1 className={styles.title}>Harness</h1>
        <p className={styles.description}>The menu-bar app for the dial. macOS 13 or later.</p>
        <a className={styles.download} href="/device/download-macos">
          <Download size={18} aria-hidden="true" />
          Download
        </a>
      </section>
    </main>
  );
}
