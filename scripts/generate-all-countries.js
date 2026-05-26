const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const CLEAN_VIDEO = '/home/ec2-user/.openclaw/workspace2/launches/uploads/video-1771855969929.mp4';
const OUTPUT_DIR = '/home/ec2-user/.openclaw/workspace2/launches/uploads/output-final';

const translations = {
  "1": { "HR": "OVO SU NORIKS BOKSERICE", "CZ": "TOHLE JSOU NORIKS BOXERKY", "PL": "TO SĄ BOKSERKI NORIKS", "IT": "QUESTI SONO I BOXER NORIKS", "HU": "EZEK A NORIKS BOXEREK", "SK": "TOTO SÚ NORIKS BOXERKY", "GR": "ΑΥΤΑ ΕΙΝΑΙ ΤΑ ΜΠΟΞΕΡ NORIKS" },
  "2": { "HR": "5 puta mekše od pamuka", "CZ": "5krát měkčí než bavlna", "PL": "5 razy bardziej miękkie niż bawełna", "IT": "5 volte più morbidi del cotone", "HU": "Ötször puhább, mint a pamut", "SK": "5-krát mäkšie ako bavlna", "GR": "5 φορές πιο μαλακά από το βαμβάκι" },
  "3": { "HR": "Udobni cijeli dan", "CZ": "Pohodlné celý den", "PL": "Wygodne przez cały dzień", "IT": "Comodi tutto il giorno", "HU": "Egész nap kényelmes", "SK": "Pohodlné po celý deň", "GR": "Άνετα όλη μέρα" },
  "4": { "HR": "Izrađene od mekog modala", "CZ": "Vyrobeno z jemného modalu", "PL": "Wykonane z miękkiego modalu", "IT": "Realizzati in modal morbido", "HU": "Puha modálból készültek", "SK": "Vyrobené z jemného modalu", "GR": "Κατασκευασμένα από απαλό modal" },
  "5": { "HR": "Kao da ništa ne nosiš", "CZ": "Jako bys nic neměl na sobě", "PL": "Jakbyś nic nie nosił", "IT": "Come non indossare nulla", "HU": "Mintha semmit sem viselnél", "SK": "Ako by si nič nenosil", "GR": "Σαν να μη φοράς τίποτα" },
  "6": { "HR": "Reguliraju tjelesnu temperaturu", "CZ": "Regulují tělesnou teplotu", "PL": "Regulują temperaturę ciała", "IT": "Regolano la temperatura corporea", "HU": "Szabályozzák a testhőmérsékletet", "SK": "Regulujú telesnú teplotu", "GR": "Ρυθμίζουν τη θερμοκρασία του σώματος" },
  "7": { "HR": "Ne skupljaju se", "CZ": "Nesmrštují se", "PL": "Nie kurczą się", "IT": "Non si restringono", "HU": "Nem zsugorodnak", "SK": "Nezrážajú sa", "GR": "Δεν συρρικνώνονται" },
  "8": { "HR": "Ne blijede", "CZ": "Neblednou", "PL": "Nie blakną", "IT": "Non sbiadiscono", "HU": "Nem fakulnak", "SK": "Nevyblednú", "GR": "Δεν ξεθωριάζουν" },
  "9": { "HR": "Veličine S-4XL", "CZ": "Velikosti S-4XL", "PL": "Rozmiary S-4XL", "IT": "Taglie S-4XL", "HU": "Méret: S-4XL", "SK": "Veľkosti S-4XL", "GR": "Μεγέθη S-4XL" },
  "10": { "HR": "UŠTEDITE DO 40%", "CZ": "UŠETŘETE AŽ 40%", "PL": "OSZCZĘDŹ DO 40%", "IT": "RISPARMIA FINO AL 40%", "HU": "SPÓROLJ AKÁR 40%-OT", "SK": "UŠETRITE AŽ 40%", "GR": "ΕΞΟΙΚΟΝΟΜΗΣΕ ΕΩΣ 40%" },
  "11": { "HR": "SAMO OVAJ TJEDAN", "CZ": "POUZE TENTO TÝDEN", "PL": "TYLKO W TYM TYGODNIU", "IT": "SOLO QUESTA SETTIMANA", "HU": "CSAK EZEN A HÉTEN", "SK": "LEN TENTO TÝŽDEŇ", "GR": "ΜΟΝΟ ΑΥΤΗ ΤΗΝ ΕΒΔΟΜΑΔΑ" }
};

