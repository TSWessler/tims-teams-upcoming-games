const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const API_KEY = process.env.ODDS_API_KEY;
const SPORTS = [
  'icehockey_nhl',      // NHL
  'basketball_nba',     // NBA
  'americanfootball_nfl', // NFL
  'americanfootball_ncaaf' // College Football
];

const TEAMS = [
  { name: 'Colorado Avalanche', sport: 'hockey/nhl', sportKey: 'icehockey_nhl', teamId: 17, abbr: 'COL' },
  { name: 'Denver Nuggets', sport: 'basketball/nba', sportKey: 'basketball_nba', teamId: 7, abbr: 'DEN' },
  { name: 'Denver Broncos', sport: 'football/nfl', sportKey: 'americanfootball_nfl', teamId: 7, abbr: 'DEN' },
  { name: 'Colorado Buffaloes', sport: 'football/college-football', sportKey: 'americanfootball_ncaaf', teamId: 38, abbr: 'COLO' }
];

// Where odds.json and standings.json are read and written. The workflows point
// this at their checkout of the data branch.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');

// Odds schedule (see planOddsFetches). Each fetch of one league costs 1 credit.
const PRE_GAME_WINDOW_MIN = 100; // fetch a league when its game starts within this many minutes
const MORNING_HOUR_MT = 8;       // daily refresh of leagues with a game in the next week
const LOOKAHEAD_DAYS = 7;
const MORNING_RESERVE = 25;      // below this many credits, skip morning refreshes and keep the rest for pre-game

async function fetchOddsForSport(sport) {
  const url = `https://api.the-odds-api.com/v4/sports/${sport}/odds/?apiKey=${API_KEY}&regions=us&markets=h2h&oddsFormat=american`;
  
  try {
    const response = await fetch(url);
    if (!response.ok) {
      console.error(`Error fetching ${sport}: ${response.status} ${response.statusText}`);
      return null;
    }
    const data = await response.json();
    const remaining = Number(response.headers.get('x-requests-remaining'));
    console.log(`✓ Fetched ${data.length} games for ${sport} (${remaining} credits left)`);
    return { sport, games: data, remaining: Number.isFinite(remaining) ? remaining : null };
  } catch (error) {
    console.error(`Error fetching ${sport}:`, error.message);
    return null;
  }
}

async function fetchTeamStandings(team) {
  const url = `https://site.api.espn.com/apis/site/v2/sports/${team.sport}/teams/${team.teamId}`;
  
  try {
    const response = await fetch(url);
    if (!response.ok) {
      console.error(`Error fetching standings for ${team.name}: ${response.status}`);
      return null;
    }
    const data = await response.json();
    
    let standings = null;
    if (data.team?.record?.items) {
      standings = data.team.record.items[0];
    }
    
    let standingSummary = null;
    if (data.team?.standingSummary) {
      standingSummary = data.team.standingSummary;
    }
    
    console.log(`✓ Fetched standings for ${team.name}`);
    return {
      teamId: team.teamId,
      name: team.name,
      abbr: team.abbr,
      sport: team.sport,
      standings,
      standingSummary
    };
  } catch (error) {
    console.error(`Error fetching standings for ${team.name}:`, error.message);
    return null;
  }
}

async function fetchOpponentStandings(sport, teamId) {
  const url = `https://site.api.espn.com/apis/site/v2/sports/${sport}/teams/${teamId}`;
  
  try {
    const response = await fetch(url);
    if (!response.ok) {
      return null;
    }
    const data = await response.json();
    
    if (data.team?.record?.items && data.team.record.items[0]?.stats) {
      const stats = data.team.record.items[0].stats;
      const wins = stats.find(s => s.name === 'wins')?.value || 0;
      const losses = stats.find(s => s.name === 'losses')?.value || 0;
      
      let record = '';
      if (sport.includes('nfl')) {
        const ties = stats.find(s => s.name === 'ties')?.value || 0;
        record = `(${wins}-${losses}-${ties})`;
      } else if (sport.includes('basketball')) {
        const winPct = stats.find(s => s.name === 'winPercent')?.value || 0;
        record = `(${wins}-${losses}, ${winPct.toFixed(3)})`;
      } else {
        record = `(${wins}-${losses})`;
      }
      
      let rankText = '';
      if (data.team.standingSummary) {
        rankText = ` - ${data.team.standingSummary}`;
      }
      
      return {
        teamId,
        record: record + rankText
      };
    }
  } catch (error) {
    return null;
  }
  
  return null;
}

