export function buildTrayMenuTemplate(config, snapshot, handlers) {
    const statusItems = [
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
    const actionItems = [
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
    }
    else if (snapshot.state === "stopped" || snapshot.state === "error") {
        actionItems.push({
            label: "Start Pocodex",
            click: handlers.startPocodex,
        });
    }
    else {
        actionItems.push(disabledItem("Starting Pocodex..."));
    }
    const configItems = [
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
    ];
    if (config.listenMode === "lan") {
        configItems.push({
            label: "Regenerate LAN Token",
            click: handlers.regenerateLanToken,
        });
    }
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
function disabledItem(label) {
    return {
        label,
        enabled: false,
    };
}
