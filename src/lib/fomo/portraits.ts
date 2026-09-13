const PORTRAITS: Record<string, string> = {
  "insider-0001199036": "/portraits/jensen-huang.jpg",
  "insider-0001214156": "/portraits/tim-cook.jpg",
  "insider-0001494730": "/portraits/kimbal-musk.jpg",
  "insider-0001623824": "/portraits/satya-nadella.jpg",
  "insider-0001548760": "/portraits/mark-zuckerberg.jpg",
  "insider-0001537655": "/portraits/andy-jassy.jpg",
  "insider-0001635575": "/portraits/sundar-pichai.jpg",
  "insider-0001533756": "/portraits/ted-sarandos.jpg",
  "insider-0001463207": "/portraits/brian-armstrong.jpg",
  "insider-0001037443": "/portraits/michael-saylor.png",
  "pol-nancy-pelosi": "/portraits/nancy-pelosi.jpg",
  "pol-ro-khanna": "/portraits/ro-khanna.jpg",
  "pol-josh-gottheimer": "/portraits/josh-gottheimer.jpg",
  "pol-debbie-wasserman-schultz": "/portraits/debbie-wasserman-schultz.jpg",
  "pol-marjorie-taylor-greene": "/portraits/marjorie-taylor-greene.jpg",
  "pol-dan-crenshaw": "/portraits/dan-crenshaw.jpg",
  "pol-michael-mccaul": "/portraits/michael-mccaul.jpg",
  "pol-austin-scott": "/portraits/austin-scott.jpg",
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
