require('dotenv').config();
const KEY = process.env.ELEVENLABS_API_KEY;
async function tryTTS(id, body){
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${id}`, {
    method:'POST', headers:{'Content-Type':'application/json','xi-api-key':KEY},
    body: JSON.stringify(body)
  });
  const t = r.ok ? `OK ${r.headers.get('content-type')}` : (await r.text()).slice(0,160);
  return `${r.status} ${t}`;
}
(async()=>{
  const id='EXAVITQu4vr4xnSDxMaL'; // Sarah
  console.log('IT +lang:', await tryTTS(id,{text:'Ciao.',model_id:'eleven_multilingual_v2',language_code:'it'}));
  console.log('PL +lang:', await tryTTS(id,{text:'Test.',model_id:'eleven_multilingual_v2',language_code:'pl'}));
  console.log('SL +lang:', await tryTTS(id,{text:'Test.',model_id:'eleven_multilingual_v2',language_code:'sl'}));
  console.log('SL no-lang:', await tryTTS(id,{text:'Test.',model_id:'eleven_multilingual_v2'}));
  console.log('SL v3:', await tryTTS(id,{text:'Test.',model_id:'eleven_v3',language_code:'sl'}));
})();
