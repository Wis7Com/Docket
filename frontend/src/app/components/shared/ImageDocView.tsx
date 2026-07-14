"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { RotateCcw, ZoomIn, ZoomOut } from "lucide-react";
import { ctrlZoomFactor, useCtrlZoom } from "@/lib/ctrlZoom";

export function ImageDocView({
  buffer,
  contentType,
  rounded = true,
  bordered = true,
}: {
  buffer: ArrayBuffer;
  contentType: string;
  rounded?: boolean;
  bordered?: boolean;
}) {
  const url = useMemo(
    () => URL.createObjectURL(new Blob([buffer], { type: contentType })),
    [buffer, contentType],
  );
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  useCtrlZoom(scrollRef, (detail) => {
    setZoom((value) =>
      Math.min(4, Math.max(0.25, value * ctrlZoomFactor(detail))),
    );
  });
  return (
    <div
      className={`relative flex flex-1 flex-col overflow-hidden bg-gray-100 ${bordered ? "border border-gray-200" : ""} ${rounded ? "rounded-xl" : ""}`}
    >
      <div className="flex h-10 items-center justify-center gap-1 border-b bg-white">
        <button
          type="button"
          aria-label="Zoom out"
          onClick={() => setZoom((v) => Math.max(0.25, v - 0.25))}
          className="rounded p-2 hover:bg-gray-100"
        >
          <ZoomOut size={16} />
        </button>
        <span className="w-14 text-center text-xs text-gray-600">
          {Math.round(zoom * 100)}%
        </span>
        <button
          type="button"
          aria-label="Zoom in"
          onClick={() => setZoom((v) => Math.min(4, v + 0.25))}
          className="rounded p-2 hover:bg-gray-100"
        >
          <ZoomIn size={16} />
        </button>
        <button
          type="button"
          aria-label="Rotate"
          onClick={() => setRotation((v) => (v + 90) % 360)}
          className="rounded p-2 hover:bg-gray-100"
        >
          <RotateCcw size={16} />
        </button>
      </div>
      <div
        ref={scrollRef}
        data-ctrl-zoom="doc"
        className="flex flex-1 items-start justify-center overflow-auto p-6"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={url}
          alt="Uploaded document"
          className="max-w-none shadow"
          style={{
            transform: `rotate(${rotation}deg)`,
            width: `${zoom * 100}%`,
            transformOrigin: "top center",
          }}
        />
      </div>
    </div>
  );
}
