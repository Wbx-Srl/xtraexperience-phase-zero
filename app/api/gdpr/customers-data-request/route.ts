import { NextRequest, NextResponse } from "next/server";
import { verifyShopifyHmac } from "@/lib/hmac";

/** POST /api/gdpr/customers-data-request */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const rawBody = Buffer.from(await req.arrayBuffer());
  const hmac = req.headers.get("x-shopify-hmac-sha256") ?? "";
  if (!verifyShopifyHmac(rawBody, hmac, process.env.SHOPIFY_WEBHOOK_SECRET!)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // Fase Zero: non archiviamo PII in DB — i dati sono su Vercel KV indicizzati per ordine/codice voucher.
  // Non esportiamo dati automaticamente: il team XtraWine gestisce manualmente le richieste.
  console.log("GDPR customers/data_request ricevuto:", JSON.parse(rawBody.toString()));
  return NextResponse.json({ ok: true });
}
