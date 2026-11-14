//! The app's rules: a pure reducer from an event to the effects it asks for.

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{
        Action, ClaudeStatus, DialStatus, Effect, Event, LoginEvent, MenuAction, MenuItem, Phase, Saved, Screen, View,
    };

    /// Second 0 of a minute.
    const B: u64 = 1794556800;

    /// A CLI seen before and a login item registered: only what each test does is saved.
    const SEEN: Saved = Saved { version: 1, cli_seen: true, asked_sign_in: false, asked_claude: false, login_item: true };

    fn found() -> App {
        App::new(SEEN, true, false, B).0
    }

    /// No CLI, never seen.
    fn fresh() -> App {
        App::new(Saved { login_item: true, ..Saved::default() }, false, false, B).0
    }

    fn removed() -> App {
        App::new(SEEN, false, false, B).0
    }

    fn has(effects: &[Effect], effect: &Effect) -> bool {
        effects.contains(effect)
    }

    fn count(effects: &[Effect], effect: &Effect) -> usize {
        effects.iter().filter(|each| *each == effect).count()
    }

    /// The labels of the last menu sent.
    fn rows(effects: &[Effect]) -> Vec<String> {
        let items = effects
            .iter()
            .rev()
            .find_map(|effect| match effect {
                Effect::Menu(items) => Some(items),
                _ => None,
            })
            .expect("a menu");
        items
            .iter()
            .filter_map(|item| match item {
                MenuItem::Text(label) | MenuItem::Action(_, label) => Some(label.clone()),
                MenuItem::Separator => None,
            })
            .collect()
    }

    /// What the window was told to show, in order.
    fn shows(effects: &[Effect]) -> Vec<Option<View>> {
        effects
            .iter()
            .filter_map(|effect| match effect {
                Effect::Show(view) => Some(view.clone()),
                _ => None,
            })
            .collect()
    }

    /// The log lines that are not the menu.
    fn logs(effects: &[Effect]) -> Vec<String> {
        effects
            .iter()
            .filter_map(|effect| match effect {
                Effect::Log(line) if !line.starts_with("menu: ") => Some(line.clone()),
                _ => None,
            })
            .collect()
    }

    fn shown(screen: Screen, phase: Phase, lines: &[&str]) -> Option<View> {
        Some(View { screen, phase, lines: lines.iter().map(|line| line.to_string()).collect() })
    }

    fn claude(enabled: bool) -> Option<ClaudeStatus> {
        Some(ClaudeStatus { supported: true, installed: true, enabled, claude_version: None })
    }

    fn tick(now: u64) -> Event {
        Event::Tick { now, desktop_running: false }
    }

    fn login(event: LoginEvent) -> Event {
        Event::Login(event)
    }

    /// The first answers of the two reads; gives the effects of both, as either may change the menu.
    fn answer(app: &mut App, signed_in: bool, claude: Option<ClaudeStatus>) -> Vec<Effect> {
        let mut effects = app.handle(Event::Auth(Some(signed_in)));
        effects.extend(app.handle(Event::Claude(claude)));
        effects
    }

    /// Found, signed out, Claude Code off: the window offers sign-in.
    fn on_sign_in() -> App {
        let mut app = found();
        answer(&mut app, false, claude(false));
        assert_eq!(app.view(), shown(Screen::SignIn, Phase::Offer, &[]));
        app
    }

    /// Found, signed in, Claude Code off: the window offers Claude Code.
    fn on_claude() -> App {
        let mut app = found();
        answer(&mut app, true, claude(false));
        assert_eq!(app.view(), shown(Screen::Claude, Phase::Offer, &[]));
        app
    }

    #[test]
    fn a_found_cli_is_watched_and_read() {
        let (app, effects) = App::new(Saved::default(), true, false, B);
        let seen = Saved { cli_seen: true, ..Saved::default() };
        for effect in [Effect::SpawnWatch, Effect::ReadAuth, Effect::ReadClaude, Effect::Save(seen), Effect::RegisterLoginItem]
        {
            assert!(has(&effects, &effect), "{effect:?}");
        }
        assert_eq!(rows(&effects)[0], "Starting Harness");
        assert!(shows(&effects).is_empty());
        assert_eq!(app.view(), None);

        let (_, effects) = App::new(SEEN, true, false, B);
        assert!(!effects.iter().any(|effect| matches!(effect, Effect::Save(_))));
    }

    #[test]
    fn no_cli_ever_seen_installs_on_its_own() {
        let (app, effects) = App::new(Saved::default(), false, false, B);
        assert!(has(&effects, &Effect::RunInstall));
        assert!(!has(&effects, &Effect::SpawnWatch));
        assert_eq!(shows(&effects), [shown(Screen::Install, Phase::Working, &[])]);
        assert_eq!(rows(&effects)[0], "Setting up Harness");
        assert_eq!(app.view(), shown(Screen::Install, Phase::Working, &[]));
    }

    #[test]
    fn a_cli_that_was_seen_and_is_gone_is_never_reinstalled() {
        let (app, effects) = App::new(SEEN, false, false, B);
        assert!(effects.iter().all(|effect| matches!(effect, Effect::Menu(_) | Effect::Log(_))), "{effects:?}");
        assert_eq!(rows(&effects), ["Harness removed", "Install", "Quit"]);
        assert_eq!(app.view(), None);

        let mut app = found();
        let effects = app.handle(Event::Cli(false));
        assert!(has(&effects, &Effect::StopWatch));
        assert!(!has(&effects, &Effect::RunInstall));
        assert_eq!(rows(&effects), ["Harness removed", "Install", "Quit"]);
    }

    #[test]
    fn a_cli_that_goes_away_ends_what_needed_it() {
        let mut app = on_sign_in();
        app.handle(Event::Act(Action::SignIn));
        let effects = app.handle(Event::Cli(false));
        assert!(has(&effects, &Effect::StopWatch));
        assert_eq!(shows(&effects), [None]);
        assert_eq!(rows(&effects), ["Harness removed", "Install", "Quit"]);

        // The sign-in it was running is gone with it: a CLI that comes back can sign in again.
        app.handle(Event::Cli(true));
        assert_eq!(shows(&answer(&mut app, false, None)), [shown(Screen::SignIn, Phase::Offer, &[])]);
        assert!(has(&app.handle(Event::Act(Action::SignIn)), &Effect::RunLogin));
    }

    #[test]
    fn the_login_item_is_registered_once() {
        let saved = Saved { cli_seen: true, ..Saved::default() };
        let (mut app, effects) = App::new(saved, true, false, B);
        assert!(has(&effects, &Effect::RegisterLoginItem));
        let registered = Saved { login_item: true, ..saved };
        assert_eq!(app.handle(Event::LoginItem(true)), [Effect::Save(registered)]);

        let (_, effects) = App::new(registered, true, false, B);
        assert!(!has(&effects, &Effect::RegisterLoginItem));

        let (mut app, _) = App::new(saved, true, false, B);
        assert!(app.handle(Event::LoginItem(false)).is_empty());
    }

    #[test]
    fn an_install_that_works_starts_the_daemon_and_moves_on() {
        let mut app = fresh();
        let effects = app.handle(Event::InstallDone(Ok(())));
        let seen = Saved { cli_seen: true, login_item: true, ..Saved::default() };
        for effect in [Effect::Save(seen), Effect::RunStart, Effect::ReadAuth, Effect::ReadClaude] {
            assert!(has(&effects, &effect), "{effect:?}");
        }
        assert!(!has(&effects, &Effect::SpawnWatch));
        assert!(shows(&effects).is_empty());
        assert_eq!(app.view(), shown(Screen::Install, Phase::Working, &[]));
        assert_eq!(rows(&effects)[0], "Starting Harness");

        // Started at once, outside the slot, and once: a tick in the next slot asks nothing while it runs.
        assert!(!has(&app.handle(tick(B + 70)), &Effect::RunStart));
        assert!(has(&app.handle(Event::StartDone { ok: true }), &Effect::SpawnWatch));
        assert_eq!(shows(&answer(&mut app, false, None)), [shown(Screen::SignIn, Phase::Offer, &[])]);
    }

    #[test]
    fn an_install_that_fails_shows_its_lines_and_retry() {
        let mut app = fresh();
        let effects = app.handle(Event::InstallDone(Err(vec!["a".into(), "b".into()])));
        assert_eq!(shows(&effects), [shown(Screen::Install, Phase::Failed, &["a", "b"])]);
        assert_eq!(rows(&effects)[..2], ["Setting up Harness", "Install"]);

        let effects = app.handle(Event::Act(Action::Retry));
        assert!(has(&effects, &Effect::RunInstall));
        assert_eq!(shows(&effects), [shown(Screen::Install, Phase::Working, &[])]);
    }

    #[test]
    fn the_first_screen_waits_for_both_answers() {
        let mut app = found();
        assert!(shows(&app.handle(Event::Auth(Some(false)))).is_empty());
        assert_eq!(shows(&app.handle(Event::Claude(claude(false)))), [shown(Screen::SignIn, Phase::Offer, &[])]);

        let asked = Saved { asked_sign_in: true, asked_claude: true, ..SEEN };
        let mut app = App::new(asked, true, false, B).0;
        assert!(shows(&answer(&mut app, false, claude(false))).is_empty());
        assert_eq!(app.view(), None);
    }

    #[test]
    fn sign_in_from_offer_to_browser_to_done() {
        let mut app = on_sign_in();
        let effects = app.handle(Event::Act(Action::SignIn));
        assert!(has(&effects, &Effect::RunLogin));
        assert_eq!(shows(&effects), [shown(Screen::SignIn, Phase::Working, &[])]);

        let url = "https://id.example/a?state=S".to_string();
        let effects = app.handle(login(LoginEvent::AuthorizeUrl(url.clone())));
        assert!(has(&effects, &Effect::OpenUrl(url)));
        assert_eq!(shows(&effects), [shown(Screen::SignIn, Phase::Browser, &[])]);

        let effects = app.handle(login(LoginEvent::Waiting("w".into())));
        assert_eq!(shows(&effects), [shown(Screen::SignIn, Phase::Browser, &["w"])]);

        let effects = app.handle(login(LoginEvent::Done(Ok(()))));
        assert!(has(&effects, &Effect::Save(Saved { asked_sign_in: true, ..SEEN })));
        assert!(has(&effects, &Effect::ReadAuth));
        assert!(rows(&effects).contains(&"Signed in".to_string()));
        assert_eq!(shows(&effects), [shown(Screen::Claude, Phase::Offer, &[])]);

        // Nothing due after it: the window closes.
        let mut app = found();
        answer(&mut app, false, None);
        app.handle(Event::Act(Action::SignIn));
        assert_eq!(shows(&app.handle(login(LoginEvent::Done(Ok(()))))), [None]);
    }

    #[test]
    fn a_sign_in_that_fails_offers_retry() {
        let mut app = on_sign_in();
        app.handle(Event::Act(Action::SignIn));
        let effects = app.handle(login(LoginEvent::Done(Err("fetch failed".into()))));
        assert_eq!(shows(&effects), [shown(Screen::SignIn, Phase::Failed, &["fetch failed"])]);
        assert!(has(&app.handle(Event::Act(Action::Retry)), &Effect::RunLogin));
    }

    #[test]
    fn cancel_takes_the_sign_in_back() {
        let mut app = on_sign_in();
        app.handle(Event::Act(Action::SignIn));
        app.handle(login(LoginEvent::AuthorizeUrl("https://id.example/a".into())));
        let effects = app.handle(Event::Act(Action::Cancel));
        assert!(has(&effects, &Effect::CancelLogin));
        assert_eq!(shows(&effects), [shown(Screen::SignIn, Phase::Offer, &[])]);
        assert!(app.handle(login(LoginEvent::Done(Err("cancelled".into())))).is_empty());
    }

    #[test]
    fn later_and_not_now_are_remembered() {
        let mut app = on_sign_in();
        let later = Saved { asked_sign_in: true, ..SEEN };
        let effects = app.handle(Event::Act(Action::Later));
        assert!(has(&effects, &Effect::Save(later)));
        assert_eq!(shows(&effects), [shown(Screen::Claude, Phase::Offer, &[])]);

        let both = Saved { asked_claude: true, ..later };
        let effects = app.handle(Event::Act(Action::NotNow));
        assert!(has(&effects, &Effect::Save(both)));
        assert_eq!(shows(&effects), [None]);

        let mut app = App::new(both, true, false, B).0;
        assert!(shows(&answer(&mut app, false, claude(false))).is_empty());
    }

    #[test]
    fn claude_turns_on_from_the_window() {
        let mut app = on_claude();
        let effects = app.handle(Event::Act(Action::TurnOn));
        assert!(has(&effects, &Effect::SetClaude(true)));
        assert_eq!(shows(&effects), [shown(Screen::Claude, Phase::Working, &[])]);
        let effects = app.handle(Event::ClaudeSet(Ok(())));
        assert!(has(&effects, &Effect::ReadClaude));
        assert!(has(&effects, &Effect::Save(Saved { asked_claude: true, ..SEEN })));
        assert_eq!(shows(&effects), [None]);

        let mut app = on_claude();
        app.handle(Event::Act(Action::TurnOn));
        let effects = app.handle(Event::ClaudeSet(Err("x".into())));
        assert_eq!(shows(&effects), [shown(Screen::Claude, Phase::Failed, &["x"])]);
        assert!(!effects.iter().any(|effect| matches!(effect, Effect::Save(_))));
        assert!(has(&app.handle(Event::Act(Action::Retry)), &Effect::SetClaude(true)));
    }

    #[test]
    fn claude_turns_off_from_the_menu() {
        let mut app = found();
        answer(&mut app, true, claude(true));
        assert_eq!(app.handle(Event::Menu(MenuAction::ClaudeOff)), [Effect::SetClaude(false)]);
        assert_eq!(app.handle(Event::ClaudeSet(Ok(()))), [Effect::ReadClaude]);
        let effects = app.handle(Event::Claude(claude(false)));
        assert_eq!(rows(&effects)[2..4], ["Claude Code: Off", "Turn on…"]);
        assert!(shows(&effects).is_empty());

        // A failed turn-off changes nothing: the runner logged it.
        let mut app = found();
        answer(&mut app, true, claude(true));
        app.handle(Event::Menu(MenuAction::ClaudeOff));
        assert!(app.handle(Event::ClaudeSet(Err("x".into()))).is_empty());
    }

    #[test]
    fn no_claude_row_or_screen_without_the_command() {
        let mut app = found();
        let effects = answer(&mut app, true, None);
        assert_eq!(rows(&effects), ["Starting Harness", "Signed in", "Quit"]);
        assert!(shows(&effects).is_empty());

        let mut app = found();
        answer(&mut app, false, None);
        assert_eq!(shows(&app.handle(Event::Act(Action::Later))), [None]);
    }

    #[test]
    fn the_menu_reads_again_at_most_once_a_minute() {
        let reads = |effects: &[Effect]| (has(effects, &Effect::ReadAuth), has(effects, &Effect::ReadClaude));
        let opened = |now: u64, desktop_installed: bool| Event::MenuOpened { now, desktop_installed };
        let mut app = found();
        assert_eq!(reads(&app.handle(opened(B + 10, false))), (false, false));
        assert_eq!(reads(&app.handle(opened(B + 60, false))), (true, true));
        assert_eq!(reads(&app.handle(opened(B + 70, false))), (false, false));

        let effects = app.handle(opened(B + 80, true));
        assert_eq!(rows(&effects), ["Starting Harness", "Open Harness", "Quit"]);
        assert_eq!(rows(&app.handle(opened(B + 90, false))), ["Starting Harness", "Quit"]);

        assert_eq!(reads(&removed().handle(opened(B + 120, false))), (false, false));
    }

    #[test]
    fn a_dial_line_changes_the_menu_and_the_log() {
        let mut app = found();
        let line = DialStatus {
            attached: true,
            fw: Some("0.0.95".into()),
            hw: None,
            board: None,
            updating: None,
            problem: None,
        };
        let effects = app.handle(Event::WatchLine(line.clone()));
        assert_eq!(rows(&effects)[0], "Dial connected · 0.0.95");
        assert!(has(&effects, &Effect::Log("menu: Dial connected · 0.0.95 | Quit".into())));
        assert!(app.handle(Event::WatchLine(line)).is_empty());

        assert_eq!(rows(&app.handle(Event::WatchExit(Some(3))))[0], "Starting Harness");
    }

    #[test]
    fn the_keep_alive_drives_the_daemon() {
        let two_downs = || {
            let mut app = found();
            app.handle(Event::WatchExit(Some(3)));
            assert_eq!(app.handle(tick(B + 5)), [Effect::SpawnWatch]);
            app.handle(Event::WatchExit(Some(3)));
            app
        };

        let mut app = two_downs();
        assert!(has(&app.handle(tick(B + 10)), &Effect::RunStart));
        assert!(has(&app.handle(Event::StartDone { ok: true }), &Effect::SpawnWatch));

        let mut app = two_downs();
        let effects = app.handle(Event::Tick { now: B + 10, desktop_running: true });
        assert!(has(&effects, &Effect::SpawnWatch));
        assert!(!has(&effects, &Effect::RunStart));
        assert_eq!(logs(&effects), ["keep-alive: the desktop app runs; not starting"]);
        app.handle(Event::WatchExit(Some(3)));
        let effects = app.handle(Event::Tick { now: B + 15, desktop_running: true });
        assert!(has(&effects, &Effect::SpawnWatch));
        assert!(logs(&effects).is_empty());
    }

    #[test]
    fn a_cli_that_comes_back_is_found_on_a_tick() {
        let mut app = removed();
        assert_eq!(app.handle(tick(B + 5)), [Effect::FindCli]);
        let effects = app.handle(Event::Cli(true));
        for effect in [Effect::SpawnWatch, Effect::ReadAuth, Effect::ReadClaude] {
            assert!(has(&effects, &effect), "{effect:?}");
        }
        assert_eq!(rows(&effects), ["Starting Harness", "Quit"]);

        // An install under way is not looked past.
        assert!(!has(&fresh().handle(tick(B + 5)), &Effect::FindCli));
    }

    #[test]
    fn a_second_click_runs_nothing_twice() {
        let mut app = on_sign_in();
        let mut effects = app.handle(Event::Act(Action::SignIn));
        effects.extend(app.handle(Event::Act(Action::SignIn)));
        effects.extend(app.handle(Event::Menu(MenuAction::SignIn)));
        effects.extend(app.handle(Event::Menu(MenuAction::SignIn)));
        assert_eq!(count(&effects, &Effect::RunLogin), 1);
        assert_eq!(app.view(), shown(Screen::SignIn, Phase::Working, &[]));

        let mut app = on_claude();
        let mut effects = app.handle(Event::Act(Action::TurnOn));
        effects.extend(app.handle(Event::Act(Action::TurnOn)));
        assert_eq!(count(&effects, &Effect::SetClaude(true)), 1);

        let mut app = removed();
        let mut effects = app.handle(Event::Menu(MenuAction::Install));
        effects.extend(app.handle(Event::Menu(MenuAction::Install)));
        assert_eq!(count(&effects, &Effect::RunInstall), 1);

        let mut app = found();
        answer(&mut app, true, claude(true));
        let mut effects = app.handle(Event::Menu(MenuAction::ClaudeOff));
        effects.extend(app.handle(Event::Menu(MenuAction::ClaudeOff)));
        assert_eq!(count(&effects, &Effect::SetClaude(false)), 1);

        // A button the window does not show does nothing.
        assert!(found().handle(Event::Act(Action::TurnOn)).is_empty());
    }

    #[test]
    fn closing_the_window_on_an_offer_is_later() {
        let mut app = on_sign_in();
        let effects = app.handle(Event::WindowClosed);
        assert!(has(&effects, &Effect::Save(Saved { asked_sign_in: true, ..SEEN })));
        assert_eq!(shows(&effects), [None]);

        let mut app = on_claude();
        let effects = app.handle(Event::WindowClosed);
        assert!(has(&effects, &Effect::Save(Saved { asked_claude: true, ..SEEN })));
        assert_eq!(shows(&effects), [None]);
    }

    #[test]
    fn closing_the_window_never_stops_what_runs() {
        let mut app = on_sign_in();
        app.handle(Event::Act(Action::SignIn));
        app.handle(login(LoginEvent::AuthorizeUrl("https://id.example/a".into())));
        let effects = app.handle(Event::WindowClosed);
        assert!(!has(&effects, &Effect::CancelLogin));
        assert!(has(&effects, &Effect::Save(Saved { asked_sign_in: true, ..SEEN })));
        assert_eq!(shows(&effects), [None]);
        let effects = app.handle(login(LoginEvent::Done(Ok(()))));
        assert!(rows(&effects).contains(&"Signed in".to_string()));
        assert!(shows(&effects).is_empty());

        // Decision 1: a failed install whose window was closed is offered from the menu.
        let mut app = fresh();
        assert_eq!(app.handle(Event::WindowClosed), [Effect::Show(None)]);
        let effects = app.handle(Event::InstallDone(Err(vec!["x".into()])));
        assert_eq!(rows(&effects), ["Setting up Harness", "Install", "Quit"]);
        assert!(shows(&effects).is_empty());
    }

    #[test]
    fn open_and_quit() {
        let mut app = found();
        assert_eq!(app.handle(Event::Menu(MenuAction::OpenHarness)), [Effect::OpenDesktop]);
        assert_eq!(app.handle(Event::Menu(MenuAction::Quit)), [Effect::StopWatch, Effect::Quit]);
    }
}
