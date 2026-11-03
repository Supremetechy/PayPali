import { SkillMarket } from './SkillMarket';

// ---------------------------------------------------------------------------
// Demo skills for the dev stack (PAYPALI_ALLOW_DEV_SEEDS=1). Data is invented and labelled as such.
//
//   Northwind Streaming (a fictional provider agent)
//     northwind-catalog-search   ACCESS  shows, seasons, episodes                 30 Gas per call
//   Scene Reader agent
//     scene-match                SKILL   ranks episodes against a description      sublicensable, 10% royalty
//   Episode Finder agent
//     find-episode               SKILL   "the episode of <show> where …"           CALLs the catalog, EMBEDs scene-match
// ---------------------------------------------------------------------------

interface Episode { show: string; season: number; episode: number; title: string; synopsis: string; minutes: number }

export const DEMO_CATALOG: Episode[] = [
  { show: 'The Long Orbit', season: 1, episode: 1, title: 'Launch Window', synopsis: 'The crew of the Meridian leaves Earth; Captain Osei hides a damaged heat shield from mission control.', minutes: 52 },
  { show: 'The Long Orbit', season: 1, episode: 2, title: 'Dead Reckoning', synopsis: 'Navigation fails near Mars and the engineer plots a course by hand using the stars.', minutes: 49 },
  { show: 'The Long Orbit', season: 1, episode: 3, title: 'Quiet Hours', synopsis: 'A stowaway cat is found in the cargo bay and the crew votes on whether it can stay.', minutes: 47 },
  { show: 'The Long Orbit', season: 2, episode: 1, title: 'Red Dust', synopsis: 'A dust storm traps two crew members in the rover overnight; they repair the antenna in the morning.', minutes: 55 },
  { show: 'The Long Orbit', season: 2, episode: 2, title: 'Signal', synopsis: 'A repeating radio signal turns out to be an old probe; the captain finally admits the heat shield damage.', minutes: 51 },
  { show: 'Harbor Lights', season: 1, episode: 1, title: 'Low Tide', synopsis: 'A fishing family in a small port town finds a sealed crate washed up on the beach.', minutes: 44 },
  { show: 'Harbor Lights', season: 1, episode: 2, title: 'The Lighthouse Keeper', synopsis: 'The old lighthouse keeper teaches Nia to read the weather from the gulls before a storm.', minutes: 46 },
  { show: 'Harbor Lights', season: 1, episode: 3, title: 'Wedding Boats', synopsis: 'The whole harbor decorates its boats for a wedding, and the storm arrives during the vows.', minutes: 50 },
  { show: 'Kitchen Atlas', season: 1, episode: 1, title: 'Bread of Tbilisi', synopsis: 'Chef Amara bakes shoti bread in a clay oven and learns the family recipe from a street baker.', minutes: 32 },
  { show: 'Kitchen Atlas', season: 1, episode: 2, title: 'Oaxaca Mole', synopsis: 'A three-day mole negro with twenty-six ingredients, and a market tour for chilhuacle chiles.', minutes: 35 },
  { show: 'Kitchen Atlas', season: 1, episode: 3, title: 'Lagos Jollof', synopsis: 'A friendly jollof rice cook-off between two aunties, judged by a table of hungry cousins.', minutes: 33 },
];

const words = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 2);
const STOP = new Set(['the', 'and', 'where', 'with', 'from', 'that', 'this', 'episode', 'one', 'they', 'their', 'what', 'when', 'was', 'for', 'about']);

