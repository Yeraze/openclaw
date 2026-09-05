// Plugin-catalog fixtures for the Control UI mock dev harness.
import { createHash } from "node:crypto";
import type {
  PluginCatalogEntry,
  PluginDeclaredSurface,
  PluginsCatalogBrowseResult,
  PluginsInspectResult,
} from "../packages/gateway-protocol/src/schema/plugins.js";
import type { ControlUiMockGateway } from "../ui/src/test-helpers/control-ui-e2e.ts";

export type PluginCatalogMockOptions = {
  installedCopies?: number;
};

export function buildPluginDiscoveryMock(): PluginsCatalogBrowseResult {
  const entry = (params: {
    packageName: string;
    name: string;
    summary: string;
    author: string;
    official: boolean;
    downloads: number;
    pluginId?: string;
    enabled?: boolean;
  }): PluginsCatalogBrowseResult["items"][number] => ({
    id: `ch_${Buffer.from(params.packageName, "utf8").toString("base64url")}`,
    catalog: {
      name: params.name,
      summary: params.summary,
      family: "code-plugin",
      author: params.author,
      official: params.official,
      categories: [],
      downloads: params.downloads,
    },
    local: params.pluginId
      ? {
          present: true,
          installed: true,
          enabled: params.enabled ?? true,
          state: (params.enabled ?? true) ? "enabled" : "disabled",
          pluginId: params.pluginId,
          action: "manage",
        }
      : {
          present: false,
          installed: false,
          enabled: false,
          state: "not-installed",
          action: "install",
        },
  });

  return {
    items: [
      entry({
        packageName: "@openclaw/whatsapp",
        name: "WhatsApp",
        summary: "OpenClaw WhatsApp channel plugin for WhatsApp Web chats.",
        author: "openclaw",
        official: true,
        downloads: 176_431,
        pluginId: "whatsapp",
      }),
      entry({
        packageName: "@openclaw/matrix",
        name: "Matrix",
        summary: "OpenClaw Matrix channel plugin for rooms and direct messages.",
        author: "openclaw",
        official: true,
        downloads: 52_201,
      }),
      entry({
        packageName: "@openclaw/codex",
        name: "Codex",
        summary: "OpenClaw Codex app-server harness and native session supervision plugin.",
        author: "openclaw",
        official: true,
        downloads: 36_956,
      }),
      entry({
        packageName: "@gendigital/sage-openclaw",
        name: "Gen Sage",
        summary: "Safety for Agents — ADR layer for OpenClaw.",
        author: "gendigital",
        official: false,
        downloads: 19_609,
      }),
      entry({
        packageName: "@openclaw/discord",
        name: "Discord",
        summary: "OpenClaw Discord channel plugin for channels, DMs, commands, and app events.",
        author: "openclaw",
        official: true,
        downloads: 13_253,
        pluginId: "discord",
        enabled: false,
      }),
      entry({
        packageName: "@openclaw/deepseek-provider",
        name: "OpenClaw DeepSeek Provider",
        summary: "OpenClaw DeepSeek provider plugin.",
        author: "openclaw",
        official: true,
        downloads: 10_742,
      }),
    ],
  };
}

