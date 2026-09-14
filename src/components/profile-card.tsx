import Link from "next/link";
import {PersonAvatar} from "@/components/person-avatar";
import {PartyBadge} from "@/components/social/shared";
import {Icon} from "@/components/social/icon";
import type {FomoProfile} from "@/lib/disclosures/types";
import {formatDate} from "@/lib/format";
export function ProfileCard({profile,rank}: {profile:FomoProfile;rank?:number}) {const tradable=profile.portfolio.filter(h=>h.copyEligible).length;return <Link href={`/p/${encodeURIComponent(profile.id)}`} className="profile-card"><div className="profile-card-top"><PersonAvatar name={profile.name} imageUrl={profile.imageUrl} size="lg"/>{rank?<span className="rank-badge">#{String(rank).padStart(2,"0")}</span>:null}<Icon name="up" size={17} className="card-arrow"/></div><div className="profile-card-name">{profile.name}</div><PartyBadge party={profile.party} kind={profile.kind}/><div className="profile-card-bottom"><div><strong>{profile.portfolio.length} names</strong><span>{tradable} tradable · last filing {formatDate(profile.lastSignalAt)}</span></div></div></Link>;}
