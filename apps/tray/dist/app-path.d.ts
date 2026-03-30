export interface OpenDialogResult {
    canceled: boolean;
    filePaths: string[];
}
export declare function chooseCodexAppPath(showOpenDialog: () => Promise<OpenDialogResult>): Promise<string | null>;
