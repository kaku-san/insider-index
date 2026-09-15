import { createTopProfilesHandler } from "@/lib/fmp/http";
import { peopleService } from "@/lib/fmp/server";

export const runtime = "nodejs";
export const GET = createTopProfilesHandler(peopleService);
