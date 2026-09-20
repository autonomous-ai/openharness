\version "2.24.3"
\header {
  title = "Lighthouse at Dusk"
  subtitle = "A small study in motion"
  composer = "OpenHarness"
  tagline = ##f
}
\paper {
  #(set-paper-size "a4")
  top-margin = 16\mm
  bottom-margin = 16\mm
  left-margin = 18\mm
  right-margin = 18\mm
  system-system-spacing.basic-distance = #21
}
global = { \key e \minor \time 6/8 \tempo "Quietly, with space" 4. = 54 }
right = \relative c'' {
  \global
  b4.\p( e8 fis g) | fis4.( e4 d8) |
  e4( b8) g4( a8) | b2. \breathe \break |
  g'4.\mp( fis8 e d) | e4.( b4 a8) |
  g4( a8 b4 d8) | fis2. \breathe \break |
  e4.\mf( g8 fis e) | d4.( fis8 e d) |
  c4( e8) b4( d8) | a2. \breathe \break |
  b4.\mp( e8 fis g) | fis4( e8) d4( b8) |
  e4.\>( fis4 d8) | e2.\pp\fermata \bar "|."
}
left = \relative c {
  \global \clef bass
  e8 b' e g e b | d, a' d fis d a |
  c, g' c e c g | b, fis' b dis b fis |
  e b' e g e b | c, g' c e c g |
  a, e' a c a e | b fis' b dis b fis |
  e b' e g e b | d, a' d fis d a |
  c, g' c e c g | a, e' a c a e |
  e b' e g e b | d, a' d fis d a |
  b, fis' b dis b fis | <e, b' e>2.\fermata
}
\score {
  \new PianoStaff \with { instrumentName = "Piano" }
  <<
    \new Staff = "right" \with { midiInstrument = "acoustic grand" } \right
    \new Staff = "left" \with { midiInstrument = "acoustic grand" } \left
  >>
  \layout { indent = 10\mm }
  \midi { }
}
