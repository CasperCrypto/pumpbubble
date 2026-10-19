/* ==========================================================================
   pumpbubble.fun — where the big clouds' regions and the AI megaprojects are.

   Hand-kept, because nobody publishes this as one open list. Two kinds:

   - METROS: the public cloud regions of AWS, Google Cloud and Microsoft
     Azure, grouped by metro — Northern Virginia is one dot carrying four
     regions, not four dots on top of each other. City-level positions: the
     providers name a metro, never a building. A region is not a promise of
     GPUs; the map calls these "cloud regions".
   - PROJECTS: the AI campuses big enough to be news, with the capacity their
     owners have stated and what independent trackers said about progress
     when this was written (2026-10-18). A capacity nobody stated is null and
     the map says so; a plan is called a plan.

   Add a region when a provider launches one; re-check PROJECTS when you
   touch this file — these move every quarter.
   ========================================================================== */

/* US state names as EIA and Akash's geolocation write them, to USPS codes */
export const US_STATES = {
  Alabama: 'AL', Alaska: 'AK', Arizona: 'AZ', Arkansas: 'AR', California: 'CA', Colorado: 'CO', Connecticut: 'CT', Delaware: 'DE',
  'District of Columbia': 'DC', Florida: 'FL', Georgia: 'GA', Hawaii: 'HI', Idaho: 'ID', Illinois: 'IL', Indiana: 'IN', Iowa: 'IA',
  Kansas: 'KS', Kentucky: 'KY', Louisiana: 'LA', Maine: 'ME', Maryland: 'MD', Massachusetts: 'MA', Michigan: 'MI', Minnesota: 'MN',
  Mississippi: 'MS', Missouri: 'MO', Montana: 'MT', Nebraska: 'NE', Nevada: 'NV', 'New Hampshire': 'NH', 'New Jersey': 'NJ',
  'New Mexico': 'NM', 'New York': 'NY', 'North Carolina': 'NC', 'North Dakota': 'ND', Ohio: 'OH', Oklahoma: 'OK', Oregon: 'OR',
  Pennsylvania: 'PA', 'Rhode Island': 'RI', 'South Carolina': 'SC', 'South Dakota': 'SD', Tennessee: 'TN', Texas: 'TX', Utah: 'UT',
  Vermont: 'VT', Virginia: 'VA', Washington: 'WA', 'West Virginia': 'WV', Wisconsin: 'WI', Wyoming: 'WY',
};

