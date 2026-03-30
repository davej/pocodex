import type { MenuItemConstructorOptions } from "electron";
import type { PocodexSnapshot } from "pocodex";
import type { TrayConfig } from "./config.js";
export interface TrayMenuHandlers {
    chooseCodexApp: () => void;
    copyLanUrl: () => void;
    copyLocalUrl: () => void;
    openPocodex: () => void;
    quit: () => void;
    regenerateLanToken: () => void;
    resetCodexAppPath: () => void;
    restartPocodex: () => void;
    revealConfigFile: () => void;
    setLanAccess: (enabled: boolean) => void;
    startPocodex: () => void;
    stopPocodex: () => void;
}
export declare function buildTrayMenuTemplate(config: TrayConfig, snapshot: PocodexSnapshot, handlers: TrayMenuHandlers): MenuItemConstructorOptions[];
