// Server rules (CS 1.6 mp_* cvars), chosen per room. Casual is this game's
// default server; Competitive is the usual CS 1.6 match config (MR15,
// 1:45 rounds, 15 s freeze, friendly fire on).

export const RULES = {
  casual: {
    name: 'Casual',
    freezetime: 6,        // mp_freezetime (s)
    roundtime: 150,       // mp_roundtime (s)
    buytime: 54,          // mp_buytime: s after the freeze ends
    c4timer: 35,          // mp_c4timer
    maxrounds: 15,        // mp_maxrounds
    winlimit: 8,          // mp_winlimit
    halftime: 7,          // sides swap after this round
    friendlyfire: false,  // mp_friendlyfire
    roundEnd: 5,          // s between rounds
    tickrate: 33,         // server simulation, Hz
    updaterate: 30,       // snapshots to clients, Hz (cl_updaterate)
  },
  competitive: {
    name: 'Competitive (MR15)',
    freezetime: 15,
    roundtime: 105,
    buytime: 15,
    c4timer: 35,
    maxrounds: 30,
    winlimit: 16,
    halftime: 15,
    friendlyfire: true,
    roundEnd: 5,
    tickrate: 66,
    updaterate: 60,
  },
};

export function rulesFor(id) { return RULES[id] || RULES.casual; }

// CS 1.6 friendly fire does 35 % damage (cs_player TakeDamage)
export const FF_DAMAGE = 0.35;
