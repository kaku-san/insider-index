import Link from "next/link";
import {PersonAvatar} from "@/components/person-avatar";
import {Sparkline} from "@/components/portfolio-charts";
import {PartyBadge} from "@/components/social/shared";
import {Icon} from "@/components/social/icon";
import type {FomoProfile} from "@/lib/disclosures/types";
import {formatPct} from "@/lib/format";
import {PREVIEW_MODE} from "@/lib/frontend/api";
export function ProfileCard({profile,rank}: {profile:FomoProfile;rank?:number}) {return <Link href={`/p/${encodeURIComponent(profile.id)}`} className="profile-card"><div className="profile-card-top"><PersonAvatar name={profile.name} imageUrl={profile.imageUrl} size="lg"/>{rank?<span className="rank-badge">#{String(rank).padStart(2,"0")}</span>:null}<Icon name="up" size={17} className="card-arrow"/></div><div className="profile-card-name">{profile.name}</div><PartyBadge party={profile.party} kind={profile.kind}/><div className="profile-card-bottom"><div><strong className={profile.copiedPnl90d>=0?"positive":"negative"}>{formatPct(profile.copiedPnl90d)}</strong><span>{PREVIEW_MODE?"Illustrative":"Historical"} · 90d</span></div><Sparkline points={profile.curve} negative={profile.copiedPnl90d<0}/></div></Link>;}
