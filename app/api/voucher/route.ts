import { NextRequest, NextResponse } from "next/server";
import { kv } from "@/lib/kv";
import type { VoucherRecord } from "@/lib/voucher";

const ALLOWED_ORIGINS = [
  "https://xtrawine.com",
  "https://www.xtrawine.com",
  "https://xtrawine.myshopify.com",
];

function corsHeaders(req: NextRequest): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

export async function OPTIONS(req: NextRequest): Promise<NextResponse> {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req) });
}

// Rate limiting semplicistico in-memory
const rateLimitMap = new Map<string, { count: number; reset: number }>();

function checkRateLimit(ip: string, maxPerMin = 20): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.reset) {
    rateLimitMap.set(ip, { count: 1, reset: now + 60_000 });
    return true;
  }
  if (entry.count >= maxPerMin) return false;
  entry.count++;
  return true;
}

/**
 * GET /api/voucher?code=XW-XXXX-XXXX
 * Lookup pubblico del voucher — usato dalla pagina /voucher e dai QR code.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";

  if (!checkRateLimit(ip)) {
    return NextResponse.json(
      { error: "Troppe richieste. Riprova tra un minuto." },
      { status: 429, headers: corsHeaders(req) }
    );
  }

  const code = req.nextUrl.searchParams.get("code")?.toUpperCase().trim();
  if (!code) {
    return NextResponse.json(
      { error: "Parametro code mancante" },
      { status: 400, headers: corsHeaders(req) }
    );
  }

  const voucher = await kv.get<VoucherRecord>(`voucher:${code}`);
  if (!voucher) {
    return NextResponse.json(
      { error: "Codice non trovato" },
      { status: 404, headers: corsHeaders(req) }
    );
  }

  // Risposta pubblica — no PII del cliente. cantina_email/cantina_phone sono
  // dati di contatto pubblici della cantina (non del cliente), esposti
  // apposta: il cliente deve poterli usare per prenotare la sua esperienza.
  return NextResponse.json({
    code: voucher.code,
    cantina_name: voucher.cantina_name,
    cantina_email: voucher.cantina_email ?? "",
    cantina_phone: voucher.cantina_phone ?? "",
    cantina_address: voucher.cantina_address ?? "",
    experience_name: voucher.experience_name,
    image_url: voucher.image_url ?? "",
    url_experience: voucher.url_experience,
    referrer: voucher.referrer ?? "",
    status: voucher.status,
    expires_at: voucher.expires_at,
  }, { headers: corsHeaders(req) });
}
