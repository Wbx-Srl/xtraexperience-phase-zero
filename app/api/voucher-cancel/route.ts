import { NextRequest, NextResponse } from "next/server";
import { kv } from "@/lib/kv";
import { verifyErpToken } from "@/lib/hmac";
import { refundOrderVouchers } from "@/lib/refund";
import type { VoucherRecord } from "@/lib/voucher";

/**
 * POST /api/voucher-cancel?token={ERP_SHARED_SECRET}
 * Body: { "code": "XW-XXXX-XXXX" }
 * Endpoint riservato all'ERP — annulla un singolo voucher dal seriale (rimborso
 * parziale di una riga, dove il webhook refunds/create non annulla nulla) e ne
 * elimina il codice sconto cross-selling. Idempotente: un voucher gia'
 * annullato risponde 200 con already_refunded.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const token = req.nextUrl.searchParams.get("token") ?? "";

  // Verifica token ERP con timing-safe compare
  const expected = process.env.ERP_SHARED_SECRET ?? "";
  if (!verifyErpToken(token, expected)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { code?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body JSON non valido" }, { status: 400 });
  }
  const code = typeof body.code === "string" ? body.code.trim().toUpperCase() : "";
  if (!code) {
    return NextResponse.json({ error: "code mancante" }, { status: 400 });
  }

  const voucher = await kv.get<VoucherRecord>(`voucher:${code}`);
  if (!voucher) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  if (voucher.status === "refunded") {
    return NextResponse.json({
      ok: true,
      code,
      order_id: voucher.order_id,
      status: "refunded",
      already_refunded: true,
      refunded_at: voucher.refunded_at,
    });
  }

  // L'ERP non manda lo shop e il record voucher non lo salva
  const shop = process.env.SHOPIFY_STORE_DOMAIN ?? "";
  if (!shop) {
    console.error("[erp-cancel] SHOPIFY_STORE_DOMAIN non configurata.");
    return NextResponse.json({ error: "Configurazione mancante" }, { status: 500 });
  }

  await refundOrderVouchers(shop, voucher.order_id, { type: "codes", codes: [code] }, "erp-cancel");

  const updated = await kv.get<VoucherRecord>(`voucher:${code}`);
  if (updated?.status !== "refunded") {
    console.error(`[erp-cancel] Voucher ${code} (ordine ${voucher.order_id}) non annullato.`);
    return NextResponse.json({ error: "Annullamento non riuscito" }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    code,
    order_id: voucher.order_id,
    status: "refunded",
    already_refunded: false,
    refunded_at: updated.refunded_at,
  });
}
