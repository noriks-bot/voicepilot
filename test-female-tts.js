require('dotenv').config();
const KEY = process.env.ELEVENLABS_API_KEY;
// Znani privzeti ElevenLabs ženski glasovi (public, na vsakem računu)
const FEMALE = {
  'Sarah':'EXAVITQu4vr4xnSDxMaL', 'Laura':'FGY2WhTYpPnrIDTdsKH5',
  'Alice':'Xb7hH8MSUJpSbSDYk0k2', 'Matilda':'XrExE9yKIg1WjnnlVkGX',
  'Jessica':'cgSgspJ2msm6clMCkdW9', 'Lily':'pFZP5JQG7iQjIQuC4Bku',
  'Aria':'9BWtsMINqrJLrRacOk9x', 'Charlotte':'XB0fDUnXU5powFXDhCwa'
};
async function tryTTS(name, id, lang){
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${id}`, {
    method:'POST',
    headers:{'Content-Type':'application/json','xi-api-key':KEY},
    body: JSON.stringify({ text:'Test.', model_id:'eleven_multilingual_v2', language_code:lang })
  });
  return r.status;
}
(async()=>{
  for (const [name,id] of Object.entries(FEMALE)){
    const s = await tryTTS(name,id,'sl');
    console.log(`${name} (${id}): sl -> ${s}`);
  }
})();
