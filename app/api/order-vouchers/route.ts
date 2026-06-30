import { NextRequest, NextResponse } from "next/server";
import { kv } from "@vercel/kv";
import { verifyErpToken } from "@/lib/hmac";
import type { OrderVoucherSummary } from "@/lib/voucher";

/**
 * GET /api/order-vouchers?order_id={id}&token={ERP_SHARED_SECRET}
 * Endpoint riservato all'ERP — restituisce i voucher associati a un ordine.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const orderId = req.nextUrl.searchParams.get("order_id");
  const token = req.nextUrl.searchParams.get("token") ?? "";

  if (!orderId) {
    return NextResponse.json({ error: "order_id mancante" }, { status: 400 });
  }

  // Verifica token ERP con timing-safe compare
  const expected = process.env.ERP_SHARED_SECRET ?? "";
  if (!verifyErpToken(token, expected)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const vouchers = await kv.get<OrderVoucherSummary[]>(`order:${orderId}`);
  if (!vouchers) {
    return NextResponse.json({ error: "Ordine non trovato" }, { status: 404 });
  }

  return NextResponse.json(vouchers);
}
