part of 'workspace_companion.dart';

enum CompanionDaypart {
  morning('A fresh day. A familiar little face.'),
  afternoon('Keeping you company this afternoon.'),
  evening('A little company for the evening.'),
  night('Quiet company for the late shift.');

  const CompanionDaypart(this.description);
  final String description;
  static CompanionDaypart at(DateTime time) => switch (time.hour) {
    >= 5 && < 12 => morning,
    >= 12 && < 18 => afternoon,
    >= 18 && < 22 => evening,
    _ => night,
  };
}

extension CompanionMoodNotes on CompanionMood {
  String get trigger => switch (this) {
    CompanionMood.content => 'Company, with a different line through the day.',
    CompanionMood.curious => 'Exploring the store, or saying hello.',
    CompanionMood.focused => 'A harness is working.',
    CompanionMood.waiting => 'A harness needs your input.',
    CompanionMood.happy => 'A little play, a joke, or a pep talk.',
    CompanionMood.celebrating => 'A turn finishes, or you say "we did it".',
    CompanionMood.puzzled => 'An open harness is offline, or you say "oops".',
    CompanionMood.grumpy => 'Ask me to "complain". Just a little drama.',
    CompanionMood.sad => 'Say "sigh". We can sit with a rough moment.',
    CompanionMood.startled => 'Say "boop". I was not expecting that.',
    CompanionMood.affectionate => 'A pet, a thank-you, or your return.',
    CompanionMood.asleep => 'A 15-minute nap, whenever you like.',
  };
}

enum CompanionPrompt {
  greeting(CompanionMood.curious),
  thanks(CompanionMood.affectionate),
  encouragement(CompanionMood.happy),
  celebration(CompanionMood.celebrating),
  complaint(CompanionMood.grumpy),
  comfort(CompanionMood.sad),
  boop(CompanionMood.startled),
  puzzle(CompanionMood.puzzled),
  joke(CompanionMood.happy),
  help(CompanionMood.curious),
  unknown(CompanionMood.curious);

  const CompanionPrompt(this.mood);
  final CompanionMood mood;
}

extension CompanionVoice on CompanionSpecies {
  String dayQuote(CompanionDaypart part) => const [
    [
      'morning. i have inspected the keyboard.',
      'the warmest process is mine.',
      'golden hour. excellent whisker lighting.',
      'night shift. i can supervise quietly.',
    ],
    [
      'new day. new crumbs to investigate.',
      'i found a shortcut. it goes to snacks.',
      'shall we see where this tunnel goes?',
      'tiny footsteps. everyone else is asleep.',
    ],
    [
      'a fresh leaf. a fresh start.',
      'steady is a perfectly good speed.',
      'look how far we came today.',
      'the world can wait a little.',
    ],
    [
      'good morning from this side of the glass.',
      'a small lap around the afternoon.',
      'the light is lovely in here.',
      'moonlight looks like bubbles.',
    ],
    [
      'a fresh thread for a fresh day.',
      'one connection at a time.',
      'our little corner is coming together.',
      'quiet hours. delicate work.',
    ],
    [
      'morning already? five more echoes.',
      'i found a very respectable shady spot.',
      'ah. my kind of lighting.',
      'finally. office hours.',
    ],
  ][index][part.index];

  String reply(CompanionPrompt prompt, int turn) {
    if (prompt == CompanionPrompt.help) {
      return 'try hello, pep talk, joke, boop, play, nap, or /name Pip.';
    }
    if (prompt == CompanionPrompt.joke && turn.isOdd) {
      return const [
        'my code has no bugs. i ate them.',
        'i prefer small talk. occupational hazard.',
        'i use async. eventually.',
        'my entire stack is bubbles.',
        'yes, i do web development.',
        'i debug by echo location.',
      ][index];
    }
    return switch (prompt) {
      CompanionPrompt.greeting => const [
        'oh, hello. i was definitely not on your keyboard.',
        'hello! i saved you a very interesting crumb.',
        'hello, friend. no need to hurry.',
        'blub! that means hello. and several other things.',
        'hello. i kept this corner tidy for you.',
        'hello, hello. the second one was an echo.',
      ][index],
      CompanionPrompt.thanks => const [
        'i accept payment in head pats.',
        'you make this a very nice place to be small.',
        'anywhere with you is a good pace.',
        'you are my favorite part of the pond.',
        'eight tiny high fives.',
        'my favorite person to hang with.',
      ][index],
      CompanionPrompt.encouragement => const [
        'one small thing. then a stretch. i will supervise.',
        'big things fit through small doors. one bit at a time.',
        'slow counts. one small step is still a step.',
        'one bubble at a time. you do not need the whole ocean.',
        'find one loose thread. start there. i can hold this end.',
        'even in the dark, there is a next little step.',
      ][index],
      CompanionPrompt.celebration => const [
        'excellent. i shall pretend this was my plan.',
        'WE DID IT. sorry. small voice, big feelings.',
        'a historic day for small feet.',
        'the biggest bubble! for us!',
        'look what we made. every thread mattered.',
        'a completely necessary victory lap.',
      ][index],
      CompanionPrompt.complaint => const [
        'the compiler has been very rude to my human.',
        'this cable is longer than it needs to be.',
        'someone scheduled urgency. i object.',
        'the glass is in the way. again.',
        'who moved my perfectly good thread?',
        'the sun continues to be unreasonable.',
      ][index],
      CompanionPrompt.comfort => const [
        'a small sigh. i can sit here with you.',
        'rough tunnel. we can rest right here.',
        'some days are uphill. we can stop a moment.',
        'a little rain in the ocean. i am still here.',
        'a tangled day is not a ruined web.',
        'a quiet corner for a moment. i saved you one.',
      ][index],
      CompanionPrompt.boop => const [
        'my dignity. where did it go.',
        'eep! oh. it is you.',
        'unexpected speed. investigating.',
        'BLUB?!',
        'all eight feet left the ground.',
        'who pinged the bat?',
      ][index],
      CompanionPrompt.puzzle => const [
        'hmm. a suspicious little situation.',
        'wrong tunnel? we can back up one step.',
        'perhaps another path around the rock.',
        'have we been around this rock before?',
        'a knot. not the end of the thread.',
        'the echo came back funny. worth another look.',
      ][index],
      CompanionPrompt.joke => const [
        'i ran cat. it was me.',
        'i am the only mouse allowed near vim.',
        'my download speed is one leaf per afternoon.',
        'i keep all my work in a stream.',
        'eight legs. still cannot exit vim.',
        'my favorite command is echo. echo.',
      ][index],
      CompanionPrompt.unknown => const [
        'a thoughtful noise. i am better at company than answers.',
        'i am listening. mostly with these very small ears.',
        'i may not know the answer. i can keep you company.',
        'blub. a small reply from a small fish.',
        'that is a thread for your harness. i will hold this corner.',
        'the big questions are for your harness. i brought the small talk.',
      ][index],
      CompanionPrompt.help => '',
    };
  }
}
