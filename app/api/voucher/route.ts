import { NextRequest, NextResponse } from "next/server";
import { kv } from "@vercel/kv";
import type { VoucherRecord } from "@/lib/voucher";

// Rate limiting semplicistico in-memory (per Vercel serverless, usa Vercel KV in produzione)
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
      { status: 429 }
    );
  }

  const code = req.nextUrl.searchParams.get("code")?.toUpperCase().trim();
  if (!code) {
    return NextResponse.json({ error: "Parametro code mancante" }, { status: 400 });
  }

  const voucher = await kv.get<VoucherRecord>(`voucher:${code}`);
  if (!voucher) {
    return NextResponse.json({ error: "Codice non trovato" }, { status: 404 });
  }

  // Risposta pubblica — no PII
  return NextResponse.json({
    code: voucher.code,
    cantina_name: voucher.cantina_name,
    experience_name: voucher.experience_name,
    url_experience: voucher.url_experience,
    status: voucher.status,
    expires_at: voucher.expires_at,
  });
}