export function buildPluginCatalogMock(options: PluginCatalogMockOptions = {}) {
  const entry = (params: {
    id: string;
    name: string;
    description: string;
    category: string;
    origin: string;
    installed: boolean;
    enabled?: boolean;
    featured?: boolean;
    hasIcon?: boolean;
    install?: { source: "official"; pluginId: string };
  }): PluginCatalogEntry => ({
    id: params.id,
    name: params.name,
    description: params.description,
    version: "1.4.0",
    origin: params.origin,
    installed: params.installed,
    enabled: params.installed && (params.enabled ?? true),
    state: params.installed ? ((params.enabled ?? true) ? "enabled" : "disabled") : "not-installed",
    category: params.category,
    featured: params.featured ?? false,
    removable: params.installed && params.origin !== "bundled",
    ...(params.hasIcon ? { hasIcon: true } : {}),
    ...(params.install ? { install: params.install } : {}),
  });
  const plugins = [
    entry({
      id: "whatsapp",
      name: "WhatsApp",
      description: "OpenClaw WhatsApp channel plugin for WhatsApp Web chats.",
      category: "channel",
      origin: "bundled",
      installed: true,
      hasIcon: true,
    }),
    entry({
      id: "telegram",
      name: "Telegram",
      description: "OpenClaw Telegram channel plugin.",
      category: "channel",
      origin: "bundled",
      installed: true,
      hasIcon: true,
    }),
    entry({
      id: "discord",
      name: "Discord",
      description: "Bridge agents into Discord servers and DMs.",
      category: "channel",
      origin: "global",
      installed: true,
      enabled: false,
      hasIcon: true,
    }),
    entry({
      id: "googlechat",
      name: "Google Chat",
      description: "OpenClaw Google Chat channel plugin for spaces and direct messages.",
      category: "channel",
      origin: "bundled",
      installed: true,
      hasIcon: true,
    }),
    entry({
      id: "slack",
      name: "Slack",
      description: "OpenClaw Slack channel plugin for channels, DMs, commands, and app events.",
      category: "channel",
      origin: "bundled",
      installed: true,
      hasIcon: true,
    }),
    entry({
      id: "signal",
      name: "Signal",
      description: "OpenClaw Signal channel plugin.",
      category: "channel",
      origin: "bundled",
      installed: true,
      hasIcon: true,
    }),
    entry({
      id: "imessage",
      name: "iMessage",
      description: "OpenClaw iMessage channel plugin using imsg on a signed-in Mac.",
      category: "channel",
      origin: "bundled",
      installed: true,
      hasIcon: true,
    }),
    entry({
      id: "nostr",
      name: "Nostr",
      description: "OpenClaw Nostr channel plugin for NIP-04 encrypted direct messages.",
      category: "channel",
      origin: "bundled",
      installed: true,
      hasIcon: true,
    }),
    entry({
      id: "memory-wiki",
      name: "Memory Wiki",
      description: "Long-term wiki-style memory for people and projects.",
      category: "memory",
      origin: "bundled",
      installed: true,
    }),
    entry({
      id: "browser",
      name: "Browser",
      description: "Drive a managed browser profile for research and automation.",
      category: "tool",
      origin: "official",
      installed: false,
      featured: true,
      install: { source: "official", pluginId: "browser" },
    }),
    entry({
      id: "canvas",
      name: "Canvas",
      description: "Generate and preview visual artifacts from sessions.",
      category: "tool",
      origin: "official",
      installed: false,
      install: { source: "official", pluginId: "canvas" },
    }),
  ];
  const installedCopies = Math.max(1, Math.floor(options.installedCopies ?? 1));
  const installed = plugins.filter((plugin) => plugin.installed);
  const available = plugins.filter((plugin) => !plugin.installed);
  return {
    plugins: [
      ...installed.flatMap((plugin) =>
        Array.from({ length: installedCopies }, (_, index) =>
          index === 0 ? plugin : { ...plugin, id: `${plugin.id}-copy-${index + 1}` },
        ),
      ),
      ...available,
    ],
    diagnostics: [],
    mutationAllowed: true,
  };
}