async function fetchUpcomingOpponents() {
  console.log('Fetching opponent standings for upcoming games...');
  const opponents = new Map(); // Use Map to avoid duplicates
  
  for (const team of TEAMS) {
    try {
      // Get team schedule
      const scheduleUrl = `https://site.api.espn.com/apis/site/v2/sports/${team.sport}/teams/${team.teamId}/schedule`;
      const response = await fetch(scheduleUrl);
      if (!response.ok) continue;
      
      const data = await response.json();
      if (!data.events) continue;
      
      // Get upcoming games
      const upcomingGames = data.events.filter(e => 
        e.competitions[0].status.type.state === 'pre'
      ).slice(0, 3); // Get next 3 games
      
      for (const game of upcomingGames) {
        const competition = game.competitions[0];
        const homeTeam = competition.competitors.find(t => t.homeAway === 'home');
        const awayTeam = competition.competitors.find(t => t.homeAway === 'away');
        const isHome = homeTeam.team.id == team.teamId;
        const opponentTeamId = isHome ? awayTeam.team.id : homeTeam.team.id;
        
        // Create unique key for this opponent in this sport
        const key = `${team.sport}-${opponentTeamId}`;
        
        if (!opponents.has(key)) {
          const oppStandings = await fetchOpponentStandings(team.sport, opponentTeamId);
          if (oppStandings) {
            opponents.set(key, {
              sport: team.sport,
              ...oppStandings
            });
          }
        }
      }
    } catch (error) {
      console.error(`Error fetching opponents for ${team.name}:`, error.message);
    }
  }
  
  const opponentsList = Array.from(opponents.values());
  console.log(`✓ Fetched ${opponentsList.length} opponent standings`);
  return opponentsList;
}

function ordinal(n) {
  const v = n % 100;
  const suffix = (v >= 11 && v <= 13) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th');
  return `${n}${suffix}`;
}

// Standings broken down by league, conference and division, keyed by ESPN team id.
// Each line: { text: '(10-6, 0.625) - 12th in NBA', link, ... }
// ESPN's own standingSummary for NBA teams reads e.g. "7th in Western Conference Division"
// (conference rank, wrong label), so we build these lines from the standings API instead.
const BREAKDOWN = {
  'basketball/nba': {
    league: 'NBA', standingsUrl: 'https://www.espn.com/nba/standings/_/group/',
    // rank by win %; conference rank is the playoff seed
    sortKey: e => [-num(e, 'winPercent'), num(e, 'playoffSeed')],
    leagueTiesBy: e => num(e, 'winPercent'),
    conferenceRank: (e, sorted) => num(e, 'playoffSeed'),
    record: { league: e => withPct(`${num(e, 'wins')}-${num(e, 'losses')}`), conference: e => withPct(stat(e, 'vs. Conf.')), division: e => withPct(stat(e, 'vs. Div.')) },
    groupName: { conference: g => g.name, division: g => `${g.name} Division` }
  },
  'hockey/nhl': {
    league: 'NHL', standingsUrl: 'https://www.espn.com/nhl/standings/_/group/',
    // rank by points, then points per game, then regulation wins
    sortKey: e => [-num(e, 'points'), -(num(e, 'points') / Math.max(1, num(e, 'gamesPlayed'))), -num(e, 'regWins')],
    leagueTiesBy: null,
    conferenceRank: null,
    // ESPN gives no conference record for the NHL; fetchNhlConferenceRecord counts it for our team
    record: {
      league: e => `(${num(e, 'wins')}-${num(e, 'losses')}-${num(e, 'otLosses')}, ${num(e, 'points')} pts)`,
      conference: () => '',
      division: e => `(${(stat(e, 'vs. Div.') || '').split(',')[0]})`
    },
    groupName: { conference: g => g.name, division: g => g.name }
  },
  'football/nfl': {
    league: 'NFL', standingsUrl: 'https://www.espn.com/nfl/standings/_/group/',
    // rank by win %; conference rank is the playoff seed
    sortKey: e => [-num(e, 'winPercent'), num(e, 'playoffSeed')],
    leagueTiesBy: e => num(e, 'winPercent'),
    conferenceRank: (e, sorted) => num(e, 'playoffSeed'),
    record: { league: e => `(${num(e, 'wins')}-${num(e, 'losses')}-${num(e, 'ties')})`, conference: e => `(${stat(e, 'vs. Conf.')})`, division: e => `(${stat(e, 'vs. Div.')})` },
    groupName: { conference: g => g.abbreviation || g.name, division: g => g.name }
  }
};

