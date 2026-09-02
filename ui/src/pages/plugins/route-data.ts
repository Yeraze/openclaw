import type { RouteLocation } from "@openclaw/uirouter";
import {
  INTERNAL_PLUGIN_SETTINGS_PATH_PARAM,
  INTERNAL_PLUGINS_PATH_PARAM,
  pathForRoute,
  restoreBridgedRouteLocation,
} from "../../app-route-paths.ts";

export function pluginsRouteLocation(location: RouteLocation): RouteLocation {
  return restoreBridgedRouteLocation(
    restoreBridgedRouteLocation(location, INTERNAL_PLUGINS_PATH_PARAM),
    INTERNAL_PLUGIN_SETTINGS_PATH_PARAM,
  );
}

export function canonicalPluginsRouteLocation(
  location: RouteLocation,
  basePath = "",
): RouteLocation | null {
  const searchParams = new URLSearchParams(location.search);
  const legacyTab = searchParams.get("tab");
  const hadLegacyTab = searchParams.has("tab");
  searchParams.delete("tab");
  const search = searchParams.toString();
  const settingsPath = pathForRoute("plugin-settings", basePath);
  const isLegacyDiscoverPath = location.pathname === `${settingsPath}/discover`;
  const legacyDiscover = isLegacyDiscoverPath || legacyTab === "discover";
  const canonical: RouteLocation = {
    pathname: legacyDiscover ? pathForRoute("plugins", basePath) : location.pathname,
    search: search ? `?${search}` : "",
    hash: location.hash,
  };
  return hadLegacyTab || isLegacyDiscoverPath ? canonical : null;
}
