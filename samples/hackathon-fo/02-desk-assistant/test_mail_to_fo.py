"""Unit tests for mail_to_fo.py: the mail-to-text step and the state file. Run: python3 -m unittest -v"""
import json
import os
import tempfile
import unittest
from email.mime.application import MIMEApplication
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

import mail_to_fo as m


def multipart(plain=None, html=None, attachment=None, subject="Hello", sender="a@example.com"):
    msg = MIMEMultipart("mixed")
    alt = MIMEMultipart("alternative")
    if plain is not None:
        alt.attach(MIMEText(plain, "plain", "utf-8"))
    if html is not None:
        alt.attach(MIMEText(html, "html", "utf-8"))
    msg.attach(alt)
    if attachment is not None:
        part = MIMEApplication(attachment, Name="cv.pdf")
        part["Content-Disposition"] = 'attachment; filename="cv.pdf"'
        msg.attach(part)
    msg["Subject"] = subject
    msg["From"] = sender
    return msg.as_bytes()


class MailToText(unittest.TestCase):
    def test_prefers_plain_part(self):
        raw = multipart(plain="Plain words.", html="<p>HTML words.</p>")
        self.assertEqual(m.mail_summary(raw)["body"], "Plain words.")

    def test_html_only_is_stripped(self):
        raw = multipart(html="<html><head><title>T</title><style>p{color:red}</style></head>"
                             "<body><script>alert(1)</script><p>Hi &amp; welcome,</p>"
                             "<p>see <b>you</b>\n   soon</p></body></html>")
        body = m.mail_summary(raw)["body"]
        self.assertEqual(body, "Hi & welcome,\n\nsee you soon")
        for leftover in ("<", ">", "color:red", "alert", "T\n"):
            self.assertNotIn(leftover, body)

    def test_html_line_breaks(self):
        self.assertEqual(m.html_to_text("Line one<br>Line two<br/>Line three"), "Line one\nLine two\nLine three")

    def test_attachment_skipped(self):
        raw = multipart(plain="See attached.", attachment=b"%PDF-1.4 binary")
        self.assertEqual(m.mail_summary(raw)["body"], "See attached.")

    def test_rfc2047_headers_decoded(self):
        raw = (b"From: =?UTF-8?B?Wm/DqyBNw7xsbGVy?= <zoe@example.com>\r\n"
               b"Subject: =?UTF-8?Q?Interview_invitation_=E2=80=93_next_steps?=\r\n"
               b"Content-Type: text/plain; charset=utf-8\r\n\r\nBody\r\n")
        summary = m.mail_summary(raw)
        self.assertEqual(summary["from"], "Zoë Müller <zoe@example.com>")
        self.assertEqual(summary["subject"], "Interview invitation – next steps")

    def test_non_utf8_charset(self):
        raw = "Subject: x\r\nContent-Type: text/plain; charset=iso-8859-1\r\n\r\ncaf\xe9\r\n".encode("latin-1")
        self.assertEqual(m.mail_summary(raw)["body"], "café")

    def test_body_cut_to_limit(self):
        raw = multipart(plain="word " * 1000)
        body = m.mail_summary(raw)["body"]
        self.assertLessEqual(len(body), m.BODY_LIMIT)
        self.assertTrue(body.endswith("…"))
        short = m.mail_summary(multipart(plain="short"))["body"]
        self.assertEqual(short, "short")

    def test_text_has_instruction_and_fields(self):
        text = m.mail_to_text(multipart(plain="Interview on Monday.", subject="Interview", sender="HR <hr@co.example>"))
        self.assertTrue(text.startswith(m.INSTRUCTION))
        self.assertIn("From: HR <hr@co.example>", text)
        self.assertIn("Subject: Interview", text)
        self.assertIn("GLANCE applied=", text)
        self.assertTrue(text.rstrip().endswith("Interview on Monday."))

    def test_missing_subject_and_empty_body(self):
        raw = b"From: a@example.com\r\nContent-Type: text/plain\r\n\r\n"
        text = m.mail_to_text(raw)
        self.assertIn("Subject: (no subject)", text)
        self.assertIn("(empty body)", text)

    def test_sample_email(self):
        with open(os.path.join(os.path.dirname(__file__), "sample.eml"), "rb") as f:
            summary = m.mail_summary(f.read())
        self.assertEqual(summary["subject"], "Interview invitation – Frontend Engineer")
        self.assertIn("Monday, Oct 20 at 10:00 AM", summary["body"])
        self.assertNotIn("color:red", summary["body"])