function stat(e, name) { return e.stats.find(s => s.name === name || s.displayName === name)?.displayValue; }
function num(e, name) { return Number(e.stats.find(s => s.name === name)?.value ?? 0); }
// "6-6" -> "(6-6, 0.500)"
function withPct(recordText) {
  const [w, l] = (recordText || '0-0').split('-').map(Number);
  return `(${w}-${l}, ${(w + l > 0 ? w / (w + l) : 0).toFixed(3)})`;
}
function compareKeys(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

async function fetchBreakdown(sport) {
  const cfg = BREAKDOWN[sport];
  const get = async level => {
    const r = await fetch(`https://site.api.espn.com/apis/v2/sports/${sport}/standings?level=${level}`);
    if (!r.ok) throw new Error(`${cfg.league} standings level ${level}: HTTP ${r.status}`);
    return r.json();
  };
  const groups = node => node.standings ? [node] : (node.children || []).flatMap(groups);
  const ranked = es => [...es].sort((a, b) => compareKeys(cfg.sortKey(a), cfg.sortKey(b)));
  const line = (recordText, rank, name, group) => ({
    text: `${recordText ? recordText + ' - ' : ''}${rank} in ${name}`,
    rank, name, link: cfg.standingsUrl + group
  });

  const levels = [];
  for (const level of [1, 2, 3]) levels.push(await get(level)); // one at a time; ESPN throttles bursts
  const [league, conferences, divisions] = levels;
  const result = {};
  const entry = id => (result[id] = result[id] || {});

  for (const g of groups(league)) {
    const sorted = ranked(g.standings.entries);
    sorted.forEach((e, i) => {
      let rank = ordinal(i + 1);
      if (cfg.leagueTiesBy) {
        const v = cfg.leagueTiesBy(e);
        const better = sorted.filter(x => cfg.leagueTiesBy(x) > v).length;
        const tied = sorted.filter(x => cfg.leagueTiesBy(x) === v).length > 1;
        rank = `${tied ? 'T-' : ''}${ordinal(better + 1)}`;
      }
      entry(e.team.id).league = line(cfg.record.league(e), rank, cfg.league, 'league');
    });
  }
  for (const g of groups(conferences)) {
    const sorted = ranked(g.standings.entries);
    sorted.forEach((e, i) => {
      const rank = ordinal(cfg.conferenceRank ? cfg.conferenceRank(e, sorted) : i + 1);
      entry(e.team.id).conference = line(cfg.record.conference(e), rank, cfg.groupName.conference(g), 'conference');
    });
  }
  for (const g of groups(divisions)) {
    ranked(g.standings.entries).forEach((e, i) => {
      entry(e.team.id).division = line(cfg.record.division(e), ordinal(i + 1), cfg.groupName.division(g), 'division');
    });
  }
  return result;
}

// ESPN's NHL standings have no conference record, so count it from the team's
// completed games against teams in the same conference: W-L-OTL.
async function fetchNhlConferenceRecord(team, breakdown) {
  const ourConference = breakdown[String(team.teamId)]?.conference?.name;
  if (!ourConference) return null;
  const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${team.sport}/teams/${team.teamId}/schedule`);
  if (!r.ok) throw new Error(`schedule HTTP ${r.status}`);
  const data = await r.json();
  let w = 0, l = 0, otl = 0;
  for (const e of data.events || []) {
    const c = e.competitions[0];
    if (c.status.type.state !== 'post') continue;
    const us = c.competitors.find(t => String(t.team.id) === String(team.teamId));
    const them = c.competitors.find(t => String(t.team.id) !== String(team.teamId));
    if (!us || !them || breakdown[String(them.team.id)]?.conference?.name !== ourConference) continue;
    if (us.winner) w++;
    else if (/OT|SO/.test(c.status.type.detail || '')) otl++;
    else l++;
  }
  return `(${w}-${l}-${otl})`;
}

async function fetchAllStandings() {
  console.log('\nFetching team standings from ESPN...');
  
  const results = await Promise.all(
    TEAMS.map(team => fetchTeamStandings(team))
  );
  
  const opponents = await fetchUpcomingOpponents();

  // League / conference / division lines for our NBA, NHL and NFL teams
  for (const sport of Object.keys(BREAKDOWN)) {
    try {
      const breakdown = await fetchBreakdown(sport);
      for (const r of results) {
        const b = r && r.sport === sport && breakdown[String(r.teamId)];
        if (b) r.breakdown = [b.league, b.conference, b.division].filter(Boolean);
        if (b && b.conference && sport === 'hockey/nhl') {
          try {
            const confRecord = await fetchNhlConferenceRecord(TEAMS.find(t => t.sport === sport), breakdown);
            if (confRecord) b.conference.text = `${confRecord} - ${b.conference.rank} in ${b.conference.name}`;
          } catch (error) {
            console.error('Could not count NHL conference record:', error.message);
          }
        }
      }
      // NBA: ESPN's summary text is wrong for every team, so save a corrected
      // conference line for all 30 (past and upcoming opponents)
      if (sport === 'basketball/nba') {
        for (const [teamId, b] of Object.entries(breakdown)) {
          if (!b.league || !b.conference) continue;
          const record = `${b.league.text.split(' - ')[0]} - ${b.conference.rank} in ${b.conference.name}`;
          const existing = opponents.find(o => o.sport === sport && String(o.teamId) === teamId);
          if (existing) existing.record = record;
          else opponents.push({ sport, teamId, record });
        }
      }
      console.log(`✓ Built ${BREAKDOWN[sport].league} league/conference/division standings`);
    } catch (error) {
      console.error(`Could not build standings breakdown for ${sport}:`, error.message);
    }
  }
  
  const standingsData = {
    lastUpdated: new Date().toISOString(),
    lastUpdatedMT: new Date().toLocaleString('en-US', { timeZone: 'America/Denver' }),
    teams: results.filter(r => r !== null),
    opponents: opponents
  };
  
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const outputPath = path.join(DATA_DIR, 'standings.json');
  fs.writeFileSync(outputPath, JSON.stringify(standingsData, null, 2));
  
  console.log(`✓ Saved standings to ${outputPath}`);
  
  return standingsData;
}

// ---------------------------------------------------------------------------
// Odds
// ---------------------------------------------------------------------------

// Date and hour in Mountain Time, e.g. { date: '2026-11-26', hour: 8 }
function mountainTime(date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: 'numeric', hourCycle: 'h23'
    }).formatToParts(date).map(p => [p.type, p.value])
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

function readOddsData() {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'odds.json'), 'utf8'));
  } catch {
    return { sports: [] };
  }
}

// Credits left, as of the last fetch. The Odds API resets on the 1st at 00:00 UTC,
// so a value saved in an earlier month no longer applies.
function creditsRemaining(oddsData, now) {
  const quota = oddsData.quota;
  if (!quota || quota.remaining == null) return Infinity;
  const at = new Date(quota.at);
  const sameMonth = at.getUTCFullYear() === now.getUTCFullYear() && at.getUTCMonth() === now.getUTCMonth();
  return sameMonth ? quota.remaining : Infinity;
}

// Decide which leagues to fetch now. Pure function, so it can be tested.
//   games: [{ sportKey, name, start: Date }] upcoming games for our teams
// Returns a Map of sportKey -> reason.
function planOddsFetches(now, oddsData, games, credits) {
  const plan = new Map();
  const fetchedAt = sport => {
    const s = (oddsData.sports || []).find(x => x.sport === sport);
    return s && s.fetchedAt ? new Date(s.fetchedAt) : null;
  };

  // 1. About an hour before each game: once per game, once its start is within the window.
  for (const g of games) {
    const minutesAway = (g.start - now) / 60000;
    if (minutesAway <= 0 || minutesAway > PRE_GAME_WINDOW_MIN) continue;
    const last = fetchedAt(g.sportKey);
    const windowOpened = new Date(g.start.getTime() - PRE_GAME_WINDOW_MIN * 60000);
    if (!last || last < windowOpened) {
      plan.set(g.sportKey, `pre-game: ${g.name} starts in ${Math.round(minutesAway)} min`);
    }
  }

  // 2. Morning refresh: once a day after 8am MT, for leagues with a game in the next week.
  //    Skipped when credits are low so the pre-game fetches still have enough.
  const nowMT = mountainTime(now);
  if (nowMT.hour >= MORNING_HOUR_MT && credits - plan.size > MORNING_RESERVE) {
    const horizon = new Date(now.getTime() + LOOKAHEAD_DAYS * 24 * 3600 * 1000);
    for (const g of games) {
      if (plan.has(g.sportKey) || g.start <= now || g.start > horizon) continue;
      const last = fetchedAt(g.sportKey);
      const lastMT = last && mountainTime(last);
      const doneToday = lastMT && lastMT.date === nowMT.date && lastMT.hour >= MORNING_HOUR_MT;
      if (!doneToday) plan.set(g.sportKey, `morning refresh: next is ${g.name} on ${g.start.toISOString()}`);
    }
  }

  // Never plan more fetches than there are credits for
  return new Map([...plan].slice(0, Math.max(0, Math.min(plan.size, credits))));
}

// Upcoming games for our teams, from ESPN (free)
async function fetchUpcomingGames() {
  const games = [];
  for (const team of TEAMS) {
    try {
      const url = `https://site.api.espn.com/apis/site/v2/sports/${team.sport}/teams/${team.teamId}/schedule`;
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      for (const e of data.events || []) {
        if (e.competitions[0].status.type.state === 'pre') {
          games.push({ sportKey: team.sportKey, name: e.shortName || e.name, start: new Date(e.date) });
        }
      }
    } catch (error) {
      console.error(`Could not load schedule for ${team.name}:`, error.message);
    }
  }
  return games.sort((a, b) => a.start - b.start);
}

