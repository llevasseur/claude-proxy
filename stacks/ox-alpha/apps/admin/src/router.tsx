import { useEffect, useState } from "react";
import { stringifySearch } from "./car/searchParams";

// Minimal hash router so the dashboard stays dependency-free. Routes live in
// location.hash (#/, #/history, #/trends, #/boat*), which needs no server
// rewrites.

export type RouteName =
  | "overview"
  | "history"
  | "trends"
  | "boat"
  | "boat-messages"
  | "boat-prompt"
  | "boat-tools"
  | "boat-tool-calls"
  | "boat-sessions";

export interface RouteState {
  readonly name: RouteName;
  readonly search: URLSearchParams;
}

const BOAT_PATHS: ReadonlyArray<readonly [string, RouteName]> = Object.freeze([
  ["/boat/messages", "boat-messages"],
  ["/boat/prompt", "boat-prompt"],
  ["/boat/tools", "boat-tools"],
  ["/boat/tool-calls", "boat-tool-calls"],
  ["/boat/sessions", "boat-sessions"],
  ["/boat", "boat"],
]);

function parseHash(hash: string): RouteState {
  const raw = hash.replace(/^#/, "");
  const [path, query = ""] = raw.split("?");
  if (path === "/history") return { name: "history", search: new URLSearchParams(query) };
  if (path === "/trends") return { name: "trends", search: new URLSearchParams(query) };
  for (const [prefix, name] of BOAT_PATHS) {
    if (path === prefix) return { name, search: new URLSearchParams(query) };
  }
  return { name: "overview", search: new URLSearchParams() };
}

export function hashFor(name: RouteName, search: Record<string, unknown>): string {
  if (name === "overview") return "#/";
  const path = name === "boat" ? "/boat" : `/${name.replace("boat-", "boat/")}`;
  return `#${path}${stringifySearch(search)}`;
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
