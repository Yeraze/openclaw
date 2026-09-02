// Control UI tests cover plugin catalog browsing and lifecycle mutations.
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PluginsSearchResult } from "../../../../packages/gateway-protocol/src/schema/plugins.ts";
import { PROTOCOL_VERSION } from "../../../../packages/gateway-protocol/src/version.js";
import type {
  PluginCatalogItem,
  PluginListResult,
  PluginMutationResult,
  PluginsInspectResult,
} from "../../lib/plugins/index.ts";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
const updateScreenshots = process.env.OPENCLAW_UPDATE_E2E_SCREENSHOTS === "1";
const artifactDir = path.resolve(process.cwd(), ".artifacts/control-ui-e2e/plugins");
const desktopViewport = { height: 1000, width: 1440 };
const pluginMethods = [
  "plugins.list",
  "plugins.inspect",
  "plugins.search",
  "plugins.install",
  "plugins.setEnabled",
  "plugins.uninstall",
];

const workboardDisabled = {
  id: "workboard",
  name: "Workboard",
  packageName: "@openclaw/workboard",
  description: "Dashboard workboard for agent-owned issues and sessions.",
  version: "2026.7.9",
  kind: ["productivity"],
  origin: "bundled",
  installed: true,
  enabled: false,
  state: "disabled",
  featured: true,
  order: 10,
  category: "tool",
  removable: false,
} satisfies PluginCatalogItem;

const workboardEnabled = {
  ...workboardDisabled,
  enabled: true,
  state: "enabled",
} satisfies PluginCatalogItem;

const lobsterPlugin = {
  id: "lobster",
  name: "Lobster",
  description: "Run typed workflows with resumable approvals.",
  kind: ["plugin"],
  origin: "official",
  installed: false,
  enabled: false,
  state: "not-installed",
  featured: true,
  order: 50,
  install: { source: "clawhub", packageName: "@openclaw/lobster" },
} satisfies PluginCatalogItem;

const remoteIconPlugin = {
  id: "remote-icon",
  name: "FireCrawl",
  description: "Web extraction and crawling.",
  kind: ["plugin"],
  origin: "official",
  installed: false,
  enabled: false,
  state: "not-installed",
  featured: true,
  order: 60,
  hasIcon: true,
  install: { source: "clawhub", packageName: "@openclaw/firecrawl" },
} satisfies PluginCatalogItem;

const calendarPlugin = {
  id: "calendar-plus",
  name: "Calendar Plus",
  packageName: "calendar-plus",
  description: "Plan and coordinate work from a shared calendar.",
  version: "1.2.3",
  kind: ["productivity"],
  origin: "global",
  installed: true,
  enabled: true,
  state: "enabled",
  category: "tool",
  removable: true,
} satisfies PluginCatalogItem;

function installedInventoryPlugin(
  id: string,
  overrides: Partial<PluginCatalogItem> = {},
): PluginCatalogItem {
  return {
    id,
    name: id
      .split("-")
      .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
      .join(" "),
    description: `Operator-visible capability for ${id}.`,
    kind: ["productivity"],
    origin: "bundled",
    installed: true,
    enabled: false,
    state: "disabled",
    category: "tool",
    removable: false,
    ...overrides,
  };
}

const yourPluginsItems = [
  installedInventoryPlugin("attention-b", {
    state: "error",
    error: "Manifest B failed",
    order: 20,
  }),
  installedInventoryPlugin("enabled-b", { enabled: true, state: "enabled", order: 20 }),
  installedInventoryPlugin("needs-setup", { state: "needs-setup", order: 5 }),
  ...Array.from({ length: 11 }, (_, index) =>
    installedInventoryPlugin(
      index === 0 ? "workboard" : `disabled-${String(index).padStart(2, "0")}`,
      {
        ...(index === 0
          ? {
              name: "Workboard",
              description: "Dashboard workboard for agent-owned issues and sessions.",
            }
          : {}),
        order: index,
      },
    ),
  ),
  installedInventoryPlugin("attention-a", {
    state: "error",
    error: "Manifest A failed",
    order: 10,
    category: "internal-category",
  }),
  installedInventoryPlugin("enabled-a", { enabled: true, state: "enabled", order: 10 }),
];