/* [city, country (ISO 3166 alpha-2), US state, lat, lon, regions] */
const M = [
  ['Ashburn, Virginia', 'US', 'VA', 39.04, -77.49, ['AWS us-east-1', 'Google us-east4', 'Azure East US', 'Azure East US 2']],
  ['Columbus, Ohio', 'US', 'OH', 39.96, -83.0, ['AWS us-east-2', 'Google us-east5']],
  ['San Jose, California', 'US', 'CA', 37.34, -121.89, ['AWS us-west-1', 'Azure West US']],
  ['Boardman, Oregon', 'US', 'OR', 45.84, -119.7, ['AWS us-west-2']],
  ['The Dalles, Oregon', 'US', 'OR', 45.6, -121.18, ['Google us-west1']],
  ['Council Bluffs, Iowa', 'US', 'IA', 41.26, -95.86, ['Google us-central1']],
  ['Des Moines, Iowa', 'US', 'IA', 41.59, -93.62, ['Azure Central US']],
  ['Moncks Corner, South Carolina', 'US', 'SC', 33.2, -80.01, ['Google us-east1']],
  ['Dallas, Texas', 'US', 'TX', 32.78, -96.8, ['Google us-south1']],
  ['San Antonio, Texas', 'US', 'TX', 29.42, -98.49, ['Azure South Central US']],
  ['Los Angeles, California', 'US', 'CA', 34.05, -118.24, ['Google us-west2']],
  ['Salt Lake City, Utah', 'US', 'UT', 40.76, -111.89, ['Google us-west3']],
  ['Las Vegas, Nevada', 'US', 'NV', 36.17, -115.14, ['Google us-west4']],
  ['Chicago, Illinois', 'US', 'IL', 41.88, -87.63, ['Azure North Central US']],
  ['Quincy, Washington', 'US', 'WA', 47.23, -119.85, ['Azure West US 2']],
  ['Phoenix, Arizona', 'US', 'AZ', 33.45, -112.07, ['Azure West US 3']],
  ['Montréal', 'CA', '', 45.5, -73.57, ['AWS ca-central-1', 'Google northamerica-northeast1']],
  ['Toronto', 'CA', '', 43.65, -79.38, ['Google northamerica-northeast2', 'Azure Canada Central']],
  ['Québec City', 'CA', '', 46.81, -71.21, ['Azure Canada East']],
  ['Calgary', 'CA', '', 51.05, -114.07, ['AWS ca-west-1']],
  ['Querétaro', 'MX', '', 20.59, -100.39, ['AWS mx-central-1', 'Google northamerica-south1', 'Azure Mexico Central']],
  ['São Paulo', 'BR', '', -23.55, -46.63, ['AWS sa-east-1', 'Google southamerica-east1', 'Azure Brazil South']],
  ['Santiago', 'CL', '', -33.45, -70.67, ['Google southamerica-west1']],
  ['Dublin', 'IE', '', 53.35, -6.26, ['AWS eu-west-1', 'Azure North Europe']],
  ['London', 'GB', '', 51.51, -0.13, ['AWS eu-west-2', 'Google europe-west2', 'Azure UK South']],
  ['Paris', 'FR', '', 48.86, 2.35, ['AWS eu-west-3', 'Google europe-west9', 'Azure France Central']],
  ['Frankfurt', 'DE', '', 50.11, 8.68, ['AWS eu-central-1', 'Google europe-west3', 'Azure Germany West Central']],
  ['Berlin', 'DE', '', 52.52, 13.4, ['Google europe-west10']],
  ['Zurich', 'CH', '', 47.37, 8.54, ['AWS eu-central-2', 'Google europe-west6', 'Azure Switzerland North']],
  ['Stockholm', 'SE', '', 59.33, 18.07, ['AWS eu-north-1', 'Google europe-north2']],
  ['Gävle', 'SE', '', 60.67, 17.14, ['Azure Sweden Central']],
  ['Oslo', 'NO', '', 59.91, 10.75, ['Azure Norway East']],
  ['Hamina', 'FI', '', 60.57, 27.2, ['Google europe-north1']],
  ['Milan', 'IT', '', 45.46, 9.19, ['AWS eu-south-1', 'Google europe-west8', 'Azure Italy North']],
  ['Turin', 'IT', '', 45.07, 7.69, ['Google europe-west12']],
  ['Madrid', 'ES', '', 40.42, -3.7, ['Google europe-southwest1', 'Azure Spain Central']],
  ['Zaragoza (Aragón)', 'ES', '', 41.65, -0.88, ['AWS eu-south-2']],
  ['St. Ghislain', 'BE', '', 50.45, 3.82, ['Google europe-west1']],
  ['Eemshaven', 'NL', '', 53.44, 6.83, ['Google europe-west4']],
  ['Amsterdam', 'NL', '', 52.37, 4.9, ['Azure West Europe']],
  ['Warsaw', 'PL', '', 52.23, 21.01, ['Google europe-central2', 'Azure Poland Central']],
  ['Tel Aviv', 'IL', '', 32.08, 34.78, ['AWS il-central-1', 'Google me-west1', 'Azure Israel Central']],
  ['Bahrain', 'BH', '', 26.07, 50.56, ['AWS me-south-1']],
  ['Dubai', 'AE', '', 25.2, 55.27, ['AWS me-central-1', 'Azure UAE North']],
  ['Doha', 'QA', '', 25.29, 51.53, ['Google me-central1', 'Azure Qatar Central']],
  ['Dammam', 'SA', '', 26.43, 50.1, ['Google me-central2']],
  ['Cape Town', 'ZA', '', -33.92, 18.42, ['AWS af-south-1']],
  ['Johannesburg', 'ZA', '', -26.2, 28.05, ['Google africa-south1', 'Azure South Africa North']],
  ['Mumbai', 'IN', '', 19.08, 72.88, ['AWS ap-south-1', 'Google asia-south1']],
  ['Pune', 'IN', '', 18.52, 73.86, ['Azure Central India']],
  ['Hyderabad', 'IN', '', 17.39, 78.49, ['AWS ap-south-2']],
  ['Delhi', 'IN', '', 28.61, 77.21, ['Google asia-south2']],
  ['Singapore', 'SG', '', 1.35, 103.82, ['AWS ap-southeast-1', 'Google asia-southeast1', 'Azure Southeast Asia']],
  ['Jakarta', 'ID', '', -6.21, 106.85, ['AWS ap-southeast-3', 'Google asia-southeast2', 'Azure Indonesia Central']],
  ['Kuala Lumpur', 'MY', '', 3.14, 101.69, ['AWS ap-southeast-5', 'Azure Malaysia West']],
  ['Bangkok', 'TH', '', 13.76, 100.5, ['AWS ap-southeast-7']],
  ['Hong Kong', 'HK', '', 22.32, 114.17, ['AWS ap-east-1', 'Google asia-east2', 'Azure East Asia']],
  ['Changhua', 'TW', '', 24.08, 120.54, ['Google asia-east1']],
  ['Taipei', 'TW', '', 25.03, 121.57, ['AWS ap-east-2']],
  ['Tokyo', 'JP', '', 35.68, 139.69, ['AWS ap-northeast-1', 'Google asia-northeast1', 'Azure Japan East']],
  ['Osaka', 'JP', '', 34.69, 135.5, ['AWS ap-northeast-3', 'Google asia-northeast2', 'Azure Japan West']],
  ['Seoul', 'KR', '', 37.57, 126.98, ['AWS ap-northeast-2', 'Google asia-northeast3', 'Azure Korea Central']],
  ['Sydney', 'AU', '', -33.87, 151.21, ['AWS ap-southeast-2', 'Google australia-southeast1', 'Azure Australia East']],
  ['Melbourne', 'AU', '', -37.81, 144.96, ['AWS ap-southeast-4', 'Google australia-southeast2']],
  ['Auckland', 'NZ', '', -36.85, 174.76, ['Azure New Zealand North']],
];