/** Parameterized plugins.inspect fixtures for the consent dialog and detail overlay. */
export function buildPluginInspectMock(options: PluginCatalogMockOptions = {}) {
  const emptyDeclared: PluginDeclaredSurface = {
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
  };
  const fixtures = new Map<
    string,
    {
      source: NonNullable<PluginsInspectResult["source"]>;
      declared: Partial<PluginDeclaredSurface>;
      trust?: PluginsInspectResult["trust"];
    }
  >([
    ["whatsapp", { source: { kind: "bundled" }, declared: { channels: ["whatsapp"] } }],
    [
      "telegram",
      {
        source: { kind: "bundled" },
        declared: { channels: ["telegram"], cliCommands: ["telegram"] },
      },
    ],
    ["googlechat", { source: { kind: "bundled" }, declared: { channels: ["googlechat"] } }],
    ["slack", { source: { kind: "bundled" }, declared: { channels: ["slack"] } }],
    ["signal", { source: { kind: "bundled" }, declared: { channels: ["signal"] } }],
    ["imessage", { source: { kind: "bundled" }, declared: { channels: ["imessage"] } }],
    ["nostr", { source: { kind: "bundled" }, declared: { channels: ["nostr"] } }],
    [
      "discord",
      {
        source: {
          kind: "npm",
          spec: "@openclaw/discord@1.4.0",
          packageName: "@openclaw/discord",
          integrity: "sha512-Zt8FjB1uT0mMyF5b0z0aH4dKq7wVn0m8rW3o5cQx1JYb1sB4kQ2u5w9c1p6nEo3q",
          integrityKind: "ssri",
        },
        declared: {
          channels: ["discord"],
          providers: ["discord-intelligence"],
          tools: ["discord_actions", "discord_moderate"],
          contracts: ["tools: discord_actions", "tools: discord_moderate"],
          skills: ["discord"],
        },
        trust: { disposition: "clean", checkedAt: "2026-08-20T14:03:00Z" },
      },
    ],
    [
      "memory-wiki",
      { source: { kind: "bundled" }, declared: { tools: ["memory_search", "memory_write"] } },
    ],
    [
      "browser",
      {
        source: {
          kind: "official-catalog",
          spec: "clawhub:openclaw/browser@1.4.0",
          packageName: "openclaw/browser",
          integrity: "2f7c1a9be03d5c44a8a14a4e9d0d5375f4f3f0f5f7f1b9f2c3d4e5f60718293a",
          integrityKind: "sha256",
        },
        declared: {
          tools: ["browser_click", "browser_navigate", "browser_screenshot"],
          cliCommands: ["browser"],
          dangerousConfigFlags: ["allowHostControl"],
        },
        trust: { disposition: "clean", checkedAt: "2026-08-22T09:41:00Z" },
      },
    ],
    [
      "canvas",
      {
        source: { kind: "official-catalog", packageName: "openclaw/canvas" },
        declared: { tools: ["canvas_render"] },
      },
    ],
  ]);
  const cases = buildPluginCatalogMock(options).plugins.map((plugin) => {
    const fixtureId = plugin.id.replace(/-copy-\d+$/u, "");
    const fixture = fixtures.get(fixtureId);
    if (!fixture) {
      throw new Error(`Mock inspection is missing for plugin "${plugin.id}".`);
    }
    const declared = { ...emptyDeclared, ...fixture.declared };
    const response = {
      ok: true,
      plugin: {
        id: plugin.id,
        name: plugin.name,
        version: plugin.version,
        description: plugin.description,
        origin: plugin.origin,
        installed: plugin.installed,
        enabled: plugin.enabled,
      },
      source: fixture.source,
      declared,
      reviewToken: createHash("sha256").update(JSON.stringify(declared)).digest("hex"),
      grants: {
        hooks: {
          allowPromptInjection: { effective: true },
          allowConversationAccess: { effective: plugin.origin === "bundled" },
        },
      },
      ...(fixture.trust ? { trust: fixture.trust } : {}),
    } satisfies PluginsInspectResult;
    return { match: { pluginId: plugin.id }, response };
  });
  return { cases };
}

