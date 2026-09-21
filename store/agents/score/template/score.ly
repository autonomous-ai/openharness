\version "2.24.3"
% All music is in CONCERT pitch. The builder makes written instrument parts.
% The saved brief, meter, key, tempo and difficulty checks live in ensemble.json.
fluteMusic = \relative c'' {
  c4.\p( e8 d c) | d4.( e4 g8) |
  g4.( e4 d8) | e2. \breathe \break |
  f4.\mp( a8 g f) | e4.( g4 e8) |
  d4( e8 f4 d8) | c2. \breathe \break |
  e4.\mf( g8 a g) | f4.( e4 d8) |
  e4( f8 g4 e8) | d2. \breathe \break |
  c4.\mp( e8 d c) | d4.( f4 e8) |
  d4.\>( e4 d8) | c2.\pp \bar "|."
}
clarinetMusic = \relative c' {
  e4.\p g | f4. g | e4. g | g2. \breathe \break |
  a4.\mp f | g4. c | a4. f | e2. \breathe \break |
  g4.\mf c | a4. f | g4. e | f2. \breathe \break |
  e4.\mp g | f4. a | g4.\> f | e2.\pp
}
celloMusic = \relative c {
  c2.\p | g2. | c2. | c2. \break |
  f,2.\mp | c'2. | g2. | c2. \break |
  c2.\mf | f,2. | c'2. | g2. \break |
  c2.\mp | f,2. | g2.\> | c2.\pp
}
