import { useEffect, useState } from "react";
import { stringifySearch } from "./car/searchParams";

// Minimal hash router so the dashboard stays dependency-free. Routes live in
// location.hash (#/, #/history, #/trends), which needs no server rewrites.

export type RouteName = "overview" | "history" | "trends";

export interface RouteState {
  readonly name: RouteName;
  readonly search: URLSearchParams;
}

function parseHash(hash: string): RouteState {
  const raw = hash.replace(/^#/, "");
  const [path, query = ""] = raw.split("?");
  if (path === "/history") return { name: "history", search: new URLSearchParams(query) };
  if (path === "/trends") return { name: "trends", search: new URLSearchParams(query) };
  return { name: "overview", search: new URLSearchParams() };
}

export function hashFor(name: RouteName, search: Record<string, unknown>): string {
  return `#${name === "overview" ? "/" : `/${name}${stringifySearch(search)}`}`;
}

export function useRoute(): RouteState {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  useEffect(() => {
    const apply = () => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", apply);
    return () => window.removeEventListener("hashchange", apply);
  }, []);
  return route;
}
