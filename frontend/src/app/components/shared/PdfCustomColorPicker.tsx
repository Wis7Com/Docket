"use client";

import { useState, type PointerEvent as ReactPointerEvent } from "react";
import {
    hexToHsv,
    hsvToHex,
    hsvToRgb,
    normalizeHexColor,
    rgbToHex,
    rgbToHsv,
    type Hsv,
} from "./hsvColor";

/** Rainbow wheel used as the "custom color" affordance next to preset swatches. */
export const COLOR_WHEEL_GRADIENT =
    "conic-gradient(#f03e3e, #f59f00, #ffd43b, #37b24d, #1c7ed6, #ae3ec9, #f03e3e)";

const HUE_GRADIENT =
    "linear-gradient(to right, #ff0000, #ffff00, #00ff00, #00ffff, #0000ff, #ff00ff, #ff0000)";

type Props = {
    /** Client-coordinate anchor the popover opens around. */
    x: number;
    y: number;
    initialColor: string;
    colors: readonly string[];
    initialSlotIndex: number;
    busy?: boolean;
    onCancel: () => void;
    onApply: (color: string, slotIndex: number) => void;
};

// macOS-style custom color dialog: preset swatches, a hue/saturation surface
// with a draggable marker, a brightness slider, and hex/RGB fields. Nothing
// is applied until OK, so dragging never spams annotation saves.
export function PdfCustomColorPicker({
    x,
    y,
    initialColor,
    colors,
    initialSlotIndex,
    busy,
    onCancel,
    onApply,
}: Props) {
    const [hsv, setHsv] = useState<Hsv>(
        () => hexToHsv(initialColor) ?? { h: 50, s: 0.6, v: 1 },
    );
    const [hexDraft, setHexDraft] = useState(
        () => normalizeHexColor(initialColor) ?? "#ffe066",
    );
    const [slotIndex, setSlotIndex] = useState(initialSlotIndex);
    const hex = hsvToHex(hsv);
    const rgb = hsvToRgb(hsv);

    const update = (next: Hsv) => {
        setHsv(next);
        setHexDraft(hsvToHex(next));
    };

    const pickFromArea = (event: ReactPointerEvent<HTMLDivElement>) => {
        const rect = event.currentTarget.getBoundingClientRect();
        const px = Math.min(Math.max(event.clientX - rect.left, 0), rect.width);
        const py = Math.min(Math.max(event.clientY - rect.top, 0), rect.height);
        update({
            h: rect.width === 0 ? 0 : (px / rect.width) * 360,
            s: rect.height === 0 ? 0 : 1 - py / rect.height,
            v: hsv.v,
        });
    };

    const pickFromSlider = (event: ReactPointerEvent<HTMLDivElement>) => {
        const rect = event.currentTarget.getBoundingClientRect();
        const py = Math.min(Math.max(event.clientY - rect.top, 0), rect.height);
        update({
            ...hsv,
            v: rect.height === 0 ? 1 : 1 - py / rect.height,
        });
    };

    const dragHandlers = (
        pick: (event: ReactPointerEvent<HTMLDivElement>) => void,
    ) => ({
        onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => {
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            pick(event);
        },
        onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => {
            if ((event.buttons & 1) === 1) pick(event);
        },
    });

    const setRgbChannel = (channel: "r" | "g" | "b", raw: string) => {
        if (!/^\d{0,3}$/.test(raw)) return;
        const next = {
            ...rgb,
            [channel]: raw === "" ? 0 : Math.min(255, parseInt(raw, 10)),
        };
        setHsv(rgbToHsv(next));
        setHexDraft(rgbToHex(next));
    };

    const clampedX = Math.min(Math.max(x, 190), window.innerWidth - 190);
    const openBelow = y < 420;
    const clampedY = openBelow
        ? Math.max(y, 16)
        : Math.min(y, window.innerHeight - 16);

    return (
        <div
            data-session-check="pdf-custom-color-picker"
            className="fixed z-[140] w-[368px] rounded-xl border border-gray-200 bg-white p-4 shadow-2xl"
            style={{
                left: clampedX,
                top: clampedY,
                transform: openBelow
                    ? "translate(-50%, 12px)"
                    : "translate(-50%, calc(-100% - 10px))",
            }}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
            }}
        >
            <div className="mb-2 text-sm font-semibold text-gray-800">
                Custom Color
            </div>

            {/* Preset swatches */}
            <div className="mb-3 flex items-center gap-1">
                {colors.map((color, index) => {
                    const selected = index === slotIndex;
                    const displayedColor = selected ? hex : color;
                    return (
                        <button
                            key={index}
                            type="button"
                            data-session-check="pdf-custom-palette-color"
                            data-palette-index={index}
                            data-color={displayedColor}
                            title={`Palette color ${index + 1}: ${displayedColor}`}
                            aria-label={`Edit palette color ${index + 1}`}
                            aria-pressed={selected}
                            onClick={() => {
                                setSlotIndex(index);
                                const parsed = hexToHsv(color);
                                if (parsed) update(parsed);
                            }}
                            className={`flex h-9 w-9 items-center justify-center rounded-lg transition-colors ${
                                selected ? "bg-gray-200" : "hover:bg-gray-100"
                            }`}
                        >
                            <span
                                className="h-6 w-6 rounded-full border border-gray-300"
                                style={{ backgroundColor: displayedColor }}
                            />
                        </button>
                    );
                })}
            </div>

            <div className="mb-2 text-sm font-semibold text-gray-800">
                Edit Palette Color {slotIndex + 1}
            </div>

            <div className="flex items-stretch gap-3">
                {/* Hue (x) / saturation (y) surface */}
                <div
                    role="slider"
                    aria-label="Pick hue and saturation"
                    aria-valuenow={Math.round(hsv.h)}
                    aria-valuetext={hex}
                    className="relative h-44 flex-1 cursor-crosshair touch-none rounded-md border border-gray-200"
                    style={{
                        background: `linear-gradient(to bottom, rgba(255,255,255,0), #ffffff), ${HUE_GRADIENT}`,
                    }}
                    {...dragHandlers(pickFromArea)}
                >
                    <span
                        className="pointer-events-none absolute h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.35)]"
                        style={{
                            left: `${(hsv.h / 360) * 100}%`,
                            top: `${(1 - hsv.s) * 100}%`,
                        }}
                    />
                </div>

                {/* Current color preview */}
                <div
                    aria-hidden
                    className="h-44 w-9 rounded-md border border-gray-200"
                    style={{ backgroundColor: hex }}
                />

                {/* Brightness slider */}
                <div
                    role="slider"
                    aria-label="Pick brightness"
                    aria-valuenow={Math.round(hsv.v * 100)}
                    className="relative h-44 w-5 cursor-ns-resize touch-none rounded-full border border-gray-200"
                    style={{
                        background: `linear-gradient(to bottom, ${hsvToHex({
                            ...hsv,
                            v: 1,
                        })}, #000000)`,
                    }}
                    {...dragHandlers(pickFromSlider)}
                >
                    <span
                        className="pointer-events-none absolute left-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-gray-400 bg-white shadow"
                        style={{ top: `${(1 - hsv.v) * 100}%` }}
                    />
                </div>

                {/* Hex + RGB fields */}
                <div className="flex w-[92px] flex-col gap-2">
                    <input
                        type="text"
                        value={hexDraft}
                        onChange={(e) => {
                            setHexDraft(e.target.value);
                            const parsed = hexToHsv(e.target.value);
                            if (parsed) setHsv(parsed);
                        }}
                        placeholder="#feffa0"
                        spellCheck={false}
                        aria-label="Hex color value"
                        className="block w-full rounded border border-gray-200 px-2 py-1 text-xs text-gray-800 outline-none focus:border-gray-400"
                    />
                    <div className="rounded border border-gray-200 bg-gray-50 px-2 py-1 text-xs font-medium text-gray-600">
                        RGB
                    </div>
                    {(["r", "g", "b"] as const).map((channel) => (
                        <div key={channel} className="flex items-center gap-1.5">
                            <input
                                type="text"
                                inputMode="numeric"
                                value={rgb[channel]}
                                onChange={(e) =>
                                    setRgbChannel(channel, e.target.value)
                                }
                                aria-label={`${channel.toUpperCase()} channel`}
                                className="block w-full rounded border border-gray-200 px-2 py-1 text-xs tabular-nums text-gray-800 outline-none focus:border-gray-400"
                            />
                            <span className="w-3 text-xs font-medium text-gray-500">
                                {channel.toUpperCase()}
                            </span>
                        </div>
                    ))}
                </div>
            </div>

            <div className="mt-3 flex items-center justify-end gap-1.5">
                <button
                    type="button"
                    className="rounded-md px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-100"
                    onClick={onCancel}
                >
                    Cancel
                </button>
                <button
                    type="button"
                    disabled={busy}
                    className="rounded-md bg-blue-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-40"
                    onClick={() => onApply(hex, slotIndex)}
                >
                    OK
                </button>
            </div>
        </div>
    );
}