export function registerDemoSkills(market: SkillMarket) {
  market.registerBuiltin('northwind-catalog-search', async (input) => {
    const show = String(input.show ?? '').toLowerCase().trim();
    const season = input.season === undefined || input.season === '' ? null : Number(input.season);
    const matches = DEMO_CATALOG.filter((e) => (!show || e.show.toLowerCase().includes(show)) && (season == null || e.season === season));
    if (!matches.length) throw new Error('SHOW_NOT_IN_CATALOG');
    return { provider: 'Northwind Streaming (demo data)', episodes: matches.map((e) => ({ ...e, id: `${e.show.toLowerCase().replace(/\W+/g, '-')}-s${e.season}e${e.episode}` })) };
  });

  market.registerBuiltin('scene-match', async (input) => {
    const q = words(String(input.description ?? '')).filter((w) => !STOP.has(w));
    const eps = (Array.isArray(input.episodes) ? input.episodes : []) as Array<Episode & { id?: string }>;
    if (!q.length) throw new Error('DESCRIPTION_REQUIRED');
    const ranked = eps.map((e) => {
      const text = new Set(words(`${e.title} ${e.synopsis}`));
      const hits = q.filter((w) => text.has(w) || [...text].some((t) => t.startsWith(w.slice(0, 5)) && w.length > 4));
      return { e, score: hits.length / q.length, hits };
    }).sort((a, b) => b.score - a.score);
    return { ranked: ranked.map((r) => ({ id: r.e.id, show: r.e.show, season: r.e.season, episode: r.e.episode, title: r.e.title, score: Math.round(r.score * 100) / 100, matched: r.hits })) };
  });

  market.registerBuiltin('find-episode', async (input, ctx) => {
    const show = String(input.show ?? '').trim(), description = String(input.description ?? '').trim();
    const cat = (await ctx.call('northwind-catalog-search', { show })) as { episodes: Array<Episode & { id: string }> };
    const m = (await ctx.embed('scene-match', { description, episodes: cat.episodes })) as { ranked: Array<{ id: string; show: string; season: number; episode: number; title: string; score: number; matched: string[] }> };
    const best = m.ranked[0];
    if (!best || best.score === 0) return { found: false, show, searched: cat.episodes.length, note: 'No episode matches that description.' };
    const ep = cat.episodes.find((e) => e.id === best.id)!;
    return {
      found: true, show: ep.show, season: ep.season, episode: ep.episode, title: ep.title, synopsis: ep.synopsis, minutes: ep.minutes,
      confidence: best.score, matched: best.matched, alternatives: m.ranked.slice(1, 3).filter((r) => r.score > 0).map((r) => `S${r.season}E${r.episode} ${r.title}`),
      source: 'Northwind Streaming catalog (demo data)',
    };
  });
}

/** Seed the demo chain through the same owner acts a person would use. Idempotent per database. */
export async function seedDemoSkills(market: SkillMarket, h: {
  agentFor: (email: string, name: string) => Promise<{ ownerId: string; agentId: string }>;
  signPoa?: (ownerId: string, agentId: string) => Promise<unknown>;
}) {
  if (await market.findSkill('find-episode').then(() => true, () => false)) return;
  const northwind = await h.agentFor('northwind@demo.paypali', 'Northwind Streaming');
  const reader = await h.agentFor('scenes@demo.paypali', 'Scene Reader');
  const finder = await h.agentFor('finder@demo.paypali', 'Episode Finder');
  const show = { type: 'object', required: ['show'], properties: { show: { type: 'string' }, season: { type: 'integer' } } };
  await market.publish(northwind.ownerId, {
    agentId: northwind.agentId, slug: 'northwind-catalog-search', name: 'Northwind catalog search', kind: 'ACCESS', category: 'Streaming', demo: true,
    description: 'Northwind Streaming’s own access skill: every episode of a show (titles, synopses, running times). Demo data.',
    inputSchema: show, executor: 'builtin:northwind-catalog-search', offers: [{ mode: 'PER_CALL', priceGas: 30 }],
  });
  await market.publish(reader.ownerId, {
    agentId: reader.agentId, slug: 'scene-match', name: 'Scene match', category: 'Media analysis', demo: true,
    description: 'Ranks episodes against a plain-language description of a scene. Other agents can build it into their own skills for a 10% royalty.',
    inputSchema: { type: 'object', required: ['description', 'episodes'], properties: { description: { type: 'string' }, episodes: { type: 'array' } } },
    executor: 'builtin:scene-match', offers: [{ mode: 'PER_CALL', priceGas: 40, sublicensable: true, royaltyBps: 1000 }],
  });
  // Episode Finder licenses both, then sells a skill built on them.
  await market.license(finder.agentId, { skill: 'northwind-catalog-search' }, { ownerId: finder.ownerId });
  await market.license(finder.agentId, { skill: 'scene-match' }, { ownerId: finder.ownerId });
  await market.setRateCard(finder.agentId, { maxFeeGas: 100, actFeeGas: 20 }, { ownerId: finder.ownerId });
  await market.publish(finder.ownerId, {
    agentId: finder.agentId, slug: 'find-episode', name: 'Find an episode', category: 'Streaming', demo: true,
    description: 'Finds the episode of a show you describe (“the Long Orbit one where they find a cat”), using Northwind’s catalog and the Scene match skill.',
    inputSchema: { type: 'object', required: ['show', 'description'], properties: { show: { type: 'string' }, description: { type: 'string' } } },
    dependencies: [{ skill: 'northwind-catalog-search', use: 'CALL' }, { skill: 'scene-match', use: 'EMBED' }],
    executor: 'builtin:find-episode',
    offers: [{ mode: 'PER_CALL', priceGas: 100 }, { mode: 'BUNDLE', priceGas: 800, calls: 10 }],
  });
  for (const a of [northwind, reader, finder]) await h.signPoa?.(a.ownerId, a.agentId);
}
