# Prebuilt, verified runtime bytes must retain their recorded identity.
%global debug_package %{nil}
%global __os_install_post %{nil}
%global _build_id_links none

Name: harness-os-session
Version: %{harness_version}
Release: %{harness_release}
Summary: Harness OS terminal and agent session for Fedora
License: MIT
URL: https://github.com/autonomous-ai/openharness
ExclusiveArch: aarch64
Source0: payload.tar.gz
Source1: files.list

Requires: python3, nodejs22, nodejs22-bin, tmux, foot, labwc
Requires: systemd, dbus-tools, NetworkManager, sudo, util-linux, procps-ng, kmod, iproute
Requires: pipewire, pipewire-pulseaudio, wireplumber, swayidle, swaylock, brightnessctl
Requires: wl-clipboard, xdg-utils, xdg-desktop-portal-wlr, dejavu-sans-mono-fonts
Requires: google-noto-color-emoji-fonts, cascadia-mono-nf-fonts

%description
The minimal Harness OS session and verified native ARM runtime. This is a
component for a future Fedora/Asahi Harness image. It does not provision accounts,
start services, install a boot chain, or implement Fedora system recovery.
Chromium and the image's default agent are supplied separately when needed.
The optional harness-session-setup command uses Fedora's separately installed
greetd package for explicit, reversible next-boot login with an existing account.

%prep
%setup -q -c -T
tar -xzf %{SOURCE0}

%build

%install
mkdir -p %{buildroot}
cp -a usr %{buildroot}/

%files -f %{SOURCE1}
%defattr(-,root,root,-)

# Intentionally no scriptlets, presets or configuration under /etc. Installing,
# upgrading or removing this component must not take over an existing session.
