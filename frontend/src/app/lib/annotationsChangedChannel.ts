export const ANNOTATIONS_CHANGED_CHANNEL = "docket-annotations-changed";

type AnnotationsChangedMessage = {
    docId: string;
};

function hasBroadcastChannel() {
    return typeof BroadcastChannel !== "undefined";
}

function isAnnotationsChangedMessage(
    value: unknown,
): value is AnnotationsChangedMessage {
    return (
        typeof value === "object" &&
        value !== null &&
        "docId" in value &&
        typeof value.docId === "string"
    );
}

export function publishAnnotationsChanged(docId: string) {
    if (!hasBroadcastChannel()) return;
    const channel = new BroadcastChannel(ANNOTATIONS_CHANGED_CHANNEL);
    channel.postMessage({ docId } satisfies AnnotationsChangedMessage);
    channel.close();
}

export function subscribeAnnotationsChanged(
    callback: (docId: string) => void,
): () => void {
    if (!hasBroadcastChannel()) return () => {};
    const channel = new BroadcastChannel(ANNOTATIONS_CHANGED_CHANNEL);
    channel.onmessage = (event: MessageEvent<unknown>) => {
        if (isAnnotationsChangedMessage(event.data)) {
            callback(event.data.docId);
        }
    };
    return () => channel.close();
}
