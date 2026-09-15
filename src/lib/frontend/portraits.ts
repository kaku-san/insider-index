// Resolve only portrait assets bundled with InsiderIndex. Keep literal paths so the offline design
// preview can embed exactly the same real portrait files as production.
const portraits:Record<string,string>={
  "nancy-pelosi":"/portraits/nancy-pelosi.jpg",
  "josh-gottheimer":"/portraits/josh-gottheimer.jpg",
  "dan-crenshaw":"/portraits/dan-crenshaw.jpg",
  "marjorie-taylor-greene":"/portraits/marjorie-taylor-greene.jpg",
  "ro-khanna":"/portraits/ro-khanna.jpg",
  "michael-mccaul":"/portraits/michael-mccaul.jpg",
  "austin-scott":"/portraits/austin-scott.jpg",
  "debbie-wasserman-schultz":"/portraits/debbie-wasserman-schultz.jpg",
  "jensen-huang":"/portraits/jensen-huang.jpg",
  "tim-cook":"/portraits/tim-cook.jpg",
  "satya-nadella":"/portraits/satya-nadella.jpg",
  "sundar-pichai":"/portraits/sundar-pichai.jpg",
  "andy-jassy":"/portraits/andy-jassy.jpg",
  "mark-zuckerberg":"/portraits/mark-zuckerberg.jpg",
  "brian-armstrong":"/portraits/brian-armstrong.jpg",
  "ted-sarandos":"/portraits/ted-sarandos.jpg",
  "kimbal-musk":"/portraits/kimbal-musk.jpg",
  "michael-saylor":"/portraits/michael-saylor.png",
};
const aliases:Record<string,string>={P000197:"nancy-pelosi","pol-nancy-pelosi":"nancy-pelosi","idx-nancy-pelosi":"nancy-pelosi"};
export function portraitFor(id:string):string|null{return portraits[aliases[id]??id]??null;}
