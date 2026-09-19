import axios from "axios";

/**
 * The parent app's apiService, reduced to what this dashboard uses.
 *
 * There it is a multi-tenant client: it resolves a base URL from the hostname,
 * attaches an auth token, and stamps an X-Site header so the backend picks the
 * right database. None of that applies to a single-tenant dashboard talking to
 * its own server, but the CALL SHAPE is kept exactly — apiService({method,
 * url}) resolving to { data: { data } } — so the copied components work
 * unmodified and can still be diffed against the originals.
 */
const client = axios.create({
  baseURL: import.meta.env.VITE_API_BASE || (import.meta.env.BASE_URL || "/") + "api",
  timeout: 30000,
});

export interface ApiRequest {
  method: "get" | "post" | "put" | "delete";
  url: string;
  data?: unknown;
}

export const apiService = async ({ method, url, data }: ApiRequest) =>
  client.request({ method, url, data });
