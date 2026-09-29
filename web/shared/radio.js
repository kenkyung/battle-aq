// CS 1.6 radio commands: Z, X and C open the three menus, a number sends it
// to your team (text + voice).
export const RADIO = {
  z: ['Cover me!', 'You take the point.', 'Hold this position.', 'Regroup team.', 'Follow me.', 'Taking fire, need assistance!'],
  x: ['Go go go!', 'Team, fall back!', 'Stick together, team.', 'Get in position and wait for my go.', 'Storm the front!', 'Report in, team.'],
  c: ['Affirmative.', 'Enemy spotted.', 'Need backup.', 'Sector clear.', "I'm in position.", 'Reporting in.', "She's gonna blow!", 'Negative.', 'Enemy down.'],
};
export const radioText = (menu, i) => (RADIO[menu] || [])[i] || null;
