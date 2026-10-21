/* Mock data for the redesign test phase. Swap these exports for real
   API/room state later; screens only read from here (plus local state). */

export const POSTERS = [
  { t: 'Shogun', m: '2024, Series', src: 'Direct links', g: ['#3F3434', '#1E1A1B'] },
  { t: 'Dune Part Two', m: '2024, Movie', src: 'Direct links', g: ['#403A32', '#1D1A16'] },
  { t: 'The Bear', m: '2023, Series', src: 'Direct links', g: ['#323A40', '#171A1D'] },
  { t: 'Oppenheimer', m: '2023, Movie', src: 'YouTube', g: ['#40362F', '#1C1815'] },
  { t: 'The Last of Us', m: '2023, Series', src: 'Direct links', g: ['#363B34', '#181A17'] },
  { t: 'Spider-Verse', m: '2023, Movie', src: 'Direct links', g: ['#393440', '#1A181C'] },
  { t: 'Breaking Bad', m: '2008, Series', src: 'Direct links', g: ['#323B36', '#161A18'] },
  { t: 'Wednesday', m: '2022, Series', src: 'Direct links', g: ['#383840', '#18181C'] },
  { t: 'Silo', m: '2023, Series', src: 'Direct links', g: ['#3B3934', '#1A1917'] },
];

export const PEOPLE = [
  { n: 'You', c: '#E9B44C', role: 'Host', badge: 'Master Cinephile', state: 'Active now' },
  { n: 'Aisha', c: '#BDB9C8', role: 'Co-host', badge: 'Watch Diehard', state: 'Active now' },
  { n: 'David', c: '#A39FAE', role: 'Viewer', badge: 'Active Member', state: 'Active now' },
  { n: 'Maryam', c: '#BDB9C8', role: 'Viewer', badge: 'Active Member', state: 'Idle' },
  { n: 'Leo', c: '#8D8998', role: 'Viewer', badge: 'Watch Diehard', state: 'Active now' },
  { n: 'Uche', c: '#A39FAE', role: 'Viewer', badge: 'Active Member', state: 'Chat muted' },
];

export const LIVE_ROOMS = [
  { p: 0, title: 'Friday Night, Shogun', host: 'Aisha', n: 6, ep: 'E4, 38:12 in', friends: 'Aisha and Leo are here' },
  { p: 6, title: 'Breaking Bad rewatch crew', host: 'David', n: 4, ep: 'S3 E7, just started', friends: '' },
  { p: 8, title: 'Silo watchalong', host: 'Maryam', n: 9, ep: 'S2 E2, 12:40 in', friends: 'Maryam is here' },
];

export const RECENT = ['Silo', 'Fallout', 'Premier League'];

export const CHANNELS = [
  ['CNN', 'CNN', 'Newsroom with Wolf Blitzer'],
  ['BBC', 'BBC World News', 'News, live'],
  ['ARI', 'Arise News', 'The Morning Show'],
  ['CHA', 'Channels TV', 'Politics Today'],
  ['SST', 'SuperSport', 'Premier League'],
];

export const SPORTS = [
  ['Arsenal v Chelsea', 'Premier League, started 38m ago'],
  ['Real Madrid v Girona', 'La Liga, started 12m ago'],
];

export const EPISODES = [
  { id: 'E1', title: 'Anjin', sub: 'A wrecked English ship is found off the coast.' },
  { id: 'E2', title: 'Servants of Two Masters', sub: 'Toranaga questions the pilot through a translator.' },
  { id: 'E3', title: 'Tomorrow is Tomorrow', sub: 'Resolving link, one moment' },
  { id: 'E4', title: 'The Eightfold Fence', sub: 'Blackthorne trains the regiment while the council moves against Toranaga.' },
];

export const TITLE = {
  name: 'Shogun',
  meta: '2024, 1 season, Drama, Direct links',
  synopsis: 'An English pilot is shipwrecked in Japan in 1600 and is pulled into the fight for power around Lord Toranaga. Based on the novel by James Clavell.',
};

export const ROOM = {
  name: 'Friday Night, Shogun',
  seats: '6 of 8 in',
  episode: 'Episode 4, The Eightfold Fence',
  source: 'Shogun, Direct video',
  code: 'K7QX29',
  link: 'https://chan.app/room/friday-night?invite=K7QX29',
  duration: 3484, // 58:04
  startAt: 2292, // 38:12
};

/* Chat feed items: {kind} discriminated union rendered by ChatPanel. */
export const MESSAGES = [
  { kind: 'catchup' },
  { kind: 'quiz' },
  { kind: 'msg', name: 'Aisha', color: '#BDB9C8', time: '9:32', text: 'the rain scene is unreal, hold on' },
  { kind: 'reactions', items: [['❤', 2], ['🔥', 1]] },
  { kind: 'sys', text: 'You paused, everyone synced to 38:12' },
  { kind: 'msg', name: 'David', color: '#A39FAE', time: '9:33', reply: 'Aisha: the rain scene is unreal', text: 'rewind ten seconds, look at the banner behind him' },
  { kind: 'sys', text: 'Maryam joined the room' },
  { kind: 'msg', name: 'Leo', color: '#8D8998', time: '9:34', text: 'queue episode 5 after this, I am not stopping here' },
  { kind: 'typing', text: 'Aisha is typing' },
];

export const QUIZ = {
  by: 'Aisha',
  q: 'What does Toranaga ask Blackthorne to teach his regiment?',
  options: ['European cannon tactics', 'Ship navigation', 'English'],
  votes: [3, 1, 0],
  correct: 0,
};

export const QUEUE = [
  { p: 0, title: 'Shogun, episode 5', by: 'Added by Leo' },
  { p: 1, title: 'Dune Part Two', by: 'Added by Aisha' },
  { p: 4, title: 'The Last of Us, episode 1', by: 'Added by David' },
];

export const BADGES = ['Master Cinephile', 'Watch Diehard', 'Active Member'];

export const BUILD = { version: '1.0.184', commit: '9a9b1f3', built: '2026-10-20 17:40 UTC' };

export const QR_CELLS = [
  1, 1, 1, 0, 1, 0, 1, 0, 1, 1, 1, 1, 0, 1, 0, 0, 1, 0, 0, 1, 0, 1, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 0, 0, 1, 0, 1, 0, 1, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1, 1, 0, 1, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 1, 1, 1, 0, 1, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1, 0, 0, 1, 1, 1, 0, 0, 1, 1, 0, 1, 0, 1, 1, 0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 1, 1, 0, 1, 1, 0, 1, 1, 0, 1,
];