// Fetch the given leagues and merge them into odds.json, keeping other leagues as they were
async function fetchOdds(sports, oddsData) {
  if (!API_KEY) {
    throw new Error('ODDS_API_KEY environment variable is not set');
  }
  const now = new Date();
  const results = await Promise.all(sports.map(sport => fetchOddsForSport(sport)));

  oddsData.sports = oddsData.sports || [];
  let remaining = null;
  for (const r of results.filter(Boolean)) {
    const entry = { sport: r.sport, fetchedAt: now.toISOString(), games: r.games };
    const i = oddsData.sports.findIndex(s => s.sport === r.sport);
    if (i >= 0) oddsData.sports[i] = entry; else oddsData.sports.push(entry);
    if (r.remaining != null) remaining = remaining == null ? r.remaining : Math.min(remaining, r.remaining);
  }
  if (remaining != null) oddsData.quota = { remaining, at: now.toISOString() };
  oddsData.lastUpdated = now.toISOString();
  oddsData.lastUpdatedMT = now.toLocaleString('en-US', { timeZone: 'America/Denver' });

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const outputPath = path.join(DATA_DIR, 'odds.json');
  fs.writeFileSync(outputPath, JSON.stringify(oddsData, null, 2));
  console.log(`\n✓ Saved odds to ${outputPath}`);
  return oddsData;
}

