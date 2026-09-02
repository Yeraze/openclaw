/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { createPlugin, createResult } from "./view.test-support.ts";
import { renderYourPlugins, type YourPluginsProps } from "./your-plugins.ts";

function baseProps(overrides: Partial<YourPluginsProps> = {}): YourPluginsProps {
  return {
    connected: true,
    loading: false,
    result: createResult([createPlugin()]),
    error: null,
    expanded: false,
    searchOpen: false,
    query: "",
    busy: {},
    messages: {},
    iconUrls: {},
    canMutate: true,
    mutationBlockedReason: null,
    consent: null,
    consentInspection: null,
    consentInspectionLoading: false,
    consentInspectionError: null,
    onExpandedChange: vi.fn(),
    onSearchOpenChange: vi.fn(),
    onQueryChange: vi.fn(),
    onRefresh: vi.fn(),
    onOpenSettings: vi.fn(),
    onSetEnabled: vi.fn(),
    onIconError: vi.fn(),
    onCancelConsent: vi.fn(),
    onConfirmConsent: vi.fn(),
    onRetryConsentInspection: vi.fn(),
    ...overrides,
  };
}

function mount(props: YourPluginsProps): HTMLDivElement {
  const container = document.createElement("div");
  document.body.append(container);
  render(renderYourPlugins(props), container);
  return container;
}

function visiblePluginIds(container: Element): string[] {
  return [...container.querySelectorAll<HTMLElement>("[data-plugin-id]")].map(
    (card) => card.dataset.pluginId ?? "",
  );
}