function installPluginLifecycleMock(
  catalog: ReturnType<typeof buildPluginCatalogMock>,
  inspections: ReturnType<typeof buildPluginInspectMock>,
): void {
  const gateway = (window as Window & { openclawControlUiE2eGateway?: ControlUiMockGateway })
    .openclawControlUiE2eGateway;
  if (!gateway) {
    return;
  }
  const plugins = new Map(catalog.plugins.map((plugin) => [plugin.id, plugin]));
  const details = new Map(inspections.cases.map((entry) => [entry.match.pluginId, entry.response]));
  let discordConsented = false;
  gateway.setRequestHandler("plugins.search", ({ params, respond }) => {
    const query = ((params as { query?: string }).query ?? "").toLowerCase();
    respond({
      results: catalog.plugins
        .filter((plugin) => plugin.install && plugin.name.toLowerCase().includes(query))
        .map((plugin) => ({
          score: 1,
          package: {
            name: `openclaw/${plugin.id}`,
            displayName: plugin.name,
            family: "code-plugin",
            channel: "official",
            isOfficial: true,
            runtimeId: plugin.id,
            summary: plugin.description,
          },
        })),
    });
  });
  gateway.setRequestHandler("plugins.list", ({ respond }) => {
    respond({ ...catalog, plugins: [...plugins.values()] });
  });
  for (const method of [
    "plugins.inspect",
    "plugins.install",
    "plugins.setEnabled",
    "plugins.uninstall",
  ]) {
    gateway.setRequestHandler(method, ({ params: input, respond }) => {
      const params = (input ?? {}) as {
        pluginId?: string;
        source?: string;
        packageName?: string;
        enabled?: boolean;
        acknowledgeCapabilities?: { reviewToken?: string };
      };
      const plugin =
        params.source === "clawhub"
          ? [...plugins.values()].find(
              (entry) => entry.install && `openclaw/${entry.id}` === params.packageName,
            )
          : params.pluginId
            ? plugins.get(params.pluginId)
            : undefined;
      const inspection = plugin ? details.get(plugin.id) : undefined;
      const reject = (message: string) =>
        respond({ __mockError: { code: "INVALID_REQUEST", message } });
      if (!plugin || !inspection) {
        reject("Unknown mock plugin; refresh the plugin catalog.");
        return;
      }
      if (method === "plugins.inspect") {
        respond({
          ...inspection,
          plugin: { ...inspection.plugin, installed: plugin.installed, enabled: plugin.enabled },
        });
        return;
      }
      if (method === "plugins.install") {
        if ((params.source !== "official" && params.source !== "clawhub") || !plugin.install) {
          reject("This mock plugin has no official install action.");
          return;
        }
        Object.assign(plugin, {
          installed: true,
          enabled: true,
          state: "enabled",
          removable: true,
        });
      } else if (method === "plugins.setEnabled") {
        if (!plugin.installed || typeof params.enabled !== "boolean") {
          reject("Install the plugin before changing its enabled state.");
          return;
        }
        if (plugin.id === "discord" && params.enabled && !discordConsented) {
          if (params.acknowledgeCapabilities?.reviewToken !== inspection.reviewToken) {
            respond({
              __mockError: {
                code: "INVALID_REQUEST",
                message: 'Plugin "discord" requires capability consent',
                details: {
                  capabilityConsentCode: "PLUGIN_CAPABILITY_CONSENT_REQUIRED",
                  pluginId: plugin.id,
                  reviewToken: inspection.reviewToken,
                  widened: {
                    providers: inspection.declared.providers,
                    tools: inspection.declared.tools,
                    contracts: inspection.declared.contracts,
                  },
                },
              },
            });
            return;
          }
          discordConsented = true;
        }
        plugin.enabled = params.enabled;
        plugin.state = params.enabled ? "enabled" : "disabled";
      } else {
        if (!plugin.installed || !plugin.removable) {
          reject("This mock plugin cannot be removed.");
          return;
        }
        // Official entries remain discoverable; externally installed entries leave the catalog.
        if (plugin.install) {
          Object.assign(plugin, {
            installed: false,
            enabled: false,
            state: "not-installed",
            removable: false,
          });
        } else {
          plugins.delete(plugin.id);
        }
        respond({
          ok: true,
          pluginId: plugin.id,
          restartRequired: true,
          removed: ["config entry", "install record", "plugin directory"],
        });
        return;
      }
      respond({ ok: true, plugin, restartRequired: true });
    });
  }
}

export function pluginLifecycleMockInitScript(options: PluginCatalogMockOptions = {}): string {
  return `(() => { const __name = (target) => target; (${installPluginLifecycleMock.toString()})(${JSON.stringify(buildPluginCatalogMock(options))}, ${JSON.stringify(buildPluginInspectMock(options))}); })();`;
}