// Manual: fetch every league now (4 credits)
async function fetchAllOdds() {
  console.log(`Fetching all leagues. Time: ${new Date().toLocaleString('en-US', { timeZone: 'America/Denver' })} MT`);
  return fetchOdds(SPORTS, readOddsData());
}

// Scheduled (runs hourly): fetch only what's due
async function fetchDueOdds() {
  const now = new Date();
  console.log(`Time: ${now.toLocaleString('en-US', { timeZone: 'America/Denver' })} MT`);
  const oddsData = readOddsData();
  const credits = creditsRemaining(oddsData, now);
  const games = await fetchUpcomingGames();
  const plan = planOddsFetches(now, oddsData, games, credits);

  console.log(`Credits left (as of last fetch): ${credits === Infinity ? 'unknown' : credits}`);
  if (plan.size === 0) {
    console.log('Nothing due. No credits used.');
    return null;
  }
  for (const [sport, reason] of plan) console.log(`→ ${sport}: ${reason}`);
  return fetchOdds([...plan.keys()], oddsData);
}

// Run if called directly
if (require.main === module) {
  const mode = process.argv[2] || 'odds-due'; // 'odds-due', 'odds', or 'standings'

  (async () => {
    try {
      if (mode === 'odds-due') {
        await fetchDueOdds();
      } else if (mode === 'odds') {
        await fetchAllOdds();
      } else if (mode === 'standings') {
        await fetchAllStandings();
      } else {
        throw new Error(`Unknown mode: ${mode}`);
      }
      console.log('\n✓ Complete!');
      process.exit(0);
    } catch (error) {
      console.error('Error:', error);
      process.exit(1);
    }
  })();
}

module.exports = { fetchAllOdds, fetchDueOdds, fetchAllStandings, planOddsFetches, mountainTime, creditsRemaining };
