import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { Request, Response } from "express";
import { clientDisconnectSignal } from "./clientDisconnect";

function responseEmitter(): EventEmitter & { writableEnded: boolean } {
    return Object.assign(new EventEmitter(), { writableEnded: false });
}

test("client disconnect signal aborts on an interrupted request body", () => {
    const req = new EventEmitter();
    const res = responseEmitter();
    const signal = clientDisconnectSignal(
        req as Request,
        res as unknown as Response,
    );

    req.emit("aborted");

    assert.equal(signal.aborted, true);
    assert.equal(signal.reason.name, "AbortError");
});

test("client disconnect signal only treats premature response close as abort", () => {
    const req = new EventEmitter();
    const res = responseEmitter();
    const signal = clientDisconnectSignal(
        req as Request,
        res as unknown as Response,
    );

    req.emit("close");
    assert.equal(signal.aborted, false);

    res.writableEnded = true;
    res.emit("close");
    assert.equal(signal.aborted, false);
});

test("client disconnect signal aborts when the response closes early", () => {
    const req = new EventEmitter();
    const res = responseEmitter();
    const signal = clientDisconnectSignal(
        req as Request,
        res as unknown as Response,
    );

    res.emit("close");

    assert.equal(signal.aborted, true);
    assert.equal(signal.reason.name, "AbortError");
});
