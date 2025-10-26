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
  fetchAllOdds()
    .then(() => {
      console.log('\n✓ Complete!');
      process.exit(0);
    })
    .catch(error => {
      console.error('Error:', error);
      process.exit(1);
    });
}

module.exports = { fetchAllOdds };
