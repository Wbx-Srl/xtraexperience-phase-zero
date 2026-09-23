import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { verifyShopifyHmac } from "@/lib/hmac";
import { refundOrderVouchers } from "@/lib/refund";

/**
 * POST /api/webhooks/orders-cancelled
 * Riceve webhook orders/cancelled da Shopify: annulla tutti i voucher
 * dell'ordine e i relativi codici sconto.
 * Risponde 200 SUBITO, poi processa in background.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const rawBody = Buffer.from(await req.arrayBuffer());
  const hmacHeader = req.headers.get("x-shopify-hmac-sha256") ?? "";
  const shop = req.headers.get("x-shopify-shop-domain") ?? "";

  const secret = process.env.SHOPIFY_WEBHOOK_SECRET!;
  if (!verifyShopifyHmac(rawBody, hmacHeader, secret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const order = JSON.parse(rawBody.toString("utf-8")) as { id: string | number };

  waitUntil(
    refundOrderVouchers(shop, String(order.id), { type: "all" }, "orders-cancelled").catch(
      (err) => console.error("orders-cancelled processing error:", err)
    )
  );

  return NextResponse.json({ ok: true });
}
