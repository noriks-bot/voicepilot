require('dotenv').config();
const KEY = process.env.ELEVENLABS_API_KEY;
(async () => {
  // moji voices v workspace
  const r = await fetch('https://api.elevenlabs.io/v2/voices?page_size=100', { headers: { 'xi-api-key': KEY } });
  console.log('STATUS /v2/voices:', r.status);
  if (!r.ok) { console.log((await r.text()).slice(0,200)); 
    // poskusi v1
    const r1 = await fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': KEY } });
    console.log('STATUS /v1/voices:', r1.status);
    if (r1.ok) { const j=await r1.json(); dump(j.voices); }
    return;
  }
  const j = await r.json();
  dump(j.voices);
})();
function dump(voices){
  console.log('SKUPAJ voices:', voices.length);
  voices.forEach(v => {
    const labels = v.labels || {};
    console.log(`${v.voice_id} | ${v.name} | gender:${labels.gender||'?'} | lang:${labels.language||v.fine_tuning?.language||'?'} | accent:${labels.accent||''} | ${v.category||''}`);
  });
}