const yourPluginsInventory = inventory(yourPluginsItems);

const initialInventory = inventory([workboardDisabled, lobsterPlugin, remoteIconPlugin]);
const finalInventory = inventory([
  workboardEnabled,
  lobsterPlugin,
  remoteIconPlugin,
  calendarPlugin,
]);

const calendarSearchResponse = {
  results: [
    {
      score: 0.98,
      package: {
        name: "calendar-plus",
        displayName: "Calendar Plus",
        family: "code-plugin",
        channel: "community",
        isOfficial: false,
        summary: "Plan and coordinate work from a shared calendar.",
        latestVersion: "1.2.3",
        downloads: 1420,
        verificationTier: "source-linked",
      },
    },
  ],
} satisfies PluginsSearchResult;

const uninstallResult = {
  ok: true,
  pluginId: "calendar-plus",
  restartRequired: true,
  removed: ["config entry", "install record", "directory"],
};

const installResult = {
  ok: true,
  plugin: calendarPlugin,
  restartRequired: true,
} satisfies PluginMutationResult;

const enableWorkboardResult = {
  ok: true,
  plugin: workboardEnabled,
  restartRequired: false,
} satisfies PluginMutationResult;

const workboardInspection = {
  ok: true,
  reviewToken: "a".repeat(64),
  plugin: {
    id: workboardDisabled.id,
    name: workboardDisabled.name,
    origin: workboardDisabled.origin,
    installed: true,
    enabled: false,
  },
  source: { kind: "npm", packageName: workboardDisabled.packageName },
  declared: {
    channels: [],
    providers: [],
    tools: [],
    contracts: [],
    hooks: [],
    mcpServers: [],
    cliCommands: [],
    cliBackends: [],
    skills: [],
    dangerousConfigFlags: [],
  },
  grants: {
    hooks: {
      allowPromptInjection: { effective: true },
      allowConversationAccess: { effective: true },
    },
  },
} satisfies PluginsInspectResult;

const lobsterInspection = {
  ...workboardInspection,
  reviewToken: "b".repeat(64),
  plugin: {
    id: lobsterPlugin.id,
    name: lobsterPlugin.name,
    origin: lobsterPlugin.origin,
    installed: false,
    enabled: false,
  },
  source: { kind: "npm", packageName: "@openclaw/lobster" },
} satisfies PluginsInspectResult;

const calendarInspection = {
  ...workboardInspection,
  reviewToken: "c".repeat(64),
  plugin: { ...calendarPlugin, installed: false, enabled: false },
  source: { kind: "clawhub", packageName: "calendar-plus" },
  declared: { ...workboardInspection.declared, tools: ["calendar_create"] },
} satisfies PluginsInspectResult;

let browser: Browser;
let server: ControlUiE2eServer;

function inventory(plugins: PluginCatalogItem[]): PluginListResult {
  return { plugins, diagnostics: [], mutationAllowed: true };
}

function configSnapshot(isWorkboardEnabled: boolean) {
  const config = {
    plugins: {
      entries: {
        workboard: { enabled: isWorkboardEnabled },
      },
    },
  };
  return {
    config,
    hash: isWorkboardEnabled ? "plugins-config-enabled" : "plugins-config-disabled",
    issues: [],
    path: "/tmp/openclaw-e2e/openclaw.json",
    raw: JSON.stringify(config, null, 2),
    resolved: config,
    sourceConfig: config,
    valid: true,
  };
}

function readOnlyConnectResponse() {
  return {
    auth: {
      deviceToken: "plugins-read-only-device-token",
      role: "operator",
      scopes: ["operator.read"],
    },
    features: { events: [], methods: pluginMethods },
    controlUiTabs: [],
    protocol: PROTOCOL_VERSION,
    server: { connId: "plugins-read-only", version: "e2e" },
    snapshot: {
      sessionDefaults: {
        defaultAgentId: "main",
        mainKey: "main",
        mainSessionKey: "main",
        scope: "agent",
      },
    },
    type: "hello-ok",
  };
}

async function captureScreenshot(page: Page, name: string): Promise<void> {
  if (!updateScreenshots) {
    return;
  }
  await mkdir(artifactDir, { recursive: true });
  await page.locator(".content").screenshot({
    animations: "disabled",
    caret: "hide",
    path: path.join(artifactDir, name),
  });
}

