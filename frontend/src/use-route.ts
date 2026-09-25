import { useCallback, useEffect, useState } from "react";
import { parseRouteHash, routeHash, routeUrl, type Route } from "./routes";

export function useAppRoute() {
  const [route, setRoute] = useState<Route>(() => parseRouteHash(window.location.hash));

  useEffect(() => {
    const sync = () => {
      const next = parseRouteHash(window.location.hash);
      setRoute((current) => routeHash(current) === routeHash(next) ? current : next);
    };
    window.addEventListener("popstate", sync);
    window.addEventListener("hashchange", sync);
    sync();
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener("hashchange", sync);
    };
  }, []);

  const navigate = useCallback((next: Route) => {
    if (window.location.hash !== routeHash(next)) {
      window.history.pushState(null, "", routeUrl(next, window.location));
    }
    setRoute((current) => routeHash(current) === routeHash(next) ? current : next);
  }, []);

  return [route, navigate] as const;
}
