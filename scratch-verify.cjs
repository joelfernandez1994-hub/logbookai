const text = `I was off duty in Gary until about 5:45 this morning. I did my pretrip and rolled out around 6.

I stopped in Joliet around 8:20 for fuel, was on duty there about 20 minutes, then got back on the road.

I made it to Davenport around 11:30, took my 30 off duty, and started rolling again at noon.

Got to Des Moines around 2:45, went on duty to unload and do paperwork for about 30 minutes, then went off duty for about an hour.

Around 4:15 I went back on duty for a quick equipment check, about 15 minutes, then started driving again around 4:30.

Stopped in Omaha around 7 for fuel, was on duty there about 20 minutes, then got back on the road.

I got to Lincoln around 8:15, did a 15-minute post-trip, then went off duty for the night around 8:30.`;

const APPROX_QUALIFIER_RE = /\b(?:about|around|near|roughly|approximately|circa|ish|cerca de|aproximadamente|casi)\s*$/i;
function isApproximateMention(text, matchIndex) {
  const lookback = text.slice(Math.max(0, matchIndex - 20), matchIndex);
  return APPROX_QUALIFIER_RE.test(lookback);
}
const matches = [...text.matchAll(/\b(\d{1,2}):(\d{2})\s*(a\.?m\.?|p\.?m\.?)?\b/gi)];
console.log("total colon-time matches:", matches.length);
for (const m of matches) {
  console.log(JSON.stringify(m[0]), "-> approx?", isApproximateMention(text, m.index), "lookback:", JSON.stringify(text.slice(Math.max(0,m.index-20), m.index)));
}
const filtered = matches.filter(m => !isApproximateMention(text, m.index));
console.log("remaining after filter:", filtered.length, filtered.map(m=>m[0]));
