/**
 * Writing an exported PDF to a location the user picks.
 *
 * A plain `<a download>` drops the file into the OS download folder without
 * asking, which is the wrong default for an explicit export action. Prefer
 * the desktop save dialog (Electron `showSaveDialog` behind the preload
 * bridge), fall back to the browser File System Access picker, and only use
 * the silent anchor download when neither is available.
 */

export type SavePdfOutcome =
    | { status: "saved"; path?: string }
    | { status: "canceled" };

export type DesktopSaveBridge = {
    savePdfAs?: (payload: { suggestedName: string; data: Uint8Array }) => Promise<{
        ok: boolean;
        canceled?: boolean;
        path?: string;
        error?: string;
    }>;
};

type SaveFileHandle = {
    createWritable: () => Promise<{
        write: (data: Uint8Array) => Promise<void>;
        close: () => Promise<void>;
    }>;
};

export type SaveFilePicker = (options: {
    suggestedName?: string;
    types?: { description?: string; accept: Record<string, string[]> }[];
}) => Promise<SaveFileHandle>;

export type SavePdfDeps = {
    fetchBytes: (url: string) => Promise<Uint8Array>;
    downloadViaAnchor: (url: string, filename: string) => void;
    bridge?: DesktopSaveBridge;
    showSaveFilePicker?: SaveFilePicker;
};

function isPickerDismissal(err: unknown): boolean {
    return err instanceof Error && err.name === "AbortError";
}

export async function savePdfToChosenFolder(
    url: string,
    filename: string,
    deps: SavePdfDeps,
): Promise<SavePdfOutcome> {
    const saveViaBridge = deps.bridge?.savePdfAs;
    if (saveViaBridge) {
        const data = await deps.fetchBytes(url);
        const result = await saveViaBridge({ suggestedName: filename, data });
        if (result?.canceled) return { status: "canceled" };
        if (!result?.ok) {
            throw new Error(result?.error ?? "Failed to save the PDF.");
        }
        return { status: "saved", path: result.path };
    }

    if (deps.showSaveFilePicker) {
        let handle: SaveFileHandle;
        try {
            handle = await deps.showSaveFilePicker({
                suggestedName: filename,
                types: [
                    {
                        description: "PDF document",
                        accept: { "application/pdf": [".pdf"] },
                    },
                ],
            });
        } catch (err) {
            if (isPickerDismissal(err)) return { status: "canceled" };
            throw err;
        }
        const data = await deps.fetchBytes(url);
        const writable = await handle.createWritable();
        await writable.write(data);
        await writable.close();
        return { status: "saved" };
    }

    deps.downloadViaAnchor(url, filename);
    return { status: "saved" };
}

async function fetchPdfBytes(url: string): Promise<Uint8Array> {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(
            `Failed to download the exported PDF (${response.status}).`,
        );
    }
    return new Uint8Array(await response.arrayBuffer());
}

function downloadViaAnchor(url: string, filename: string): void {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
}

export function browserSavePdfDeps(): SavePdfDeps {
    const bridge =
        typeof window !== "undefined"
            ? (window.docket as DesktopSaveBridge | undefined)
            : undefined;
    const picker =
        typeof window !== "undefined"
            ? (window as unknown as { showSaveFilePicker?: SaveFilePicker })
                  .showSaveFilePicker
            : undefined;
    return {
        fetchBytes: fetchPdfBytes,
        downloadViaAnchor,
        bridge: bridge?.savePdfAs ? bridge : undefined,
        showSaveFilePicker: picker
            ? (options) => picker.call(window, options)
            : undefined,
    };
}
