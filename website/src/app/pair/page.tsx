import { Smartphone } from "lucide-react";
import styles from "./page.module.css";

/**
 * Where the desktop app's "Add phone" QR lands when it is scanned with the Camera app rather than
 * from inside Harness on the phone. The QR is `https://harness.autonomous.ai/pair#e=…&m=…&c=…`:
 * everything after the `#` is a one-time pairing code and an account, and a browser never sends the
 * fragment to this server. This page must never read it either — no script touches
 * `location.hash` — it only says where the code is meant to be scanned.
 */
export default function PairPage() {
  return (
    <main className={styles.wrap}>
      <section className={styles.card}>
        <div className={styles.badge}>
          <Smartphone size={20} strokeWidth={2} />
        </div>
        <h1 className={styles.title}>Scan this from the Harness app</h1>
        <p className={styles.sub}>
          Open Harness on your iPhone, tap <strong>Yes — scan to connect</strong>, and point it at the code on
          your Mac.
        </p>
        <p className={styles.note}>
          The code only works from the app: it pairs your phone with your computer, end-to-end encrypted.
          This page does not read it.
        </p>
      </section>
    </main>
  );
}