async function newContext(viewport = desktopViewport): Promise<BrowserContext> {
  return browser.newContext({
    locale: "en-US",
    serviceWorkers: "block",
    viewport,
  });
}

function pluginMethodResponses() {
  return {
    "config.get": configSnapshot(false),
    "plugins.list": initialInventory,
    "plugins.inspect": {
      cases: [
        { match: { pluginId: "workboard" }, response: workboardInspection },
        { match: { pluginId: "lobster" }, response: lobsterInspection },
        { match: { pluginId: "calendar-plus" }, response: calendarInspection },
      ],
    },
    "plugins.search": {
      cases: [
        {
          match: { query: "calendar", limit: 20 },
          response: calendarSearchResponse,
        },
      ],
    },
    "plugins.install": {
      cases: [
        {
          match: {
            source: "clawhub",
            packageName: "calendar-plus",
            acknowledgeCapabilities: { reviewToken: calendarInspection.reviewToken },
          },
          response: installResult,
        },
      ],
    },
    "plugins.setEnabled": {
      cases: [
        {
          match: { pluginId: "workboard", enabled: true },
          response: enableWorkboardResult,
        },
      ],
    },
    "plugins.uninstall": {
      cases: [
        {
          match: { pluginId: "calendar-plus" },
          response: uninstallResult,
        },
      ],
    },
  };
}