export const METROS = M.map(([city, cc, st, lat, lon, regions]) => ({ city, cc, st, lat, lon, regions }));

/* `gw` is the stated target in gigawatts (null when none was stated); `now`
   is the status as reported, in words, because the trackers disagree on the
   running figure. `src` is where the numbers come from. */
export const PROJECTS = [
  { name: 'Stargate Abilene', who: 'OpenAI · Oracle · Crusoe', city: 'Abilene, Texas', cc: 'US', st: 'TX', lat: 32.45, lon: -99.73,
    gw: 1.2, now: 'Partly running; the full 1.2 GW campus is targeted for late 2026', src: 'https://epoch.ai/blog/openai-stargate-where-the-us-sites-stand' },
  { name: 'Colossus', who: 'xAI', city: 'Memphis, Tennessee (and Southaven, Mississippi)', cc: 'US', st: 'TN', lat: 35.06, lon: -90.03,
    gw: 2, now: 'Running and growing; about 2 GW is the stated target for both sites', src: 'https://newsletter.semianalysis.com/p/xais-colossus-2-first-gigawatt-datacenter' },
  { name: 'Project Rainier', who: 'AWS, for Anthropic', city: 'New Carlisle, Indiana', cc: 'US', st: 'IN', lat: 41.7, lon: -86.51,
    gw: 2.2, now: 'Running since 2025 on Trainium chips; 2.2 GW planned across 30 buildings', src: 'https://convergedigest.com/aws-activates-project-rainier-data-center-campus/' },
  { name: 'Hyperion', who: 'Meta', city: 'Richland Parish, Louisiana', cc: 'US', st: 'LA', lat: 32.43, lon: -91.7,
    gw: 2, now: 'Planned: 2 GW by 2030, able to grow to 5 GW', src: 'https://techcrunch.com/2025/07/14/mark-zuckerberg-says-meta-is-building-a-5gw-ai-data-center' },
  { name: 'Prometheus', who: 'Meta', city: 'New Albany, Ohio', cc: 'US', st: 'OH', lat: 40.08, lon: -82.81,
    gw: 1, now: 'A 1 GW cluster planned to come online in 2026', src: 'https://techcrunch.com/2025/07/14/mark-zuckerberg-says-meta-is-building-a-5gw-ai-data-center' },
  { name: 'Fairwater', who: 'Microsoft', city: 'Mount Pleasant, Wisconsin', cc: 'US', st: 'WI', lat: 42.71, lon: -87.9,
    gw: null, now: 'Went live in 2026; NVIDIA GB200 NVL72 racks; no capacity stated', src: 'https://blogs.microsoft.com/on-the-issues/2025/09/18/made-in-wisconsin-the-worlds-most-powerful-ai-datacenter/' },
  { name: 'Fairwater 2', who: 'Microsoft', city: 'Atlanta, Georgia', cc: 'US', st: 'GA', lat: 33.75, lon: -84.39,
    gw: null, now: 'Linked to Wisconsin by its own fiber as one "AI superfactory"; no capacity stated', src: 'https://nationalcioreview.com/articles-insights/extra-bytes/microsoft-builds-worlds-first-ai-superfactory-with-new-atlanta-hub/' },
  { name: 'Stargate UAE', who: 'G42 · OpenAI · Oracle · NVIDIA', city: 'Abu Dhabi', cc: 'AE', st: '', lat: 24.45, lon: 54.38,
    gw: 1, now: 'A 1 GW cluster; the first 200 MW was due in 2026', src: 'https://gulfnews.com/business/markets/stargate-uae-first-phase-of-200mw-to-complete-by-2026-1.500310364' },
  { name: 'Stargate Norway', who: 'Nscale · Aker, for OpenAI', city: 'Narvik', cc: 'NO', st: '', lat: 68.44, lon: 17.43,
    gw: 0.23, now: '230 MW first phase, 290 MW more planned', src: 'https://openai.com/index/introducing-stargate-norway/' },
];
