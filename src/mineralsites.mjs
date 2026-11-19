/* ==========================================================================
   pumpbubble.fun — the mines and plants the minerals layer marks

   Hand-kept and short on purpose: only facilities whose role is a matter of
   public record (company filings, government statements), each with the
   operator and one line on why it matters. Positions are the town or the pit
   to a few kilometres — a dot on a world map, not a survey. `m` lists the
   minerals (src/minerals.mjs ids) the site is lit for; `kind` is mine, plant
   (separation, refining or processing) or magnets (magnet making).

   Add a site only with its source in `src`. Nothing here is a ranking.
   ========================================================================== */

export const MINERAL_SITES = [
  { name: 'Bayan Obo', cc: 'CN', lat: 41.78, lon: 109.97, m: ['ree'], kind: 'mine', who: 'China Northern Rare Earth / Baotou Steel',
    what: 'The world’s largest rare-earth mine, mined as a by-product of iron ore since the 1950s.', src: 'https://en.wikipedia.org/wiki/Bayan_Obo_Mining_District' },
  { name: 'Kachin State mines', cc: 'MM', lat: 25.9, lon: 98.4, m: ['ree'], kind: 'mine', who: 'unregulated operators',
    what: 'Ionic-clay mines supplying heavy rare earths (dysprosium, terbium) across the border into China.', src: 'https://en.wikipedia.org/wiki/Rare-earth_element#Myanmar' },
  { name: 'Mountain Pass', cc: 'US', lat: 35.48, lon: -115.53, m: ['ree'], kind: 'mine', who: 'MP Materials (NYSE: MP)',
    what: 'The only scaled rare-earth mine in the Americas; mines and separates on site.', src: 'https://mpmaterials.com/' },
  { name: 'MP Materials magnet plant', cc: 'US', lat: 32.75, lon: -97.33, m: ['ree'], kind: 'magnets', who: 'MP Materials (NYSE: MP)',
    what: 'NdFeB magnet factory in Fort Worth, Texas — a US source of the magnets in motors, robots and drones.', src: 'https://mpmaterials.com/' },
  { name: 'Mount Weld', cc: 'AU', lat: -28.86, lon: 122.55, m: ['ree'], kind: 'mine', who: 'Lynas Rare Earths (ASX: LYC)',
    what: 'One of the richest rare-earth deposits known; concentrate goes to Lynas’s plant in Malaysia.', src: 'https://lynasrareearths.com/' },
  { name: 'Lynas Malaysia', cc: 'MY', lat: 3.97, lon: 103.38, m: ['ree'], kind: 'plant', who: 'Lynas Rare Earths (ASX: LYC)',
    what: 'The largest rare-earth separation plant outside China, in Kuantan.', src: 'https://lynasrareearths.com/' },
  { name: 'Neo magnet plant', cc: 'EE', lat: 59.38, lon: 28.19, m: ['ree'], kind: 'magnets', who: 'Neo Performance Materials (TSX: NEO)',
    what: 'Europe’s first large rare-earth magnet factory, in Narva, Estonia.', src: 'https://www.neomaterials.com/' },
  { name: 'Greenbushes', cc: 'AU', lat: -33.86, lon: 116.06, m: ['li'], kind: 'mine', who: 'Talison (Tianqi, IGO, Albemarle)',
    what: 'The world’s largest hard-rock lithium mine.', src: 'https://en.wikipedia.org/wiki/Greenbushes_mine' },
  { name: 'Salar de Atacama', cc: 'CL', lat: -23.5, lon: -68.25, m: ['li'], kind: 'mine', who: 'SQM, Albemarle',
    what: 'Lithium from brine evaporated in the Atacama desert — the largest brine operation.', src: 'https://en.wikipedia.org/wiki/Salar_de_Atacama' },
  { name: 'Tenke Fungurume', cc: 'CD', lat: -10.6, lon: 26.13, m: ['co', 'cu'], kind: 'mine', who: 'CMOC',
    what: 'One of the largest copper-cobalt mines in the Congo’s Copperbelt.', src: 'https://en.wikipedia.org/wiki/Tenke_Fungurume_Mine' },
  { name: 'Kamoa-Kakula', cc: 'CD', lat: -10.77, lon: 25.27, m: ['cu'], kind: 'mine', who: 'Ivanhoe Mines, Zijin Mining',
    what: 'Among the world’s largest and highest-grade new copper mines.', src: 'https://en.wikipedia.org/wiki/Kamoa-Kakula_Copper_Mine' },
  { name: 'Morowali (IMIP)', cc: 'ID', lat: -2.83, lon: 122.15, m: ['ni', 'co'], kind: 'plant', who: 'Tsingshan and partners',
    what: 'The industrial park behind Indonesia’s rise to most of the world’s nickel.', src: 'https://en.wikipedia.org/wiki/Indonesia_Morowali_Industrial_Park' },
  { name: 'Escondida', cc: 'CL', lat: -24.27, lon: -69.07, m: ['cu'], kind: 'mine', who: 'BHP, Rio Tinto',
    what: 'The world’s largest copper mine by output.', src: 'https://en.wikipedia.org/wiki/Escondida' },
  { name: 'Grasberg', cc: 'ID', lat: -4.05, lon: 137.12, m: ['cu', 'au'], kind: 'mine', who: 'Freeport-McMoRan (NYSE: FCX)',
    what: 'One of the largest copper and gold mines on earth.', src: 'https://en.wikipedia.org/wiki/Grasberg_mine' },
  { name: 'Balama', cc: 'MZ', lat: -13.33, lon: 38.56, m: ['gr'], kind: 'mine', who: 'Syrah Resources (ASX: SYR)',
    what: 'One of the largest natural graphite mines outside China.', src: 'https://www.syrahresources.com.au/' },
  { name: 'Bushveld Complex', cc: 'ZA', lat: -25.67, lon: 27.24, m: ['pt'], kind: 'mine', who: 'Valterra, Impala, Sibanye-Stillwater',
    what: 'Holds most of the world’s platinum-group metals.', src: 'https://en.wikipedia.org/wiki/Bushveld_Igneous_Complex' },
];