class State(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.dir.name, "state.json")

    def tearDown(self):
        self.dir.cleanup()

    def test_missing_or_broken_file_is_empty(self):
        self.assertEqual(m.load_state(self.path), {"agents": {}, "folders": {}})
        with open(self.path, "w") as f:
            f.write("{not json")
        self.assertEqual(m.load_state(self.path), {"agents": {}, "folders": {}})

    def test_round_trip_keeps_agent_and_uids(self):
        state = m.load_state(self.path)
        state["agents"]["fo"] = "cloud_abc"
        entry = m.folder_state(state, "INBOX", "42")
        m.mark_handled(entry, "7")
        m.mark_handled(entry, "7")
        m.save_state(self.path, state)
        again = m.load_state(self.path)
        self.assertEqual(again["agents"], {"fo": "cloud_abc"})
        self.assertTrue(m.is_handled(m.folder_state(again, "INBOX", "42"), "7"))
        self.assertEqual(again["folders"]["INBOX"]["handled"], ["7"])
        self.assertFalse(os.path.exists(self.path + ".tmp"))

    def test_state_holds_no_mail(self):
        state = m.load_state(self.path)
        m.mark_handled(m.folder_state(state, "INBOX", "1"), "9")
        m.save_state(self.path, state)
        with open(self.path) as f:
            self.assertEqual(set(json.load(f)), {"agents", "folders"})

    def test_uidvalidity_change_forgets_uids(self):
        state = m.load_state(self.path)
        m.mark_handled(m.folder_state(state, "INBOX", "1"), "5")
        self.assertFalse(m.is_handled(m.folder_state(state, "INBOX", "2"), "5"))

    def test_handled_list_is_bounded(self):
        state = m.load_state(self.path)
        entry = m.folder_state(state, "INBOX", "1")
        for uid in range(m.UID_MEMORY + 10):
            m.mark_handled(entry, str(uid))
        self.assertEqual(len(entry["handled"]), m.UID_MEMORY)
        self.assertTrue(m.is_handled(entry, str(m.UID_MEMORY + 9)))
        self.assertFalse(m.is_handled(entry, "0"))


class FakeImap:
    """Enough of imaplib.IMAP4_SSL for poll_once: one folder, messages by UID, flags recorded."""

    def __init__(self, messages, unseen):
        self.messages, self.unseen, self.stored, self.readonly = messages, unseen, [], None

    def __call__(self, host, ssl_context=None):
        return self

    def login(self, user, password):
        return "OK", [b"ok"]

    def select(self, folder, readonly=False):
        self.readonly = readonly
        return "OK", [str(len(self.messages)).encode()]

    def response(self, code):
        return code, [b"777"]

    def uid(self, command, *args):
        if command == "search":
            return "OK", [" ".join(self.unseen).encode()]
        if command == "fetch":
            return "OK", [(b"1 (BODY[] {n}", self.messages[args[0]]), b")"]
        if command == "store":
            self.stored.append(args[0])
            return "OK", []

    def logout(self):
        pass


class FakeDaemon:
    def __init__(self, port):
        pass

    def close(self):
        pass


class Poll(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.dir.name, "state.json")
        self.sent = []
        self.saved = (m.imaplib.IMAP4_SSL, m.Daemon, m.deliver)
        m.Daemon = FakeDaemon
        m.deliver = lambda daemon, state, path, engine, text: self.sent.append(text)

    def tearDown(self):
        m.imaplib.IMAP4_SSL, m.Daemon, m.deliver = self.saved
        self.dir.cleanup()

    def run_poll(self, imap, mark_read=False):
        m.imaplib.IMAP4_SSL = imap
        config = {"IMAP_HOST": "imap.example", "IMAP_USER": "u", "IMAP_APP_PASSWORD": "p", "IMAP_FOLDER": "INBOX"}
        state = m.load_state(self.path)
        return m.poll_once(config, state, self.path, "fo", 1, mark_read)

    def test_new_mail_sent_once_and_left_unread(self):
        imap = FakeImap({"5": multipart(plain="one", subject="A"), "6": multipart(plain="two", subject="B")}, ["5", "6"])
        self.assertEqual(self.run_poll(imap), 2)
        self.assertEqual(len(self.sent), 2)
        self.assertTrue(imap.readonly)
        self.assertEqual(imap.stored, [])
        self.assertEqual(self.run_poll(imap), 0)
        self.assertEqual(len(self.sent), 2)
        self.assertEqual(m.load_state(self.path)["folders"]["INBOX"], {"uidvalidity": "777", "handled": ["5", "6"]})

    def test_mark_read(self):
        imap = FakeImap({"5": multipart(plain="one")}, ["5"])
        self.run_poll(imap, mark_read=True)
        self.assertFalse(imap.readonly)
        self.assertEqual(imap.stored, ["5"])


class Env(unittest.TestCase):
    def test_parses_quotes_and_comments(self):
        with tempfile.NamedTemporaryFile("w", suffix=".env", delete=False) as f:
            f.write("# comment\nIMAP_HOST=imap.gmail.com\nIMAP_APP_PASSWORD=\"abcd efgh ijkl mnop\"\n\nPOLL_SECONDS=30\n")
        try:
            values = m.load_env(f.name)
        finally:
            os.unlink(f.name)
        self.assertEqual(values["IMAP_HOST"], "imap.gmail.com")
        self.assertEqual(values["IMAP_APP_PASSWORD"], "abcd efgh ijkl mnop")
        self.assertEqual(values["POLL_SECONDS"], "30")


if __name__ == "__main__":
    unittest.main()
