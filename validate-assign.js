require('dotenv').config();
const KEY = process.env.ELEVENLABS_API_KEY;
// Predlagana dodelitev raznolikih ženskih glasov per jezik
const ASSIGN = {
  SI: { id:'EXAVITQu4vr4xnSDxMaL', name:'Sarah', model:'eleven_v3' }, // SI rabi v3 kot moški
  HR: { id:'XB0fDUnXU5powFXDhCwa', name:'Charlotte' },
  CZ: { id:'FGY2WhTYpPnrIDTdsKH5', name:'Laura' },
  PL: { id:'Xb7hH8MSUJpSbSDYk0k2', name:'Alice' },
  GR: { id:'XrExE9yKIg1WjnnlVkGX', name:'Matilda' },
  IT: { id:'cgSgspJ2msm6clMCkdW9', name:'Jessica' },
  HU: { id:'EXAVITQu4vr4xnSDxMaL', name:'Sarah', model:'eleven_v3' }, // HU tudi rajši v3/no-lang
  SK: { id:'FGY2WhTYpPnrIDTdsKH5', name:'Laura' },
  BG: { id:'XB0fDUnXU5powFXDhCwa', name:'Charlotte' },
  RO: { id:'cgSgspJ2msm6clMCkdW9', name:'Jessica' },
};
const LANGS = { SI:'sl', HR:'hr', CZ:'cs', PL:'pl', GR:'el', IT:'it', HU:'hu', SK:'sk', BG:'bg', RO:'ro' };
async function tts(id, body){
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${id}`, {
    method:'POST', headers:{'Content-Type':'application/json','xi-api-key':KEY},
    body: JSON.stringify(body)
  });
  return r.status;
}
async function testLang(cfg, lc){
  const attempts = cfg.model
    ? [{model_id:cfg.model,language_code:lc},{model_id:cfg.model},{model_id:'eleven_multilingual_v2',language_code:lc},{model_id:'eleven_multilingual_v2'}]
    : [{model_id:'eleven_multilingual_v2',language_code:lc},{model_id:'eleven_multilingual_v2'},{model_id:'eleven_turbo_v2_5',language_code:lc}];
  for(const a of attempts){
    const s = await tts(cfg.id, {text:'Test test dober dan.', ...a});
    if(s===200) return `OK via ${a.model_id}${a.language_code?'+lang':''}`;
  }
  return 'FAIL';
}
(async()=>{
  for(const [cc,lc] of Object.entries(LANGS)){
    console.log(`${cc} ${ASSIGN[cc].name} (${ASSIGN[cc].id}): ${await testLang(ASSIGN[cc],lc)}`);
  }
})();