const segments = [
  { id: 1, start: "0:00:00.00", end: "0:00:03.00", fontSize: 72 },
  { id: 2, start: "0:00:03.00", end: "0:00:04.50", fontSize: 68 },
  { id: 3, start: "0:00:04.50", end: "0:00:07.00", fontSize: 72 },
  { id: 4, start: "0:00:07.00", end: "0:00:08.50", fontSize: 64 },
  { id: 5, start: "0:00:08.50", end: "0:00:11.00", fontSize: 68 },
  { id: 6, start: "0:00:11.00", end: "0:00:12.50", fontSize: 52 },
  { id: 7, start: "0:00:12.50", end: "0:00:14.50", fontSize: 72 },
  { id: 8, start: "0:00:14.50", end: "0:00:16.50", fontSize: 72 },
  { id: 9, start: "0:00:16.50", end: "0:00:21.50", fontSize: 72 },
  { id: 10, start: "0:00:21.50", end: "0:00:23.50", fontSize: 72, pos: "540,880" },
  { id: 11, start: "0:00:21.50", end: "0:00:23.50", fontSize: 56, pos: "540,1060", style: "black" }
];

const LANGUAGES = ['HR', 'CZ', 'PL', 'GR', 'IT', 'HU', 'SK'];

function generateASS(lang) {
  let ass = `[Script Info]
Title: NORIKS ${lang}
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: WhiteBox,Arial,72,&H00000000,&H000000FF,&H00000000,&H00FFFFFF,-1,0,0,0,100,100,0,0,3,0,0,5,50,50,50,1
Style: BlackBox,Arial,56,&H00FFFFFF,&H000000FF,&H00FFFFFF,&H00000000,-1,0,0,0,100,100,0,0,3,0,0,5,50,50,50,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  segments.forEach(seg => {
    const text = translations[seg.id][lang];
    const style = seg.style === 'black' ? 'BlackBox' : 'WhiteBox';
    const pos = seg.pos ? `\\pos(${seg.pos})` : '';
    const boxColor = seg.style === 'black' ? '\\3c&H000000&\\4c&H000000&' : '\\3c&HFFFFFF&\\4c&HFFFFFF&';
    
    ass += `Dialogue: 0,${seg.start},${seg.end},${style},,0,0,0,,{\\an5\\fad(200,200)${pos}\\bord50\\shad0${boxColor}\\fs${seg.fontSize}}${text}\n`;
  });

  return ass;
}

async function main() {
  console.log('🎬 Generating videos for all 7 countries...\n');
  
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  
  for (const lang of LANGUAGES) {
    console.log(`\n📝 Generating ${lang}...`);
    
    // Generate ASS file
    const assContent = generateASS(lang);
    const assPath = path.join(OUTPUT_DIR, `subs-${lang}.ass`);
    fs.writeFileSync(assPath, assContent);
    console.log(`   ✅ ASS: ${assPath}`);
    
    // Generate video
    const outVideo = path.join(OUTPUT_DIR, `NORIKS-${lang}.mp4`);
    console.log(`   🔄 Encoding video...`);
    
    try {
      execSync(`ffmpeg -y -i "${CLEAN_VIDEO}" -vf "ass='${assPath}'" -c:a copy "${outVideo}" 2>/dev/null`, { stdio: 'pipe' });
      const size = (fs.statSync(outVideo).size / 1024 / 1024).toFixed(1);
      console.log(`   ✅ Video: ${outVideo} (${size} MB)`);
    } catch (e) {
      console.error(`   ❌ Error: ${e.message}`);
    }
  }
  
  console.log('\n🎉 All done!\n');
  console.log('Files:');
  fs.readdirSync(OUTPUT_DIR).filter(f => f.endsWith('.mp4')).forEach(f => {
    console.log(`   📁 ${f}`);
  });
}

main().catch(console.error);
