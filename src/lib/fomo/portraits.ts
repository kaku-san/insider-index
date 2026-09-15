const PORTRAITS: Record<string, string> = {
  "insider-0001199036": "/portraits/jensen-huang.jpg",
  "jensen-huang": "/portraits/jensen-huang.jpg",
  "insider-0001214156": "/portraits/tim-cook.jpg",
  "tim-cook": "/portraits/tim-cook.jpg",
  "insider-0001494730": "/portraits/kimbal-musk.jpg",
  "kimbal-musk": "/portraits/kimbal-musk.jpg",
  "insider-0001623824": "/portraits/satya-nadella.jpg",
  "satya-nadella": "/portraits/satya-nadella.jpg",
  "insider-0001548760": "/portraits/mark-zuckerberg.jpg",
  "mark-zuckerberg": "/portraits/mark-zuckerberg.jpg",
  "insider-0001537655": "/portraits/andy-jassy.jpg",
  "andy-jassy": "/portraits/andy-jassy.jpg",
  "insider-0001635575": "/portraits/sundar-pichai.jpg",
  "sundar-pichai": "/portraits/sundar-pichai.jpg",
  "insider-0001533756": "/portraits/ted-sarandos.jpg",
  "ted-sarandos": "/portraits/ted-sarandos.jpg",
  "insider-0001463207": "/portraits/brian-armstrong.jpg",
  "brian-armstrong": "/portraits/brian-armstrong.jpg",
  "insider-0001037443": "/portraits/michael-saylor.png",
  "michael-saylor": "/portraits/michael-saylor.png",
  "P000197": "/portraits/nancy-pelosi.jpg",
  "pol-nancy-pelosi": "/portraits/nancy-pelosi.jpg",
  "idx-nancy-pelosi": "/portraits/nancy-pelosi.jpg",
  "nancy-pelosi": "/portraits/nancy-pelosi.jpg",
  "pol-ro-khanna": "/portraits/ro-khanna.jpg",
  "ro-khanna": "/portraits/ro-khanna.jpg",
  "pol-josh-gottheimer": "/portraits/josh-gottheimer.jpg",
  "josh-gottheimer": "/portraits/josh-gottheimer.jpg",
  "pol-debbie-wasserman-schultz": "/portraits/debbie-wasserman-schultz.jpg",
  "debbie-wasserman-schultz": "/portraits/debbie-wasserman-schultz.jpg",
  "pol-marjorie-taylor-greene": "/portraits/marjorie-taylor-greene.jpg",
  "marjorie-taylor-greene": "/portraits/marjorie-taylor-greene.jpg",
  "pol-dan-crenshaw": "/portraits/dan-crenshaw.jpg",
  "dan-crenshaw": "/portraits/dan-crenshaw.jpg",
  "pol-michael-mccaul": "/portraits/michael-mccaul.jpg",
  "michael-mccaul": "/portraits/michael-mccaul.jpg",
  "pol-austin-scott": "/portraits/austin-scott.jpg",
  "austin-scott": "/portraits/austin-scott.jpg",
};

export function portraitFor(profileId: string): string | null {
  return PORTRAITS[profileId] ?? null;
}

export function initialsFor(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}
