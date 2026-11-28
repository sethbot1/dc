// Name filter for the leaderboard. Catches slurs and swearing even when people dodge it with
// numbers (n1gg3r), symbols, spaces between letters (f u c k) or stretched letters (niiiigger),
// while letting normal words that happen to contain a bad word through (grape, peacock, Scunthorpe).
"use strict";

// matched anywhere in the name once it's been flattened to plain letters
const BAD = [
  // racist
  "nigg", "nigga", "nigr", "niglet", "negro", "kike", "chink", "gook", "spic", "wetback", "beaner", "coon",
  "paki", "towelhead", "raghead", "sandnig", "jigaboo", "porchmonkey", "junglebunny", "zipperhead", "gypsy", "jap",
  // homophobic / transphobic
  "fag", "dyke", "tranny", "shemale",
  // ableist
  "retard", "spaz", "mong",
  // hate and violence
  "hitler", "nazi", "heil", "kkk", "rape", "rapist", "pedo", "paedo", "molest", "kys", "killyourself", "genocide",
  // swearing and sexual
  "fuck", "fuk", "fck", "phuck", "phuk", "fuq", "fvck", "biatch", "nibba", "niqq", "shit", "bitch", "cunt", "whore", "slut", "porn", "dick", "cock", "pussy", "penis",
  "vagina", "dildo", "jizz", "cum", "anal", "anus", "boob", "tits", "twat", "wank", "bastard", "hentai", "milf",
  "sex", "nude", "horny", "blowjob", "handjob", "asshole", "arse",
];
// same idea, but checked after stretched letters are squashed (niiiigggerrr -> niger)
const BAD_SQUASHED = ["niger", "niga", "nigr", "fagot", "faget", "fuk", "fuc", "shit", "bitch", "cunt", "kike", "retard", "rape", "nazi", "hitler", "porn", "pusy", "dik", "cok", "slut", "whore", "dildo", "jiz"];
// normal words that contain one of the above; they're cut out before checking
const OK = [
  "grape", "drape", "scrape", "trapez", "therapist", "peacock", "hitchcock", "cocktail", "cockpit", "cockatoo",
  "cockatiel", "cockroach", "shuttlecock", "dickens", "benedick", "spice", "spicy", "raccoon", "racoon", "cocoon",
  "tycoon", "scunthorpe", "analys", "analog", "canal", "banal", "torpedo", "speedo", "shiitake", "japan",
  "document", "cucumber", "circum", "cumul", "scum", "accum", "vacuum", "sussex", "essex", "middlesex", "sextant",
  "bastardo", "mongoose", "mongol", "among", "monger", "titan", "title", "titmouse", "constitut", "competit",
  "petit", "appetit", "superstit", "pakistan", "night", "knight", "nigel", "nigeria", "snigger", "heilong",
  "class", "pass", "bass", "mass", "grass", "brass", "glass", "lass", "assassin", "assist", "assets", "assum",
  "sparse", "arsenal", "arsenic", "manslaughter", "wankel", "dickie", "dickson", "hancock", "babcock", "woodcock",
  "gypsum", "skyscraper", "kyshtym", "parapet", "pedometer", "pedomet", "encyclopedia", "speedometer",
  "pedal", "pedest", "boomerang", "booboo",
];

const LEET = { "0": "o", "1": "i", "2": "z", "3": "e", "4": "a", "5": "s", "6": "g", "7": "t", "8": "b", "9": "g", "@": "a", "$": "s", "!": "i", "|": "l", "+": "t" };

function flatten(name) {
  let s = String(name).normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
  s = s.replace(/[0-9@$!|+]/g, c => LEET[c] || c);
  return s.replace(/[^a-z]/g, "");
}
const squash = s => s.replace(/(.)\1+/g, "$1");
const cut = (s, words) => { for (const w of words) s = s.split(w).join("_"); return s; };
const OK_SQUASHED = OK.map(squash);

function isBadName(name) {
  const flat = flatten(name);
  if (BAD.some(w => cut(flat, OK).includes(w))) return true;
  const sq = squash(flat);
  return BAD_SQUASHED.some(w => cut(sq, OK_SQUASHED).includes(w));
}

module.exports = { isBadName };
