require('dotenv').config();
const KEY = process.env.ELEVENLABS_API_KEY;
// Kandidati: kvalitetni ElevenLabs privzeti ženski glasovi (public, multilingual)
const FEMALE = {
  'Sarah':'EXAVITQu4vr4xnSDxMaL',
  'Laura':'FGY2WhTYpPnrIDTdsKH5',
  'Alice':'Xb7hH8MSUJpSbSDYk0k2',
  'Matilda':'XrExE9yKIg1WjnnlVkGX',
  'Jessica':'cgSgspJ2msm6clMCkdW9',
  'Charlotte':'XB0fDUnXU5powFXDhCwa',
};
// language codes kot v kodi
const LANGS = { SI:'sl', HR:'hr', CZ:'cs', PL:'pl', GR:'el', IT:'it', HU:'hu', SK:'sk', BG:'bg', RO:'ro' };

// Za vsak jezik testiraj EN glas (Sarah) z isto ATTEMPT logiko kot server:
// v2+lang -> v2 -> (SI: v3+lang)
async function tts(id, body){
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${id}`, {
    method:'POST', headers:{'Content-Type':'application/json','xi-api-key':KEY},
    body: JSON.stringify(body)
  });
  return r.status;
}
async function testLang(id, lc){
  // emulira server ATTEMPTS (non-override): v2+lang, v2, turbo+lang
  let s = await tts(id,{text:'Test test.',model_id:'eleven_multilingual_v2',language_code:lc});
  if(s===200) return 'v2+lang';
  s = await tts(id,{text:'Test test.',model_id:'eleven_multilingual_v2'});
  if(s===200) return 'v2';
  s = await tts(id,{text:'Test test.',model_id:'eleven_v3',language_code:lc});
  if(s===200) return 'v3+lang';
  return 'FAIL';
}
(async()=>{
  const id = FEMALE['Sarah'];
  console.log('=== Sarah (EXAVITQu4vr4xnSDxMaL) po jezikih ===');
  for(const [cc,lc] of Object.entries(LANGS)){
    console.log(`  ${cc} (${lc}): ${await testLang(id,lc)}`);
  }
})();
