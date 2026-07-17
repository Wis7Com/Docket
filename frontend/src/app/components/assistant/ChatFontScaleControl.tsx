interface Props {
    fontScale: number;
    onDecrease: () => void;
    onIncrease: () => void;
    canDecrease: boolean;
    canIncrease: boolean;
}

export function ChatFontScaleControl({
    fontScale,
    onDecrease,
    onIncrease,
    canDecrease,
    canIncrease,
}: Props) {
    return (
        <div className="flex items-center gap-px rounded-full border border-gray-200 bg-white/70 px-1 py-1 shadow-md backdrop-blur-md">
            <button
                type="button"
                aria-label="Decrease chat text size"
                onClick={onDecrease}
                disabled={!canDecrease}
                className="flex h-7 w-7 items-center justify-center rounded-full text-xs font-medium text-gray-600 transition-colors hover:bg-white disabled:opacity-30"
            >
                A-
            </button>
            <span className="w-9 select-none text-center text-xs font-medium tabular-nums text-gray-600">
                {Math.round(fontScale * 100)}%
            </span>
            <button
                type="button"
                aria-label="Increase chat text size"
                onClick={onIncrease}
                disabled={!canIncrease}
                className="flex h-7 w-7 items-center justify-center rounded-full text-xs font-medium text-gray-600 transition-colors hover:bg-white disabled:opacity-30"
            >
                A+
            </button>
        </div>
    );
}
