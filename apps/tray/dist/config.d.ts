import { type PocodexRuntimeOptions, type PocodexSnapshot } from "pocodex";
export type TrayListenMode = "loopback" | "lan";
export interface TrayConfig {
    appPath: string;
    autoStart: true;
    listenMode: TrayListenMode;
    listenPort: 0;
    token: string;
}
export declare function getDefaultTrayConfig(): TrayConfig;
export declare function loadTrayConfig(configPath: string): Promise<TrayConfig>;
export declare function saveTrayConfig(configPath: string, config: TrayConfig): Promise<void>;
export declare function normalizeTrayConfig(value: unknown): TrayConfig;
export declare function buildRuntimeOptions(config: TrayConfig): PocodexRuntimeOptions;
export declare function enableLanAccess(config: TrayConfig): TrayConfig;
export declare function disableLanAccess(config: TrayConfig): TrayConfig;
export declare function shouldRestartForConfigChange(snapshot: PocodexSnapshot): boolean;
export declare function planLanAccessChange(config: TrayConfig, snapshot: PocodexSnapshot, enabled: boolean): {
    config: TrayConfig;
    restartRequired: boolean;
};
export declare function applySelectedCodexAppPath(config: TrayConfig, selectedPath: string | null): TrayConfig;
export declare function generateTrayToken(): string;