describeControlUiE2e("Control UI Plugins mocked Gateway E2E", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(
        `Playwright Chromium is not installed at ${chromiumExecutablePath}. Run \`pnpm --dir ui exec playwright install chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
      );
    }
    if (updateScreenshots) {
      await rm(artifactDir, { force: true, recursive: true });
      await mkdir(artifactDir, { recursive: true });
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("shows a prioritized Your plugins inventory with inline search and settings navigation", async () => {
    const context = await newContext();
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: pluginMethods,
      methodResponses: {
        ...pluginMethodResponses(),
        "plugins.list": yourPluginsInventory,
      },
    });

    try {
      await page.goto(`${server.baseUrl}plugins`);
      await page.getByRole("heading", { name: "Your plugins", exact: true }).waitFor();
      const cards = page.locator(".your-plugins-card");
      expect(await cards.count()).toBe(12);
      expect(
        await cards.evaluateAll((elements) =>
          elements.slice(0, 5).map((card) => card.dataset.pluginId),
        ),
      ).toEqual(["enabled-a", "enabled-b", "needs-setup", "attention-a", "attention-b"]);
      expect(await page.locator('[data-plugin-id="needs-setup"]').textContent()).toContain(
        "Setup required",
      );
      expect(await page.getByRole("searchbox", { name: "Search plugins" }).count()).toBe(0);
      const firstCard = page.locator('[data-plugin-id="attention-a"]');
      expect(await firstCard.locator(".your-plugins-card__identity p").textContent()).toBe(
        "Operator-visible capability for attention-a.",
      );
      expect(await firstCard.textContent()).not.toContain("internal-category");
      const geometry = await firstCard.evaluate((card) => {
        const cardRect = card.getBoundingClientRect();
        return {
          aspectRatio: cardRect.width / cardRect.height,
          cursor: getComputedStyle(card).cursor,
        };
      });
      expect(geometry.aspectRatio).toBeGreaterThan(1.5);
      expect(geometry.cursor).toBe("pointer");
      expect(await firstCard.locator("wa-switch").count()).toBe(0);
      const grid = page.locator(".your-plugins__grid");
      const columnCount = () =>
        grid.evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length);
      expect(await columnCount()).toBe(3);
      await page.setViewportSize({ height: 900, width: 768 });
      expect(await columnCount()).toBe(2);
      await page.setViewportSize({ height: 852, width: 393 });
      expect(await columnCount()).toBe(1);
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) -
              window.innerWidth,
          ),
        )
        .toBeLessThanOrEqual(1);
      await page.setViewportSize(desktopViewport);
      await captureScreenshot(page, "12-your-plugins-desktop.png");

      await page.getByRole("button", { name: "Search plugins", exact: true }).click();
      const search = page.getByRole("searchbox", { name: "Search plugins" });
      await expect
        .poll(() => search.evaluate((element) => element === document.activeElement))
        .toBe(true);
      expect(
        await search
          .locator("xpath=ancestor::*[contains(@class, 'your-plugins__actions')]")
          .count(),
      ).toBe(1);
      await search.fill("Disabled 10");
      expect(await cards.count()).toBe(1);
      expect(await cards.first().getAttribute("data-plugin-id")).toBe("disabled-10");
      await page.getByRole("button", { name: "Close", exact: true }).click();
      expect(await search.count()).toBe(0);
      expect(await cards.count()).toBe(12);

      await page.getByRole("button", { name: "Show all 16", exact: true }).click();
      expect(await cards.count()).toBe(16);
      await page.getByRole("button", { name: "Back", exact: true }).click();
      expect(await cards.count()).toBe(12);

      expect(await gateway.getRequests("plugins.setEnabled")).toEqual([]);
      expect(await gateway.getRequests("plugins.search")).toEqual([]);
      expect(await gateway.getRequests("plugins.install")).toEqual([]);

      await page.getByRole("button", { name: "Plugin settings", exact: true }).click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/plugins");
      await page.goto(`${server.baseUrl}plugins`);
      await page.locator('[data-plugin-id="workboard"]').click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/plugins/workboard");
      expect(new URL(page.url()).search).toBe("?from=plugins");
      await page.goto(`${server.baseUrl}plugins`);
      const openAttentionSettings = page.getByRole("button", {
        name: "Open settings for Attention A",
        exact: true,
      });
      await openAttentionSettings.focus();
      await page.keyboard.press("Enter");
      await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/plugins/attention-a");
    } finally {
      await context.close();
    }
  });

  it("keeps plugin mutations unavailable to read-only operators", async () => {
    const context = await newContext();
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: pluginMethods,
      methodResponses: {
        ...pluginMethodResponses(),
        connect: readOnlyConnectResponse(),
      },
    });

    try {
      await page.goto(`${server.baseUrl}plugins`);
      const discoveryWorkboardCard = page.locator('[data-plugin-id="workboard"]');
      await discoveryWorkboardCard.waitFor({ state: "visible" });
      expect(await discoveryWorkboardCard.locator("wa-switch").count()).toBe(0);
      expect(new URL(page.url()).pathname).toBe("/plugins");
      expect(await gateway.getRequests("plugins.setEnabled")).toEqual([]);
      await discoveryWorkboardCard
        .getByRole("button", { name: "Open settings for Workboard", exact: true })
        .click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/plugins/workboard");
    } finally {
      await context.close();
    }
  });

  it("shows plugin list failures and retries the catalog request", async () => {
    const context = await newContext();
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: pluginMethods,
      methodResponses: pluginMethodResponses(),
    });

    try {
      await page.goto(`${server.baseUrl}settings/plugins`);
      await page.locator('[data-plugin-id="workboard"]').waitFor({ state: "visible" });
      const listCountBeforeFailure = (await gateway.getRequests("plugins.list")).length;
      await gateway.deferNext("plugins.list");
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
      const failedListRequest = await waitForNextRequest(
        gateway,
        "plugins.list",
        listCountBeforeFailure,
      );
      expect(requestParams(failedListRequest)).toEqual({});
      await gateway.rejectDeferred("plugins.list", {
        code: "UNAVAILABLE",
        message: "Plugin inventory unavailable",
        retryable: true,
      });

      const error = page.locator(".plugins-page-error");
      await error.waitFor({ state: "visible" });
      expect(await error.textContent()).toContain("Plugin inventory unavailable");
      const listCountBeforeRetry = (await gateway.getRequests("plugins.list")).length;
      await gateway.deferNext("plugins.list");
      await error.getByRole("button", { name: "Try again" }).click();
      const retryListRequest = await waitForNextRequest(
        gateway,
        "plugins.list",
        listCountBeforeRetry,
      );
      expect(requestParams(retryListRequest)).toEqual({});
      await gateway.resolveDeferred("plugins.list", finalInventory);
      await error.waitFor({ state: "detached" });
      await page
        .locator('[data-plugin-id="workboard"][data-plugin-status="enabled"]')
        .waitFor({ state: "attached" });
    } finally {
      await context.close();
    }
  });
});
