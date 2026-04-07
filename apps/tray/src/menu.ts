import type { MenuItemConstructorOptions } from "electron";

import type { PocodexSnapshot } from "pocodex";

import type { TrayConfig } from "./config.js";

export interface TrayMenuHandlers {
  chooseCodexApp: () => void;
  copyLanUrl: () => void;
  copyLocalUrl: () => void;
  openPocodex: () => void;
  quit: () => void;
  regenerateAccessToken: () => void;
  resetCodexAppPath: () => void;
  restartPocodex: () => void;
  revealConfigFile: () => void;
  setLanAccess: (enabled: boolean) => void;
  startPocodex: () => void;
  stopPocodex: () => void;
}

export function buildTrayMenuTemplate(
  config: TrayConfig,
  snapshot: PocodexSnapshot,
  handlers: TrayMenuHandlers,
): MenuItemConstructorOptions[] {
  const statusItems: MenuItemConstructorOptions[] = [
    disabledItem(`Status: ${snapshot.state}`),
    disabledItem(`Codex: ${snapshot.codexVersion ?? "unavailable"}`),
    disabledItem(`Local URL: ${snapshot.localUrl ?? "unavailable"}`),
  ];

  if (config.listenMode === "lan") {
    statusItems.push(disabledItem(`LAN URL: ${snapshot.networkUrl ?? "unavailable"}`));
  }
  if (snapshot.lastError) {
    statusItems.push(disabledItem(`Last error: ${snapshot.lastError}`));
  }

  const actionItems: MenuItemConstructorOptions[] = [
    {
      label: "Open Pocodex",
      enabled: Boolean(snapshot.localOpenUrl),
      click: handlers.openPocodex,
    },
    {
      label: "Copy Local URL",
      enabled: Boolean(snapshot.localUrl),
      click: handlers.copyLocalUrl,
    },
  ];

  if (config.listenMode === "lan") {
    actionItems.push({
      label: "Copy LAN URL",
      enabled: Boolean(snapshot.networkUrl),
      click: handlers.copyLanUrl,
    });
  }

  actionItems.push({
    label: "Restart Pocodex",
    enabled: snapshot.state !== "starting",
    click: handlers.restartPocodex,
  });

  if (snapshot.state === "running") {
    actionItems.push({
      label: "Stop Pocodex",
      click: handlers.stopPocodex,
    });
  } else if (snapshot.state === "stopped" || snapshot.state === "error") {
    actionItems.push({
      label: "Start Pocodex",
      click: handlers.startPocodex,
    });
  } else {
    actionItems.push(disabledItem("Starting Pocodex..."));
  }

  const configItems: MenuItemConstructorOptions[] = [
    {
      type: "checkbox",
      label: "Allow Local Network Access",
      checked: config.listenMode === "lan",
      click: (item) => {
        handlers.setLanAccess(item.checked);
      },
    },
    {
      label: "Choose Codex.app…",
      click: handlers.chooseCodexApp,
    },
    {
      label: "Reset Codex.app Path",
      click: handlers.resetCodexAppPath,
    },
    {
      label: "Regenerate Access Token",
      click: handlers.regenerateAccessToken,
    },
  ];

  return [
    ...statusItems,
    { type: "separator" },
    ...actionItems,
    { type: "separator" },
    ...configItems,
    { type: "separator" },
    {
      label: "Reveal Config File",
      click: handlers.revealConfigFile,
    },
    {
      label: "Quit",
      click: handlers.quit,
    },
  ];
}

function disabledItem(label: string): MenuItemConstructorOptions {
  return {
    label,
    enabled: false,
  };
}
