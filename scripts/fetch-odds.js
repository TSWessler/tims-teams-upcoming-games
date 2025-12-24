const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const API_KEY = process.env.ODDS_API_KEY || '02a567c1ba7a8bee2b64a26ec76897dc';
const SPORTS = [
  'icehockey_nhl',      // NHL
  'basketball_nba',     // NBA
  'americanfootball_nfl', // NFL
  'americanfootball_ncaaf' // College Football
];

const TEAMS = [
  { name: 'Colorado Avalanche', sport: 'hockey/nhl', teamId: 17, abbr: 'COL' },
  { name: 'Denver Nuggets', sport: 'basketball/nba', teamId: 7, abbr: 'DEN' },
  { name: 'Denver Broncos', sport: 'football/nfl', teamId: 7, abbr: 'DEN' },
  { name: 'Colorado Buffaloes', sport: 'football/college-football', teamId: 38, abbr: 'COLO' }
];

async function fetchOddsForSport(sport) {
  const url = `https://api.the-odds-api.com/v4/sports/${sport}/odds/?apiKey=${API_KEY}&regions=us&markets=h2h&oddsFormat=american`;
  
  try {
    const response = await fetch(url);
    if (!response.ok) {
      console.error(`Error fetching ${sport}: ${response.status} ${response.statusText}`);
      return null;
    }
    const data = await response.json();
    console.log(`✓ Fetched ${data.length} games for ${sport}`);
    return { sport, games: data };
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

async function fetchAllStandings() {
  console.log('\nFetching team standings from ESPN...');
  
  const results = await Promise.all(
    TEAMS.map(team => fetchTeamStandings(team))
  );
  
  const opponents = await fetchUpcomingOpponents();
  
  const standingsData = {
    lastUpdated: new Date().toISOString(),
    lastUpdatedMT: new Date().toLocaleString('en-US', { timeZone: 'America/Denver' }),
    teams: results.filter(r => r !== null),
    opponents: opponents
  };
  
  // Ensure data directory exists
  const dataDir = path.join(__dirname, '..', 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  
  // Write to file
  const outputPath = path.join(dataDir, 'standings.json');
  fs.writeFileSync(outputPath, JSON.stringify(standingsData, null, 2));
  
  console.log(`✓ Saved standings to ${outputPath}`);
  
  return standingsData;
}

async function fetchAllOdds() {
  console.log('Fetching odds from The Odds API...');
  console.log(`Time: ${new Date().toLocaleString('en-US', { timeZone: 'America/Denver' })} MT`);
  
  const results = await Promise.all(
    SPORTS.map(sport => fetchOddsForSport(sport))
  );
  
  const oddsData = {
    lastUpdated: new Date().toISOString(),
    lastUpdatedMT: new Date().toLocaleString('en-US', { timeZone: 'America/Denver' }),
    sports: results.filter(r => r !== null)
  };
  
  // Ensure data directory exists
  const dataDir = path.join(__dirname, '..', 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  
  // Write to file
  const outputPath = path.join(dataDir, 'odds.json');
  fs.writeFileSync(outputPath, JSON.stringify(oddsData, null, 2));
  
  console.log(`\n✓ Saved odds to ${outputPath}`);
  console.log(`Total API calls used: ${SPORTS.length}`);
  
  return oddsData;
}

// Run if called directly
if (require.main === module) {
  const args = process.argv.slice(2);
  const mode = args[0] || 'both'; // 'odds', 'standings', or 'both'
  
  (async () => {
    try {
      if (mode === 'odds') {
        await fetchAllOdds();
      } else if (mode === 'standings') {
        await fetchAllStandings();
      } else {
        await fetchAllOdds();
        await fetchAllStandings();
      }
      console.log('\n✓ Complete!');
      process.exit(0);
    } catch (error) {
      console.error('Error:', error);
      process.exit(1);
    }
  })();
}

module.exports = { fetchAllOdds, fetchAllStandings };
