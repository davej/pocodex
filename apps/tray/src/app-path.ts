export interface OpenDialogResult {
  canceled: boolean;
  filePaths: string[];
}

export async function chooseCodexAppPath(
  showOpenDialog: () => Promise<OpenDialogResult>,
): Promise<string | null> {
  const result = await showOpenDialog();
  const selectedPath = result.filePaths[0]?.trim();
  if (result.canceled || !selectedPath) {
    return null;
  }
  return selectedPath;
}
