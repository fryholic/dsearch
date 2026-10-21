import { z } from "zod";
import { API_VERSION, DsearchError, ErrorEnvelope, Identifier, SearchRequest, successEnvelope } from "./index.js";

export const SearchAccepted = z.strictObject({ search_id: Identifier, state: z.literal("queued"),
  status_url: z.string().regex(/^\/v1\/searches\/[A-Za-z0-9_-]+$/),
  events_url: z.string().regex(/^\/v1\/searches\/[A-Za-z0-9_-]+\/events$/) });
export type JsonTransport = (path: string, body: unknown) => Promise<unknown>;

/** Transport injection keeps browser, terminal and fixture clients on the same versioned DTO. */
export function createSearchClient(transport: JsonTransport) {
  return async (input: unknown) => {
    const request = SearchRequest.safeParse(input);
    if (!request.success) throw new DsearchError("INVALID_REQUEST");
    const packet = await transport("/v1/searches", request.data);
    if (!packet || typeof packet !== "object" || !("schema_version" in packet) || packet.schema_version !== API_VERSION)
      throw new DsearchError("UNSUPPORTED_VERSION");
    const error = ErrorEnvelope.safeParse(packet);
    if (error.success) throw new DsearchError(error.data.error.code);
    const response = successEnvelope(SearchAccepted).safeParse(packet);
    if (!response.success) throw new DsearchError("INVALID_REQUEST", "Invalid response envelope");
    return response.data;
  };
}
