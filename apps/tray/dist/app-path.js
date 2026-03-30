export async function chooseCodexAppPath(showOpenDialog) {
    const result = await showOpenDialog();
    const selectedPath = result.filePaths[0]?.trim();
    if (result.canceled || !selectedPath) {
        return null;
    }
    return selectedPath;
}
