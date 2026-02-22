import { extractFromHtml, extractTextFromHtml } from "./extract.js";

export type DocumentExtractionMethod =
  | "readability"
  | "dom-text"
  | "pdf"
  | "docx"
  | "excel"
  | "text"
  | "none";

export type DocumentExtraction = {
  title?: string;
  excerpt?: string;
  text: string;
  method: DocumentExtractionMethod;
  ok: boolean;
  error?: string;
  isHtmlSource?: boolean;
};

function getContentType(input?: string | null): string {
  return (input ?? "").toLowerCase();
}

function getUrlPath(url: string): string {
  try {
    return new URL(url).pathname.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

function decodeAsUtf8(body: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(body);
}

function hasPdfMagicBytes(body: Uint8Array): boolean {
  return (
    body.length >= 5 &&
    body[0] === 0x25 && // %
    body[1] === 0x50 && // P
    body[2] === 0x44 && // D
    body[3] === 0x46 && // F
    body[4] === 0x2d // -
  );
}

function isTextLikelySource(args: { contentType: string; pathname: string }): boolean {
  const ct = args.contentType;
  if (ct.includes("text/html") || ct.includes("application/xhtml")) return false;
  return (
    ct.includes("text/") ||
    ct.includes("application/json") ||
    ct.includes("application/xml") ||
    ct.includes("application/javascript") ||
    ct.includes("application/xhtml") ||
    ct.includes("application/rtf") ||
    /\.(txt|csv|tsv|json|xml|rss|atom)$/i.test(args.pathname)
  );
}

function isPdfSource(args: { contentType: string; pathname: string; body: Uint8Array }): boolean {
  const ct = args.contentType;
  return ct.includes("application/pdf") || /\.(pdf)$/i.test(args.pathname) || hasPdfMagicBytes(args.body);
}

function isDocxSource(args: { contentType: string; pathname: string }): boolean {
  const ct = args.contentType;
  return (
    ct.includes("officedocument.wordprocessingml.document") ||
    ct.includes("application/vnd.openxmlformats-officedocument.wordprocessingml.document") ||
    ct.includes("application/msword") ||
    /\.(doc|docx)$/i.test(args.pathname)
  );
}

function isExcelSource(args: { contentType: string; pathname: string }): boolean {
  const ct = args.contentType;
  return (
    ct.includes("application/vnd.ms-excel") ||
    ct.includes("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") ||
    ct.includes("spreadsheetml") ||
    /\.(xls|xlsx)$/i.test(args.pathname)
  );
}

export async function extractDocumentText(args: {
  body: Uint8Array;
  url: string;
  contentType?: string | null;
}): Promise<DocumentExtraction> {
  const contentType = getContentType(args.contentType);
  const pathname = getUrlPath(args.url);

  const isPdf = isPdfSource({ contentType, pathname, body: args.body });
  const isDocx = isDocxSource({ contentType, pathname });
  const isExcel = isExcelSource({ contentType, pathname });
  const isTextSource = isTextLikelySource({ contentType, pathname });

  if (isPdf) {
    try {
      const buffer = Buffer.from(args.body);
      const pdfModule = await import("pdf-parse");
      const parsePdf = ((pdfModule as { default?: unknown }).default ?? pdfModule) as (
        data: Buffer | { data: Buffer; verbosity?: number }
      ) => Promise<{ text?: string }>;
      const parsed = await parsePdf({ data: buffer, verbosity: 0 });
      const text = parsed.text?.trim() ?? "";
      return {
        text,
        method: "pdf",
        ok: text.length > 0,
        ...(text.length > 0 ? {} : { error: "PDF parsed, but no text content was extracted." }),
      };
    } catch (error) {
      return {
        text: "",
        method: "pdf",
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  if (isDocx) {
    try {
      const buffer = Buffer.from(args.body);
      const mammothModule = await import("mammoth");
      const mammoth = (
        (mammothModule as { default?: { extractRawText: (input: { buffer: Buffer }) => Promise<{ value?: string }> } })
          .default ??
        (mammothModule as {
          extractRawText: (input: { buffer: Buffer }) => Promise<{ value?: string }>;
        })
      );
      const extractResult = await mammoth.extractRawText({ buffer });
      const text = extractResult.value?.trim() ?? "";
      return {
        text,
        method: "docx",
        ok: text.length > 0,
        ...(text.length > 0 ? {} : { error: "DOCX parsed, but no text content was extracted." }),
      };
    } catch (error) {
      return {
        text: "",
        method: "docx",
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  if (isExcel) {
    try {
      const bytes = Buffer.from(args.body);
      const xlsxModule = await import("xlsx");
      const xlsx = (xlsxModule as {
        read: (data: Buffer, options: { type: string }) => {
          SheetNames: string[];
          Sheets: Record<string, unknown>;
        };
        utils: {
          sheet_to_json: (
            sheet: unknown,
            options: { header: number; raw: boolean; defval: string }
          ) => string[][];
        };
      }).read
        ? (xlsxModule as {
            read: (data: Buffer, options: { type: string }) => {
              SheetNames: string[];
              Sheets: Record<string, unknown>;
            };
            utils: {
              sheet_to_json: (
                sheet: unknown,
                options: { header: number; raw: boolean; defval: string }
              ) => string[][];
            };
          })
        : (xlsxModule as never);

      const workbook = xlsx.read(bytes, { type: "buffer" });
      const lines: string[] = [];
      const separator = " | ";
      for (const sheetName of workbook.SheetNames) {
        const sheet = workbook.Sheets[sheetName];
        const rows = xlsx.utils.sheet_to_json(sheet, {
          header: 1,
          raw: false,
          defval: "",
        }) as string[][];
        lines.push(`## ${sheetName}`);
        for (const row of rows) {
          lines.push(row.join(separator));
        }
      }

      const text = lines.join("\n").trim();
      return {
        text,
        method: "excel",
        ok: text.length > 0,
        ...(text.length > 0 ? {} : { error: "Spreadsheet parsed, but no text content was extracted." }),
      };
    } catch (error) {
      return {
        text: "",
        method: "excel",
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  const decoded = decodeAsUtf8(args.body);
  if (isTextSource) {
    const text = decoded.trim();
    return {
      text,
      method: "text",
      ok: text.length > 0,
      ...(text.length > 0 ? {} : { error: "Text-like source did not contain extractable text." }),
    };
  }

  try {
    const readable = extractFromHtml(decoded, { url: args.url });
    return {
      text: readable.contentText,
      method: "readability",
      ok: readable.contentText.trim().length > 0,
      ...(readable.metadata.title ? { title: readable.metadata.title } : {}),
      isHtmlSource: true,
    };
  } catch (error) {
    const fallback = extractTextFromHtml(decoded);
    if (fallback.contentText.trim().length > 0) {
      return {
        text: fallback.contentText,
        method: "dom-text",
        ok: true,
        isHtmlSource: true,
      };
    }
    return {
      text: "",
      method: "none",
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
