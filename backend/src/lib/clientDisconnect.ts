import type { Request, Response } from "express";

/**
 * Returns a signal that aborts when the request body is interrupted or the
 * response connection closes. IncomingMessage's `close` event also fires
 * after a normally completed request body, so it must not drive cancellation.
 */
export function clientDisconnectSignal(
    req: Request,
    res: Response,
): AbortSignal {
    const controller = new AbortController();
    const abort = () => {
        if (!controller.signal.aborted) {
            controller.abort(
                new DOMException("Client disconnected", "AbortError"),
            );
        }
    };

    req.once("aborted", abort);
    res.once("close", () => {
        if (!res.writableEnded) abort();
    });
    return controller.signal;
}
