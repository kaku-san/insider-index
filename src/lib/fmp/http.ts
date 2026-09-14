import { PeopleError, type PeopleService } from "./service.ts";

const headers = { "Cache-Control": "private, no-store" };
function failure(error: unknown): Response {
  // Never echo an upstream error/cause: providers sometimes include credential-bearing URLs.
  const status = error instanceof PeopleError ? error.status : 502;
  const code = error instanceof PeopleError ? error.code : "fmp-unavailable";
  return Response.json({ source: "fmp", error: code, complete: false, partial: true }, { status, headers });
}
export function createPeopleHandlers(service: PeopleService) {
  return {
    async directory(request: Request): Promise<Response> {
      const q = new URL(request.url).searchParams.get("q")?.trim().toLocaleLowerCase() ?? "";
      if (q.length > 200) return failure(new PeopleError(400, "query-too-long"));
      try {
        const result = await service.directory();
        const people = result.people.filter((p) => !q || `${p.id} ${p.name} ${p.state ?? ""} ${p.party ?? ""}`.toLocaleLowerCase().includes(q));
        return Response.json({ ...result, people, count: people.length, total: result.people.length }, { headers });
      } catch (error) { return failure(error); }
    },
    async portfolio(_request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
      try { return Response.json(await service.portfolio((await context.params).id), { headers }); }
      catch (error) { return failure(error); }
    },
  };
}
