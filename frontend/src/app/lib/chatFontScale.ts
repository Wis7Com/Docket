export const CHAT_FONT_SCALE_MIN = 0.8;
export const CHAT_FONT_SCALE_MAX = 1.6;
export const CHAT_FONT_SCALE_STEP = 0.1;

export const GLOBAL_CHAT_FONT_SCALE_KEY = "docket-chat-font-scale";
export const PROJECT_CHAT_FONT_SCALE_KEY = "docket-project-chat-font-scale";

export function clampChatFontScale(value: number) {
    return Math.min(
        CHAT_FONT_SCALE_MAX,
        Math.max(CHAT_FONT_SCALE_MIN, Math.round(value * 10) / 10),
    );
}

export function parseStoredChatFontScale(raw: string | null): number | null {
    const value = Number(raw);
    return Number.isFinite(value) && value > 0
        ? clampChatFontScale(value)
        : null;
}
