require('dotenv').config();
const KEY = process.env.ELEVENLABS_API_KEY;
if (!KEY) { console.error('NO KEY'); process.exit(1); }

// jezik -> ElevenLabs language code
const LANGS = { SI:'sl', HR:'hr', CZ:'cs', PL:'pl', GR:'el', IT:'it', HU:'hu', SK:'sk', BG:'bg', RO:'ro' };

async function search(langCode) {
  // Shared voices (Voice Library): filter gender=female + language
  const url = `https://api.elevenlabs.io/v1/shared-voices?gender=female&language=${langCode}&page_size=8`;
  const r = await fetch(url, { headers: { 'xi-api-key': KEY } });
  if (!r.ok) { return { err: `${r.status} ${(await r.text()).slice(0,120)}` }; }
  const j = await r.json();
  return { voices: (j.voices||[]).map(v => ({
    id: v.voice_id, name: v.name, accent: v.accent, age: v.age,
    desc: v.descriptive || v.category, use: v.use_case, lang: v.language,
    cloned: v.cloned_by_count, uses: v.usage_character_count_1y
  })) };
}

(async () => {
  for (const [cc, lc] of Object.entries(LANGS)) {
    const res = await search(lc);
    console.log(`\n===== ${cc} (${lc}) =====`);
    if (res.err) { console.log('  ERR:', res.err); continue; }
    if (!res.voices.length) { console.log('  (0 rezultatov)'); continue; }
    res.voices.slice(0,5).forEach(v => {
      console.log(`  ${v.id} | ${v.name} | ${v.age||''} ${v.accent||''} | ${v.use||''} | ${v.desc||''} | uses:${v.uses||0}`);
    });
  }
})();