describe("renderYourPlugins", () => {
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

  it("prioritizes actionable plugins while keeping search independent from Show all", () => {
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
    const rerender = () => render(renderYourPlugins(props), container);
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

    expect(visiblePluginIds(container)).toHaveLength(12);
    expect(visiblePluginIds(container).slice(0, 5)).toEqual([
      "enabled-a",
      "enabled-b",
      "needs-setup",
      "attention-a",
      "attention-b",
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
    search.value = "disabled 10";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    expect(visiblePluginIds(container)).toEqual(["disabled-10"]);

    searchButton.click();
    expect(container.querySelector('input[type="search"]')).toBeNull();
    expect(visiblePluginIds(container)).toHaveLength(12);

    const showAll = expectDefined(
      [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
        button.textContent?.includes("Show all 16"),
      ),
      "show all button",
    );
    showAll.click();
    expect(visiblePluginIds(container)).toHaveLength(16);
    expect(container.querySelector('input[type="search"]')).toBeNull();

    const back = expectDefined(
      [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
        button.textContent?.includes("Back"),
      ),
      "back button",
    );
    back.click();
    expect(container.querySelector('input[type="search"]')).toBeNull();
    expect(visiblePluginIds(container)).toHaveLength(12);
  });

  it("uses the Carapace surface without repeating an inventory subtitle", () => {
    const container = mount(baseProps());

    expect(container.querySelector(".settings-page.oc-app-surface")).not.toBeNull();
    expect(
      container.querySelector(".your-plugins-card.oc-card.oc-card-interactive"),
    ).not.toBeNull();
    expect(container.querySelector(".your-plugins__header p")).toBeNull();
  });

  it("routes the card and gear to settings while keeping inline toggles and feedback local", () => {
    const onOpenSettings = vi.fn();
    const onSetEnabled = vi.fn();
    const plugins = [
      createPlugin({ id: "successful", name: "Successful" }),
      createPlugin({ id: "failed", name: "Failed", enabled: true, state: "enabled" }),
    ];
    const container = mount(
      baseProps({
        result: createResult(plugins),
        messages: {
          "plugin:successful": { kind: "success", text: "Enabled Successful" },
          "plugin:failed": { kind: "error", text: "Failed to disable Failed" },
        },
        onOpenSettings,
        onSetEnabled,
      }),
    );

    expect(
      container.querySelector('[data-plugin-id="successful"] [role="status"]')?.textContent,
    ).toContain("Enabled Successful");
    expect(
      container.querySelector('[data-plugin-id="failed"] [role="alert"]')?.textContent,
    ).toContain("Failed to disable Failed");

    const successful = expectDefined(
      container.querySelector<HTMLElement>('[data-plugin-id="successful"]'),
      "successful plugin card",
    );
    successful.click();
    expect(onOpenSettings).toHaveBeenCalledWith("successful");

    const toggle = expectDefined(
      successful.querySelector<HTMLElement & { checked: boolean }>("wa-switch"),
      "enable switch",
    );
    toggle.checked = true;
    toggle.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onSetEnabled).toHaveBeenCalledWith("successful", true, "plugin:successful");
    expect(onOpenSettings).toHaveBeenCalledTimes(1);

    const settings = expectDefined(
      container.querySelector<HTMLButtonElement>(
        '.your-plugins__header [aria-label="Plugin settings"]',
      ),
      "settings button",
    );
    settings.click();
    expect(onOpenSettings).toHaveBeenLastCalledWith();
  });

  it("keeps mutation feedback visible beside an unchanged setup state", () => {
    const container = mount(
      baseProps({
        result: createResult([
          createPlugin({ id: "needs-setup", name: "Needs Setup", state: "needs-setup" }),
        ]),
        messages: {
          "plugin:needs-setup": { kind: "error", text: "Enable failed before setup completed" },
        },
      }),
    );

    const card = expectDefined(
      container.querySelector<HTMLElement>('[data-plugin-id="needs-setup"]'),
      "needs-setup plugin card",
    );
    expect(card.textContent).toContain("Setup required");
    expect(card.getAttribute("data-plugin-status")).toBe("needs-setup");
    expect(card.querySelector('[role="alert"]')?.textContent).toContain(
      "Enable failed before setup completed",
    );
  });

  it("keeps setup-required plugins disabled until configuration is complete", async () => {
    const onSetEnabled = vi.fn();
    const container = mount(
      baseProps({
        result: createResult([
          createPlugin({ id: "needs-setup", name: "Needs Setup", state: "needs-setup" }),
        ]),
        onSetEnabled,
      }),
    );
    const toggle = expectDefined(
      container.querySelector<HTMLElement & { checked: boolean }>("wa-switch"),
      "setup-required enable switch",
    );
    const tooltip = expectDefined(
      toggle.closest("openclaw-tooltip") as
        | (HTMLElement & { content?: string; updateComplete: Promise<unknown> })
        | null,
      "setup-required reason tooltip",
    );
    await tooltip.updateComplete;
    expect(tooltip.content).toBe("Configure this plugin before enabling it.");

    toggle.checked = true;
    toggle.dispatchEvent(new Event("change", { bubbles: true }));

    expect(toggle.checked).toBe(false);
    expect(onSetEnabled).not.toHaveBeenCalled();
  });

  it("keeps read-only mutation controls explainable without invoking a mutation or card navigation", async () => {
    const onOpenSettings = vi.fn();
    const onSetEnabled = vi.fn();
    const blockedReason = "Plugin changes require operator.admin access.";
    const container = mount(
      baseProps({
        result: createResult([createPlugin()]),
        canMutate: false,
        mutationBlockedReason: blockedReason,
        onOpenSettings,
        onSetEnabled,
      }),
    );
    const card = expectDefined(
      container.querySelector<HTMLElement>('[data-plugin-id="workboard"]'),
      "workboard plugin card",
    );
    const toggle = expectDefined(
      card.querySelector<HTMLElement & { checked: boolean }>("wa-switch"),
      "read-only enable switch",
    );
    expect(toggle.checked).toBe(false);
    const tooltip = expectDefined(
      toggle.closest("openclaw-tooltip") as
        | (HTMLElement & { content?: string; updateComplete: Promise<unknown> })
        | null,
      "read-only reason tooltip",
    );
    await tooltip.updateComplete;
    expect(tooltip.content).toBe(blockedReason);

    toggle.checked = true;
    toggle.dispatchEvent(new Event("change", { bubbles: true }));
    expect(toggle.checked).toBe(false);
    expect(onSetEnabled).not.toHaveBeenCalled();
    expect(onOpenSettings).not.toHaveBeenCalled();
  });
});
