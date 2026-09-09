/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { renderInstalledPlugins, type InstalledPluginsProps } from "./installed-plugins.ts";
import { createPlugin, createResult } from "./plugins-page.test-support.ts";

function baseProps(overrides: Partial<InstalledPluginsProps> = {}): InstalledPluginsProps {
  return {
    connected: true,
    loading: false,
    result: createResult([createPlugin()]),
    error: null,
    expanded: false,
    searchOpen: false,
    query: "",
    iconUrls: {},
    onExpandedChange: vi.fn(),
    onSearchOpenChange: vi.fn(),
    onQueryChange: vi.fn(),
    onRefresh: vi.fn(),
    settingsHref: (pluginId) => `/settings/plugins/${pluginId}?from=plugins`,
    onOpenSettings: vi.fn(),
    onIconError: vi.fn(),
    ...overrides,
  };
}

function mount(props: InstalledPluginsProps): HTMLDivElement {
  const container = document.createElement("div");
  document.body.append(container);
  render(renderInstalledPlugins(props), container);
  return container;
}

function visiblePluginIds(container: Element): string[] {
  return [...container.querySelectorAll<HTMLElement>("[data-plugin-id]")].map(
    (card) => card.dataset.pluginId ?? "",
  );
}

describe("renderInstalledPlugins", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  afterEach(() => {
    for (const container of document.body.querySelectorAll("div")) {
      render(nothing, container);
    }
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("groups each plugin once by its primary category in product order", () => {
    const plugins = [
      createPlugin({ id: "voice", name: "Voice" }),
      createPlugin({ id: "web", name: "Web" }),
      createPlugin({ id: "channel", name: "Channel" }),
      createPlugin({ id: "model", name: "Model" }),
      createPlugin({ id: "memory", name: "Memory" }),
      createPlugin({ id: "context", name: "Context" }),
      createPlugin({ id: "uncategorized", name: "Uncategorized" }),
    ] as Array<ReturnType<typeof createPlugin> & { categories?: string[] }>;
    plugins[0].categories = ["voice"];
    plugins[1].categories = ["web", "channels"];
    plugins[2].categories = ["channels", "web"];
    plugins[3].categories = ["models"];
    plugins[4].categories = ["memory"];
    plugins[5].categories = ["context"];

    const container = mount(baseProps({ result: createResult(plugins) }));
    const groups = [...container.querySelectorAll<HTMLElement>("[data-plugin-category]")];

    expect(groups.map((group) => group.dataset.pluginCategory)).toEqual([
      "channels",
      "models",
      "memory",
      "context",
      "web",
      "voice",
      "uncategorized",
    ]);
    expect(groups.map((group) => group.querySelector("h3")?.textContent?.trim())).toEqual([
      "Channels",
      "Models",
      "Memory",
      "Context",
      "Web",
      "Voice",
      "Uncategorized",
    ]);
    expect(visiblePluginIds(container)).toHaveLength(7);
    expect(
      groups
        .find((group) => group.dataset.pluginCategory === "channels")
        ?.querySelector('[data-plugin-id="channel"]'),
    ).not.toBeNull();
    expect(
      groups
        .find((group) => group.dataset.pluginCategory === "web")
        ?.querySelector('[data-plugin-id="channel"]'),
    ).toBeNull();
  });

  it("matches installed plugins by secondary category", () => {
    const channel = createPlugin({ id: "channel", name: "Channel" }) as ReturnType<
      typeof createPlugin
    > & { categories: string[] };
    channel.categories = ["channels", "web"];
    const model = createPlugin({ id: "model", name: "Model" }) as ReturnType<
      typeof createPlugin
    > & { categories: string[] };
    model.categories = ["models"];

    const container = mount(
      baseProps({
        result: createResult([channel, model]),
        searchOpen: true,
        query: "web",
      }),
    );

    expect(visiblePluginIds(container)).toEqual(["channel"]);
  });

  it("expands every category when any category View all action is activated", () => {
    const plugins = ["channels", "models"].flatMap((category) =>
      Array.from({ length: 5 }, (_, index) => {
        const plugin = createPlugin({
          id: `${category}-${index}`,
          name: `${category} ${index}`,
        }) as ReturnType<typeof createPlugin> & { categories: string[] };
        plugin.categories = [category];
        return plugin;
      }),
    );
    let props = baseProps({ result: createResult(plugins) });
    const container = mount(props);
    const rerender = () => render(renderInstalledPlugins(props), container);
    props = {
      ...props,
      onExpandedChange: (expanded) => {
        props = { ...props, expanded };
        rerender();
      },
    };
    rerender();

    expect(visiblePluginIds(container)).toHaveLength(8);
    const viewAll = [...container.querySelectorAll<HTMLButtonElement>("button")].filter(
      (button) => button.textContent?.trim() === "View all",
    );
    expect(viewAll).toHaveLength(2);

    viewAll[1]?.click();

    expect(visiblePluginIds(container)).toHaveLength(10);
    expect(container.querySelectorAll("[data-plugin-category]")).toHaveLength(2);
    expect(
      [...container.querySelectorAll<HTMLButtonElement>("button")].filter(
        (button) => button.textContent?.trim() === "Hide",
      ),
    ).toHaveLength(2);
  });

  it("retries a failed catalog load without leaving the workspace", () => {
    const onRefresh = vi.fn();
    const container = mount(baseProps({ error: "Catalog unavailable", onRefresh }));

    const alert = expectDefined(container.querySelector('[role="alert"]'), "catalog error");
    expect(alert.textContent).toContain("Catalog unavailable");
    const retry = expectDefined(alert.querySelector<HTMLButtonElement>("button"), "retry button");
    expect(retry.textContent?.trim()).toBe("Try again");

    retry.click();

    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it("prioritizes actionable plugins, then alphabetizes enabled and disabled groups", async () => {
    const plugins = [
      createPlugin({ id: "attention-b", name: "Attention B", state: "error", order: 20 }),
      createPlugin({ id: "needs-setup", name: "Needs Setup", state: "needs-setup", order: 5 }),
      createPlugin({
        id: "enabled-b",
        name: "Enabled B",
        enabled: true,
        state: "enabled",
        order: 20,
      }),
      ...Array.from({ length: 11 }, (_, index) =>
        createPlugin({
          id: `disabled-${String(index).padStart(2, "0")}`,
          name: `Disabled ${String(index).padStart(2, "0")}`,
          order: index,
        }),
      ),
      createPlugin({ id: "attention-a", name: "Attention A", state: "error", order: 10 }),
      createPlugin({
        id: "enabled-a",
        name: "Enabled A",
        enabled: true,
        state: "enabled",
        order: 10,
      }),
      createPlugin({
        id: "not-installed",
        name: "Not Installed",
        installed: false,
        state: "not-installed",
      }),
    ];
    let props = baseProps({ result: createResult(plugins) });
    const container = mount(props);
    const rerender = () => render(renderInstalledPlugins(props), container);
    props = {
      ...props,
      onExpandedChange: (expanded) => {
        props = { ...props, expanded };
        rerender();
      },
      onSearchOpenChange: (searchOpen) => {
        props = { ...props, searchOpen, query: searchOpen ? props.query : "" };
        rerender();
      },
      onQueryChange: (query) => {
        props = { ...props, query };
        rerender();
      },
    };
    rerender();

    expect(visiblePluginIds(container)).toHaveLength(4);
    expect(visiblePluginIds(container)).toEqual([
      "attention-a",
      "attention-b",
      "needs-setup",
      "enabled-a",
    ]);
    expect(container.querySelector('input[type="search"]')).toBeNull();
    expect(container.textContent).not.toContain("Not Installed");

    const searchButton = expectDefined(
      container.querySelector<HTMLButtonElement>('[aria-label="Search plugins"]'),
      "installed search button",
    );
    searchButton.click();
    expect(visiblePluginIds(container)).toHaveLength(16);
    expect(container.textContent).not.toContain("Show all 16");

    const search = expectDefined(
      container.querySelector<HTMLInputElement>('input[type="search"]'),
      "expanded inventory search",
    );
    await Promise.resolve();
    expect(search.closest(".installed-plugins__actions")).not.toBeNull();
    expect(document.activeElement).toBe(search);
    search.value = "disabled 10";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    expect(visiblePluginIds(container)).toEqual(["disabled-10"]);

    const closeSearch = expectDefined(
      container.querySelector<HTMLButtonElement>('.installed-plugins__search [aria-label="Close"]'),
      "close search button",
    );
    closeSearch.click();
    expect(container.querySelector('input[type="search"]')).toBeNull();
    expect(visiblePluginIds(container)).toHaveLength(4);
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Search plugins");

    const showAll = expectDefined(
      [...container.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent?.trim() === "View all",
      ),
      "show all button",
    );
    showAll.click();
    expect(visiblePluginIds(container)).toHaveLength(16);
    expect(container.querySelector('input[type="search"]')).toBeNull();

    const hide = expectDefined(
      [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
        button.textContent?.includes("Hide"),
      ),
      "hide button",
    );
    hide.click();
    expect(container.querySelector('input[type="search"]')).toBeNull();
    expect(visiblePluginIds(container)).toHaveLength(4);
  });

  it("uses Carapace cards without repeating an inventory subtitle", () => {
    const container = mount(baseProps());

    expect(
      container.querySelector(".installed-plugins-card.oc-card.oc-card-interactive"),
    ).not.toBeNull();
    expect(container.querySelector(".installed-plugins__header p")).toBeNull();
    expect(container.querySelector("#installed-plugins-title")?.textContent).toBe(
      "Installed plugins",
    );
  });

  it.each([
    ["offline", { connected: false }, "Connect to browse installed and recommended plugins."],
    ["empty", { result: createResult([]) }, "No optional plugins installed"],
  ])("renders the %s state as plain catalog copy", (_name, overrides, message) => {
    const container = mount(baseProps(overrides));

    const empty = expectDefined(
      container.querySelector<HTMLElement>(".plugin-catalog-results__empty"),
      "installed plugins empty state",
    );
    expect(empty.textContent?.trim()).toBe(message);
    expect(container.querySelector(".settings-empty")).toBeNull();
  });

  it("routes cards and the gear to settings without inline mutation controls or icon tooltips", () => {
    const onOpenSettings = vi.fn();
    const container = mount(
      baseProps({
        result: createResult([createPlugin({ id: "successful", name: "Successful" })]),
        onOpenSettings,
      }),
    );

    const successful = expectDefined(
      container.querySelector<HTMLElement>('[data-plugin-id="successful"]'),
      "successful plugin card",
    );
    successful.click();
    expect(onOpenSettings).toHaveBeenCalledWith("successful");

    expect(successful).toBeInstanceOf(HTMLAnchorElement);
    expect((successful as HTMLAnchorElement).getAttribute("href")).toBe(
      "/settings/plugins/successful?from=plugins",
    );
    expect(successful.querySelector("wa-switch")).toBeNull();

    const settings = expectDefined(
      container.querySelector<HTMLButtonElement>(
        '.installed-plugins__header [aria-label="Plugin settings"]',
      ),
      "settings button",
    );
    const search = expectDefined(
      container.querySelector<HTMLButtonElement>('[aria-label="Search plugins"]'),
      "search button",
    );
    expect(search.hasAttribute("title")).toBe(false);
    expect(settings.hasAttribute("title")).toBe(false);
    settings.click();
    expect(onOpenSettings).toHaveBeenLastCalledWith();
  });

  it("shows every installed state as an accessible title-row notification", () => {
    const container = mount(
      baseProps({
        expanded: true,
        result: createResult([
          createPlugin({ id: "enabled", name: "Enabled plugin", enabled: true, state: "enabled" }),
          createPlugin({ id: "disabled", name: "Disabled plugin", state: "disabled" }),
          createPlugin({ id: "needs-setup", name: "Needs Setup", state: "needs-setup" }),
          createPlugin({ id: "error", name: "Error plugin", state: "error", error: "Broken" }),
        ]),
      }),
    );

    const expected = [
      ["enabled", "Enabled", "settings-status--ok"],
      ["disabled", "Disabled", "settings-status--muted"],
      [
        "needs-setup",
        "Additional configuration required before this plugin can be enabled.",
        "settings-status--warn",
      ],
      ["error", "Needs attention", "settings-status--danger"],
    ] as const;
    for (const [state, label, tone] of expected) {
      const card = expectDefined(
        container.querySelector<HTMLElement>(`[data-plugin-id="${state}"]`),
        `${state} plugin card`,
      );
      const notice = expectDefined(
        card.querySelector<HTMLElement>(".installed-plugins-card__status-notice"),
        `${state} notification`,
      );
      expect(notice.closest(".plugin-card-title-row")).not.toBeNull();
      expect(notice.dataset.pluginState).toBe(state);
      expect(notice.classList.contains(tone)).toBe(true);
      expect(notice.getAttribute("aria-label")).toBe(label);
      expect(notice.getAttribute("title")).toBe(label);
      expect(card.getAttribute("data-plugin-status")).toBe(state);
      expect(card.querySelector("wa-switch")).toBeNull();
    }
  });
});
