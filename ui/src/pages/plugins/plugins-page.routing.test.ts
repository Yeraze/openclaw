/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n, t } from "../../i18n/index.ts";
import {
  createClient,
  createContext,
  createGateway,
  createInspectResult,
  createPlugin,
  createPluginsRouteData,
  createPluginsRouteLocation,
  createResult,
  mountPage,
  resetPluginsPageTestState,
} from "./plugins-page.test-support.ts";
import type { PluginsRouteData } from "./route-data.ts";

function clickHubTab(page: HTMLElement, tab: "plugins" | "skills") {
  page
    .querySelector(`#plugins-tab-${tab}`)
    ?.dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true }));
}

async function switchToSettingsSurface(
  page: HTMLElement & {
    surface: "discovery" | "settings";
    routeData?: PluginsRouteData;
    updateComplete: Promise<boolean>;
  },
  routeData: PluginsRouteData,
) {
  page.surface = "settings";
  page.routeData = { ...routeData };
  await page.updateComplete;
}

describe("PluginsPage routing", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  afterEach(resetPluginsPageTestState);

  it("switches between the Plugins and Skills workspace without reviving catalog tabs", async () => {
    const { client } = createClient(async (method) => {
      if (method === "plugins.catalog.categories") {
        return { categories: [] };
      }
      return method === "plugins.catalog.browse" ? { items: [] } : createResult();
    });
    const harness = createGateway(client);
    const context = createContext(harness.gateway);
    const routeData = createPluginsRouteData(
      harness.gateway,
      createResult(),
      createPluginsRouteLocation("/plugins"),
    );
    const { page } = await mountPage(context, routeData);

    expect(page.querySelector("#plugins-tab-plugins")).not.toBeNull();
    expect(page.querySelector("#plugins-tab-skills")).not.toBeNull();
    expect(page.querySelector("#plugins-tab-installed")).toBeNull();
    expect(page.querySelector("#plugins-tab-discover")).toBeNull();

    clickHubTab(page, "plugins");
    expect(context.navigate).not.toHaveBeenCalled();
    clickHubTab(page, "skills");
    expect(context.navigate).toHaveBeenCalledWith("skills");
  });

  it("keeps the canonical settings inventory at /settings/plugins", async () => {
    const { client } = createClient(async () => createResult());
    const harness = createGateway(client);
    const context = createContext(harness.gateway);
    const routeData = createPluginsRouteData(
      harness.gateway,
      createResult(),
      createPluginsRouteLocation("/settings/plugins"),
    );
    const { page } = await mountPage(context, routeData);
    await switchToSettingsSurface(page, routeData);

    expect(context.replace).not.toHaveBeenCalled();
    expect(page.querySelector('.plugins-settings-search input[type="search"]')).not.toBeNull();
    expect(page.querySelector(".plugins-settings-tabs")?.classList.contains("oc-segmented")).toBe(
      true,
    );
  });

  it.each([
    {
      label: "Settings",
      route: "/settings/plugins/workboard",
      target: "plugin-settings" as const,
      pathname: "/settings/plugins",
      href: "/settings/plugins",
    },
    {
      label: "Plugins",
      route: "/settings/plugins/workboard?from=plugins",
      target: "plugins" as const,
      pathname: "/plugins",
      href: "/plugins",
    },
  ])("opens a settings detail with its $label breadcrumb", async (testCase) => {
    const { client, request } = createClient(async (method) =>
      method === "plugins.inspect" ? createInspectResult() : createResult(),
    );
    const harness = createGateway(client);
    const context = createContext(harness.gateway);
    const routeData = createPluginsRouteData(
      harness.gateway,
      createResult(),
      createPluginsRouteLocation(testCase.route),
    );
    const { page } = await mountPage(context, routeData);
    await switchToSettingsSurface(page, routeData);

    await vi.waitFor(() => {
      expect(page.querySelector("h1")?.textContent).toContain("Workboard");
    });
    expect(request).toHaveBeenCalledWith("plugins.inspect", { pluginId: "workboard" });

    const breadcrumb = page.querySelector<HTMLAnchorElement>(
      ".plugins-settings-breadcrumb__parent",
    );
    expect(breadcrumb?.textContent).toBe(testCase.label);
    expect(breadcrumb?.getAttribute("href")).toBe(testCase.href);
    expect(page.querySelector('[aria-current="page"]')?.textContent).toBe("Workboard");
    const hero = page.querySelector(".plugins-settings-detail-hero");
    expect(hero?.querySelector(".plugins-tile")).not.toBeNull();
    expect(hero?.querySelector("h1")?.textContent).toBe("Workboard");
    expect(hero?.querySelector(".plugins-settings-detail-description")?.textContent).toBe(
      t("subtitles.workboard"),
    );
    expect(hero?.querySelector("wa-switch")).not.toBeNull();
    breadcrumb?.click();
    await page.updateComplete;
    expect(context.navigate).toHaveBeenCalledWith(testCase.target, {
      pathname: testCase.pathname,
    });
  });

  it("explains required setup below the description and blocks enabling", async () => {
    const plugin = createPlugin({
      id: "team-reports",
      name: "Team Reports",
      description: "Daily team activity reports.",
      state: "needs-setup",
    });
    const result = createResult(plugin);
    const { client } = createClient(async (method) =>
      method === "plugins.inspect"
        ? createInspectResult({
            plugin: {
              id: plugin.id,
              name: plugin.name,
              origin: plugin.origin,
              installed: true,
              enabled: false,
            },
          })
        : result,
    );
    const harness = createGateway(client);
    const context = createContext(harness.gateway);
    const routeData = createPluginsRouteData(
      harness.gateway,
      result,
      createPluginsRouteLocation("/settings/plugins/team-reports"),
    );
    const { page } = await mountPage(context, routeData);
    await switchToSettingsSurface(page, routeData);

    await vi.waitFor(() => {
      expect(page.querySelector("h1")?.textContent).toContain("Team Reports");
    });
    const alert = page.querySelector(".plugins-settings-detail-setup");
    expect(alert?.textContent?.trim()).toBe(
      "Additional configuration required before this plugin can be enabled.",
    );
    expect(
      page.querySelector(".plugins-settings-detail-hero + .plugins-settings-detail-setup"),
    ).toBe(alert);
    expect(alert?.classList.contains("warn")).toBe(true);
    expect(alert?.querySelector(".plugins-settings-detail-setup__icon svg")).not.toBeNull();
    expect(page.querySelector(".plugins-settings-detail-actions .settings-status")).toBeNull();
    expect(
      page.querySelector(".plugins-settings-detail-actions wa-switch")?.hasAttribute("disabled"),
    ).toBe(true);
  });
});
