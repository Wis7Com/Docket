import type {
    DocketCitationAnnotation,
    PdfAnnotationRect,
} from "./types";

export type QuoteEntry = {
    page?: number;
    quote: string;
    citation?: DocketCitationAnnotation;
};
export type AnnotationMode = "select" | "highlight" | "comment";
export type ResizeEdge = "left" | "right";
export type ActivePdfSelection = {
    text: string;
    rects: PdfAnnotationRect[];
    source?: "user" | "citation";
};
export type PdfContextMenu =
    | {
          kind: "selection";
          variant: "quick" | "context";
          x: number;
          y: number;
          text: string;
          rects: PdfAnnotationRect[];
          source?: "user" | "citation";
      }
    | {
          kind: "annotation";
          variant: "quick" | "context";
          x: number;
          y: number;
          annotationId: string;
      };
export type PdfCommentEditor =
    | {
          kind: "selection";
          x: number;
          y: number;
          text: string;
          rects: PdfAnnotationRect[];
          source?: "user" | "citation";
      }
    | {
          kind: "annotation";
          x: number;
          y: number;
          annotationId: string;
      };

export const SIDE_PADDING = 20;
export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 3.0;
export const ZOOM_STEP = 0.25;
export const ANNOTATION_COLORS = [
    "#ffe066",
    "#ffc078",
    "#ff8787",
    "#8ce99a",
    "#74c0fc",
    "#b197fc",
    "#f783ac",
];

export type RenderedPage = {
    page: import("pdfjs-dist").PDFPageProxy;
    viewport: import("pdfjs-dist").PageViewport;
    wrapper: HTMLDivElement;
    canvas: HTMLCanvasElement;
    textDivs: HTMLElement[];
};
